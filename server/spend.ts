// What each request costs (w859, asked by Lothsahn: "track the per workitem spend as well as the transcript so we can
// optimize token usage"). docs/spend.md is the long form; the short one:
//
// - Every turn's result line in a transcript carries Claude Code's own usage for it (sessions.ts turnUsage): the SDK's
//   cumulative per-model tokens and dollars, and the context meter's reading (shared/spend.ts). This store takes the
//   difference against the last totals it saw for that session, which is the turn's spend, and adds it to the request
//   the session was on when the turn began. Dollars and tokens are the SDK's; nothing here estimates them, except what
//   is labelled estimated (a session that had run before this existed, a daemon too old to send usage, the backfill).
// - Attribution (attribute): a worker's turn goes to the request named by an `[about wNNN]` line in the messages that
//   began it, else to the request it was last sent (the ledger's `links`, as they stood when the turn began, the same rule
//   as shared/workState.ts servedBy), else to `_unattributed`. A turn on a request shared by linked requests is split
//   evenly among them (the share is recorded as `shared`). An orchestrator's, the dispatcher's, the ops worker's turn goes
//   to the requests its starting messages name (wNNN in their first lines), split evenly, else to the bucket of its own
//   (`_dispatcher`, `_personal:<user>`, `_ops`). A standing agent's turns go to `_standing:<id>`; the workers its delegations
//   start are requests like any other.
// - The record outlives the ledger (which drops requests a week after they close) and the transcripts (the data guard,
//   server/dataGuard.ts, prunes them): everything the page and the report show comes from spend.json.
import path from 'node:path';
import { SnapshotFile, readJsonDurable, checkObject } from './durable.ts';
import type { SessionInfo, TranscriptEvent, WorkItem } from '../shared/types.ts';
import { WORK_OPEN } from '../shared/types.ts';
import type { How, ReportOptions, RequestSpend, SessionSpend, SpendReport, SpendRole } from '../shared/spend.ts';
export type { How, ReportOptions, RequestSpend, SessionSpend, SpendReport, SpendRole };
import { addCats, addModels, addTok, fmtTokens, fmtUsd, listUsd, priceOf, scaleTok, sumTok, zeroTok, CATEGORY_LABEL, CHARS_PER_TOKEN, OUTPUT_TOKENS_PER_CHAR, type Cats, type MeterTurn, type ModelTok, type Tok, type TurnUsage } from '../shared/spend.ts';

interface SpendFile {
  version: 1;
  requests: Record<string, RequestSpend>;
  sessions: Record<string, SessionSpend>;
  /** When the backfill from the transcripts that existed ran, and what it covered. */
  backfill?: { at: string; sessions: number; turns: number; usd: number };
}

/** What the store needs from the portal. */
export interface SpendContext {
  work: () => Iterable<WorkItem>;
  session: (id: string) => SessionInfo | undefined;
  /** How many result lines the session's transcript holds (this one included): 1 = a new session whose totals started at zero. */
  priorResults: (sessionId: string) => number;
  now?: () => number;
}

export const isBucket = (id: string) => id.startsWith('_');

/**
 * A backfilled turn's tokens from its dollars (an estimate, labelled so): the output is what the agent wrote, the cache
 * writes are what the next call wrote (its own output and what it read), at the 1-hour rate; what the dollars have left is cache
 * reads at the model's list price. When the characters cost more than the dollars, both are scaled down and nothing was read.
 */
export function estimateTurn(model: string, usd: number, outChars: number, freshChars: number): Tok {
  const p = priceOf(model);
  let out = outChars * OUTPUT_TOKENS_PER_CHAR;
  let cw = freshChars / CHARS_PER_TOKEN + out;
  const known = (out * p.out + cw * 2 * p.in) / 1e6;
  if (known > usd) {
    const f = usd / known;
    out *= f;
    cw *= f;
    return { in: 0, out, cr: 0, cw, usd };
  }
  const cr = ((usd - known) * 1e6) / p.cr;
  return { in: 0, out, cr, cw, usd };
}
const day = (iso: string) => iso.slice(0, 10);
const round = (n: number, d = 4) => Math.round(n * 10 ** d) / 10 ** d;
const roundTok = (t: Tok): Tok => ({ in: Math.round(t.in), out: Math.round(t.out), cr: Math.round(t.cr), cw: Math.round(t.cw), usd: round(t.usd) });
const roundModels = (m: ModelTok): ModelTok => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, roundTok(v)]));
const roundCats = (c: Cats): Cats => Object.fromEntries(Object.entries(c).map(([k, v]) => [k, { usd: round(v.usd, 5), tok: Math.round(v.tok) }]));

// ---------------------------------------------------------------------------------------------------------------------
// What kind of work a request is
// ---------------------------------------------------------------------------------------------------------------------

export const KINDS = ['bug fix', 'feature', 'release', 'review', 'investigation', 'ops', 'other'] as const;
export type WorkKind = (typeof KINDS)[number];

/** A request's kind, from its source, title and the start of its brief. Words, in this order: a release is never a bug fix because it mentions fixes. */
export function kindOfWork(w: Pick<WorkItem, 'title' | 'brief' | 'source'>): WorkKind {
  const s = w.source?.kind;
  if (s === 'release') return 'release';
  if (s === 'ffbox-branch') return 'review';
  if (s === 'ffbox-diagnosis' || s === 'discord-bug') return 'bug fix';
  if (s === 'nightly') return 'investigation';
  const title = w.title.toLowerCase();
  const text = `${title}\n${w.brief.slice(0, 400).toLowerCase()}`;
  if (/\b(release|ci-release|version bump|patch notes|steam upload|ship (a|the) build)\b/.test(title)) return 'release';
  if (/\b(review|code[- ]review|audit|codereview|merge (the|this) pr)\b/.test(title)) return 'review';
  if (/\b(deploy|restart|install|machine|daemon|clean-?up|disk|ops|sandbox|vm|tailscale|worker root|update the portal)\b/.test(title)) return 'ops';
  if (/\b(fix|bug|crash|desync|regression|broken|fails?|failing|error|stuck|hang|leak|wrong|not working|doesn'?t|can'?t|cannot)\b/.test(title)) return 'bug fix';
  if (/\b(investigate|investigation|why|diagnos|analy[sz]e|measure|research|report on|find out|check|look into|compare|survey|explore)\b/.test(title)) return 'investigation';
  if (/\b(add|implement|new|support|build|create|feature|make|let|show|track|allow|enable|port|migrate|rework|redesign|improve)\b/.test(title)) return 'feature';
  if (/\b(fix|bug|crash|desync|regression)\b/.test(text)) return 'bug fix';
  return 'other';
}

// ---------------------------------------------------------------------------------------------------------------------
// Attribution
// ---------------------------------------------------------------------------------------------------------------------

export interface Alloc {
  id: string;
  /** Even shares among the ids of one turn: 1 / n. */
  weight: number;
  how: How;
}

const ABOUT = /\[about\s+([^\]]*)\]/gi;
/** The ids at the start of each item of an [about] list: `w1 "title", w2 "title" (done)`. */
const ABOUT_ID = /(?:^|,\s*)(w\d+)(?=\s+")/gi;
const ID = /\bw\d{1,7}\b/gi;

/** The request ids named by `[about wNNN "title", wMMM "title"]` lines in the messages that began a turn. */
export function aboutIds(texts: readonly string[]): string[] {
  const out = new Set<string>();
  for (const t of texts) {
    for (const m of t.matchAll(ABOUT)) {
      // ids at the start of each item (a title may itself name another request); linear: no backtracking on an unclosed line
      for (const im of m[1].matchAll(ABOUT_ID)) out.add(im[1].toLowerCase());
    }
  }
  return [...out];
}

/** Request ids named in the first line(s) of each message: an orchestrator's trigger ("[work request] w859 …", "[worker update] …"). */
export function namedIdsIn(texts: readonly string[], max = 4): string[] {
  const out: string[] = [];
  for (const t of texts) {
    const head = t.split('\n').slice(0, 3).join('\n').slice(0, 400);
    for (const m of head.matchAll(ID)) {
      const id = m[0].toLowerCase();
      if (!out.includes(id)) out.push(id);
    }
  }
  return out.slice(0, max);
}

/**
 * The requests a worker's turn that began at `startMs` served: the one it was last sent (a start or a message with its
 * work_id) and those linked to it since (decide_work link), as the ledger's `links` stood then. A link written after the
 * turn began is another turn's. When the worker has no record at or before `startMs`, its first (the request it was started for).
 */
export function servedAt(sessionId: string, items: readonly WorkItem[], startMs: number): string[] {
  const mine = items
    .filter((w) => w.sessionIds.includes(sessionId))
    .map((w) => {
      const r = w.links?.[sessionId];
      return { id: w.id, at: r ? Date.parse(r.at) || 0 : Date.parse(w.createdAt) || 0, how: r?.how ?? ('sent' as const) };
    });
  if (!mine.length) return [];
  const upTo = mine.filter((x) => x.at <= startMs + 5000);
  const pool = upTo.length ? upTo : [mine.sort((a, b) => a.at - b.at)[0]];
  const lastSent = Math.max(-1, ...pool.filter((x) => x.how === 'sent').map((x) => x.at));
  const served = pool.filter((x) => (x.how === 'sent' ? x.at === lastSent : x.at >= lastSent));
  return (served.length ? served : pool.slice(-1)).map((x) => x.id);
}

/** Which request(s) or bucket a turn goes to. `info` is the session; `texts` the messages that began the turn (oldest first). */
export function attribute(info: Pick<SessionInfo, 'id' | 'kind' | 'orchestratorRole' | 'standingId' | 'requestedBy' | 'title'> | undefined, items: readonly WorkItem[], texts: readonly string[], startMs: number): Alloc[] {
  const exists = new Set(items.map((w) => w.id.toLowerCase()));
  const even = (ids: string[], how: How): Alloc[] => ids.map((id) => ({ id, weight: 1 / ids.length, how }));
  const kind = info?.kind;
  if (kind === 'standing') return [{ id: `_standing:${info?.standingId ?? 'unknown'}`, weight: 1, how: 'bucket' }];
  if (kind === 'orchestrator') {
    // The ids a message names must be requests (a "w3" in prose is not): only ones the ledger holds count.
    const ids = namedIdsIn(texts).filter((id) => exists.has(id));
    if (ids.length) return even(ids, 'message');
    return [{ id: info?.orchestratorRole === 'dispatcher' ? '_dispatcher' : `_personal:${info?.requestedBy?.userId ?? 'unknown'}`, weight: 1, how: 'bucket' }];
  }
  if ((kind as string) === 'ops') {
    const ids = namedIdsIn(texts).filter((id) => exists.has(id));
    return ids.length ? even(ids, 'message') : [{ id: '_ops', weight: 1, how: 'bucket' }];
  }
  // a worker
  const about = aboutIds(texts);
  if (about.length) return even(about, 'about');
  const served = info ? servedAt(info.id, items, startMs) : [];
  if (served.length) return even(served, 'link');
  // The ledger forgot the request (closed more than a week ago) or never linked it: the dispatcher titles a worker "wNNN: …".
  const titled = /^(w\d{1,7})\s*:/i.exec(info?.title ?? '')?.[1];
  if (titled) return even([titled.toLowerCase()], 'link');
  return [{ id: '_unattributed', weight: 1, how: 'bucket' }];
}

// ---------------------------------------------------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------------------------------------------------

const SAVE = { delayMs: 2000, intervalMs: 10_000, label: 'spend' };
const roleOf = (i: SessionInfo | undefined): SpendRole => (!i ? 'worker' : i.kind === 'orchestrator' ? (i.orchestratorRole === 'dispatcher' ? 'dispatcher' : 'personal') : i.kind);

export class SpendStore {
  readonly requests = new Map<string, RequestSpend>();
  readonly sessions = new Map<string, SessionSpend>();
  backfill?: SpendFile['backfill'];
  private readonly file: SnapshotFile;
  private readonly ctx: SpendContext;
  /** The messages that began each session's current turn, newest last: in memory only; a restart falls back to the links. */
  private readonly texts = new Map<string, { uuid?: string; text: string }[]>();
  private readonly now: () => number;

  constructor(dataDir: string, ctx: SpendContext) {
    this.ctx = ctx;
    this.now = ctx.now ?? Date.now;
    const file = path.join(dataDir, 'spend.json');
    this.file = new SnapshotFile(file, () => JSON.stringify(this.persisted()), SAVE);
    const f = readJsonDurable<SpendFile>(file, { check: checkObject });
    for (const r of Object.values(f?.requests ?? {})) this.requests.set(r.id, r);
    for (const s of Object.values(f?.sessions ?? {})) this.sessions.set(s.id, s);
    this.backfill = f?.backfill;
  }

  private persisted(): SpendFile {
    const requests: Record<string, RequestSpend> = {};
    for (const [id, r] of this.requests) {
      requests[id] = {
        ...r,
        total: roundTok(r.total),
        estimated: roundTok(r.estimated),
        models: roundModels(r.models),
        cats: roundCats(r.cats),
        days: Object.fromEntries(Object.entries(r.days).map(([d, t]) => [d, roundTok(t)])),
        sessions: Object.fromEntries(Object.entries(r.sessions).map(([k, v]) => [k, { ...v, total: roundTok(v.total), models: roundModels(v.models) }])),
      };
    }
    const sessions: Record<string, SessionSpend> = {};
    for (const [id, s] of this.sessions) sessions[id] = { ...s, total: roundTok(s.total), estimated: roundTok(s.estimated), models: roundModels(s.models), cats: roundCats(s.cats), requests: Object.fromEntries(Object.entries(s.requests).map(([k, v]) => [k, round(v)])) };
    return { version: 1, requests, sessions, ...(this.backfill ? { backfill: this.backfill } : {}) };
  }

  changed() {
    this.file.changed();
  }
  flush() {
    this.file.flushSync();
  }
  async saved() {
    await this.file.idle();
  }

  // ---- recording

  /** A transcript event was appended to a session: the user messages that begin a turn are kept, a result line is recorded. */
  observe(sessionId: string, e: TranscriptEvent) {
    if (e.kind === 'user') {
      const list = this.texts.get(sessionId) ?? [];
      list.push({ uuid: e.uuid, text: e.text.slice(0, 1500) });
      this.texts.set(sessionId, list.slice(-12));
    } else if (e.kind === 'result') {
      this.record(sessionId, e.t, e.usage, e.costUsd, e.durationMs, e.seq, e.answers);
    }
  }

  private sessionRec(id: string, info: SessionInfo | undefined, at: string): SessionSpend {
    let s = this.sessions.get(id);
    if (!s) {
      s = { id, role: roleOf(info), title: info?.title ?? id, machine: info?.machineId, person: info?.requestedBy?.displayName, firstAt: at, lastAt: at, turns: 0, total: zeroTok(), models: {}, estimated: zeroTok(), requests: {}, cats: {}, calls: 0, ctxMax: 0, compactions: 0, transcript: { state: 'full' } };
      this.sessions.set(id, s);
    }
    if (info) {
      s.title = info.title;
      s.role = roleOf(info);
      if (info.machineId) s.machine = info.machineId;
      if (info.requestedBy) s.person = info.requestedBy.displayName;
    }
    return s;
  }

  /** The turn's own spend: the difference of the SDK's cumulative totals, or an estimate when there is no baseline. */
  private delta(s: SessionSpend, id: string, u: TurnUsage | undefined, cost: number | undefined, info: SessionInfo | undefined): { models: ModelTok; estimated: boolean } {
    const cum = u?.cum && Object.keys(u.cum).length ? u.cum : undefined;
    const fallbackModel = info?.model ?? Object.keys(s.models)[0] ?? 'unknown';
    if (cum) {
      const prev = s.cum;
      s.cum = structuredClone(cum);
      if (cost !== undefined) s.lastCost = cost;
      if (!prev) {
        // The first result this store saw for the session. A session that had no result before it started from zero: exact.
        if (this.ctx.priorResults(id) <= 1) return { models: structuredClone(cum), estimated: false };
        // One that ran before: its earlier turns are in the totals. This turn alone is the main loop's own usage, priced at list.
        const m = u?.main;
        if (!m) return { models: {}, estimated: true };
        return { models: { [fallbackModel]: { in: m.in, out: m.out, cr: m.cr, cw: m.cw, usd: listUsd(fallbackModel, m) } }, estimated: true };
      }
      const out: ModelTok = {};
      for (const [model, c] of Object.entries(cum)) {
        const p = prev[model] ?? zeroTok();
        // totals that began again: the agent process says so (usage.restarted), else a drop to half or less (a /clear, an older daemon)
        const reset = u?.restarted === true || c.usd < p.usd * 0.5 || c.in < p.in * 0.5 || c.cr < p.cr * 0.5;
        const d = reset ? c : { in: Math.max(0, c.in - p.in), out: Math.max(0, c.out - p.out), cr: Math.max(0, c.cr - p.cr), cw: Math.max(0, c.cw - p.cw), usd: Math.max(0, c.usd - p.usd) };
        if (d.in || d.out || d.cr || d.cw || d.usd) out[model] = d;
      }
      return { models: out, estimated: false };
    }
    // Usage missing (a daemon older than w859): dollars from total_cost_usd, no tokens.
    if (cost === undefined) return { models: {}, estimated: true };
    const prev = s.lastCost;
    s.lastCost = cost;
    const usd = prev === undefined ? (this.ctx.priorResults(id) <= 1 ? cost : 0) : cost >= prev ? cost - prev : cost;
    return { models: usd > 0 ? { [fallbackModel]: { ...zeroTok(), usd } } : {}, estimated: true };
  }

  private record(sessionId: string, at: string, u: TurnUsage | undefined, cost: number | undefined, durationMs: number, seq: number, answers?: string[]) {
    const info = this.ctx.session(sessionId);
    const s = this.sessionRec(sessionId, info, at);
    s.liveFrom ??= seq;
    const { models, estimated } = this.delta(s, sessionId, u, cost, info);
    // The messages this result answers (its `answers` uuids): one that arrived mid-turn is the next turn's, not this one's.
    const all = this.texts.get(sessionId) ?? [];
    const mine = answers?.length ? all.filter((t) => t.uuid && answers.includes(t.uuid)) : [];
    const used = mine.length ? mine : all;
    const rest = mine.length ? all.filter((t) => !mine.includes(t)) : [];
    if (rest.length) this.texts.set(sessionId, rest);
    else this.texts.delete(sessionId);
    const texts = used.map((t) => t.text);
    const total = sumTok(Object.values(models));
    const startMs = (Date.parse(at) || this.now()) - durationMs;
    const items = [...this.ctx.work()];
    const allocs = attribute(info, items, texts, startMs);
    this.add({ s, at, models, total, estimated, meter: u?.meter, allocs, items, info });
    this.changed();
  }

  /** Add one turn's spend to its session and, by weight, to its requests. Also the backfill's entry. */
  add(a: { s: SessionSpend; at: string; models: ModelTok; total: Tok; estimated: boolean; meter?: MeterTurn; allocs: Alloc[]; items?: readonly WorkItem[]; info?: SessionInfo }) {
    const { s, at, models, total, allocs } = a;
    s.lastAt = at > s.lastAt ? at : s.lastAt;
    if (at < s.firstAt) s.firstAt = at;
    s.turns++;
    s.total = addTok(s.total, total);
    s.models = addModels(s.models, models);
    if (a.estimated) s.estimated = addTok(s.estimated, total);
    if (a.meter) {
      s.cats = addCats(s.cats, a.meter.cats);
      s.calls += a.meter.calls;
      s.ctxMax = Math.max(s.ctxMax, a.meter.ctxMax);
      if (a.meter.compacted) s.compactions++;
      if (a.meter.reread) s.reread = { n: (s.reread?.n ?? 0) + a.meter.reread.n, chars: (s.reread?.chars ?? 0) + a.meter.reread.chars, afterCompact: (s.reread?.afterCompact ?? 0) + a.meter.reread.afterCompact };
    }
    for (const al of allocs) {
      const f = al.weight;
      const r = this.requestRec(al.id, a.items, at);
      r.lastAt = at > r.lastAt ? at : r.lastAt;
      if (at < r.firstAt) r.firstAt = at;
      r.turns += f;
      r.total = addTok(r.total, scaleTok(total, f));
      r.models = addModels(r.models, models, f);
      if (a.estimated) r.estimated = addTok(r.estimated, scaleTok(total, f));
      const d = day(at);
      r.days[d] = addTok(r.days[d] ?? zeroTok(), scaleTok(total, f));
      const rs = (r.sessions[s.id] ??= { role: s.role, total: zeroTok(), models: {}, turns: 0, how: {} });
      rs.total = addTok(rs.total, scaleTok(total, f));
      rs.models = addModels(rs.models, models, f);
      rs.turns += f;
      rs.how[al.how] = (rs.how[al.how] ?? 0) + f;
      if (allocs.length > 1) rs.shared = (rs.shared ?? 0) + f;
      s.requests[al.id] = (s.requests[al.id] ?? 0) + total.usd * f;
      if (a.meter) {
        r.cats = addCats(r.cats, a.meter.cats, f);
        r.calls += a.meter.calls * f;
        if (a.meter.compacted) r.compactions += f;
        if (a.meter.reread) r.reread = { n: (r.reread?.n ?? 0) + a.meter.reread.n * f, chars: (r.reread?.chars ?? 0) + a.meter.reread.chars * f, afterCompact: (r.reread?.afterCompact ?? 0) + a.meter.reread.afterCompact * f };
      }
    }
  }

  private requestRec(id: string, items: readonly WorkItem[] | undefined, at: string): RequestSpend {
    let r = this.requests.get(id);
    if (!r) {
      const w = (items ?? [...this.ctx.work()]).find((x) => x.id.toLowerCase() === id);
      r = { id, title: w?.title ?? bucketTitle(id), kind: w ? kindOfWork(w) : isBucket(id) ? 'overhead' : 'other', firstAt: at, lastAt: at, turns: 0, total: zeroTok(), models: {}, estimated: zeroTok(), sessions: {}, cats: {}, calls: 0, compactions: 0, days: {} };
      this.requests.set(id, r);
    }
    return r;
  }

  /** The ledger moved on: titles, kinds, status and when each request closed. Called when someone looks, and every few minutes. */
  syncWork() {
    const byId = new Map<string, WorkItem>();
    for (const w of this.ctx.work()) byId.set(w.id.toLowerCase(), w);
    let changed = false;
    for (const r of this.requests.values()) {
      if (isBucket(r.id)) continue;
      const w = byId.get(r.id);
      if (!w) {
        // Dropped from the ledger a week after it closed: it was closed by then.
        if (!r.closedAt) {
          r.closedAt = r.lastAt;
          changed = true;
        }
        continue;
      }
      const open = (WORK_OPEN as readonly string[]).includes(w.status) || (w.status as string) === 'stalled';
      const person = w.requesters.map((x) => x.displayName).join(', ');
      if (r.title !== w.title || r.status !== w.status || r.person !== person) changed = true;
      r.title = w.title;
      r.status = w.status;
      r.person = person;
      r.kind = kindOfWork(w);
      if (open) {
        if (r.closedAt) {
          r.closedAt = undefined;
          changed = true;
        }
      } else if (!r.closedAt) {
        r.closedAt = w.updatedAt;
        changed = true;
      }
    }
    if (changed) this.changed();
  }

  // ---- backfill

  /**
   * Fill in a session whose turns ran before this store existed, from its transcript (w859). Dollars are the recorded per-turn
   * cost (the result lines' total_cost_usd, differenced), as the SDK reported it; the tokens and the model split are
   * ESTIMATES: the transcript does not hold them. A turn's output tokens are guessed from the characters the agent wrote, what
   * it wrote and read is what the next call wrote to the cache, and the rest of the dollars is cache reads at the model's list
   * price. Every backfilled number is in `estimated`. Only the events before the first one recorded live are used, so a turn
   * is never counted twice. Returns the turns and dollars added.
   */
  backfillSession(sessionId: string, events: readonly TranscriptEvent[], info: SessionInfo | undefined): { turns: number; usd: number } {
    const existing = this.sessions.get(sessionId);
    if (existing?.backfilled) return { turns: 0, usd: 0 };
    const limit = existing?.liveFrom ?? Infinity;
    const items = [...this.ctx.work()];
    const model = info?.model ?? 'unknown';
    let texts: string[] = [];
    let outChars = 0;
    let freshChars = 0;
    let prevCost: number | undefined;
    let turns = 0;
    let usd = 0;
    let s: SessionSpend | undefined = existing;
    for (const e of events) {
      if (e.seq >= limit) break;
      if (e.kind === 'user') {
        texts.push(e.text.slice(0, 1500));
        freshChars += e.text.length;
      } else if (e.kind === 'assistant' || e.kind === 'thinking') outChars += e.text.length;
      else if (e.kind === 'tool_use') outChars += Math.min(20_000, JSON.stringify(e.input ?? {}).length);
      else if (e.kind === 'tool_result') freshChars += e.text.length;
      else if (e.kind === 'result') {
        s ??= this.sessionRec(sessionId, info, e.t);
        let d = e.costUsd >= (prevCost ?? 0) ? e.costUsd - (prevCost ?? 0) : e.costUsd;
        prevCost = e.costUsd;
        // A resumed session's first result may carry the earlier spend: the session's own total bounds what is believable.
        if (info && info.costUsd > 0 && d > info.costUsd * 1.05) d = info.costUsd;
        const tok = d > 0 ? estimateTurn(model, d, outChars, freshChars) : zeroTok();
        const startMs = (Date.parse(e.t) || 0) - e.durationMs;
        const allocs = attribute(info, items, texts, startMs);
        if (d > 0) {
          this.add({ s, at: e.t, models: { [model]: tok }, total: tok, estimated: true, allocs, items, info });
          for (const al of allocs) {
            const r = this.requests.get(al.id);
            if (r) r.sessions[sessionId].how.backfill = (r.sessions[sessionId].how.backfill ?? 0) + al.weight;
          }
          usd += d;
        } else s.turns++;
        turns++;
        texts = [];
        outChars = 0;
        freshChars = 0;
      }
    }
    if (s) {
      s.backfilled = true;
      s.lastCost ??= prevCost;
      this.changed();
    }
    return { turns, usd };
  }

  // ---- reading

  request(id: string): RequestSpend | undefined {
    return this.requests.get(id.toLowerCase()) ?? this.requests.get(id);
  }
  session(id: string): SessionSpend | undefined {
    return this.sessions.get(id);
  }
  /** Every session that spent on a request, with its share, biggest first. */
  sessionsOf(requestId: string): { session: SessionSpend; share: RequestSpend['sessions'][string] }[] {
    const r = this.request(requestId);
    if (!r) return [];
    return Object.entries(r.sessions)
      .map(([sid, share]) => ({ session: this.sessions.get(sid) ?? ({ id: sid, role: share.role, title: sid, firstAt: r.firstAt, lastAt: r.lastAt, turns: 0, total: zeroTok(), models: {}, estimated: zeroTok(), requests: {}, cats: {}, calls: 0, ctxMax: 0, compactions: 0 } as SessionSpend), share }))
      .sort((a, b) => b.share.total.usd - a.share.total.usd);
  }
  /** Request ids a session served, biggest first. */
  requestsOf(sessionId: string): string[] {
    return Object.entries(this.sessions.get(sessionId)?.requests ?? {})
      .sort((a, b) => b[1] - a[1])
      .map(([id]) => id);
  }

  /**
   * The transcripts a request's spend needs to stay readable: the sessions that served it, and until when each is kept (ms). A
   * request that is not closed yet keeps its transcripts as long as it is open; a closed one `retainDays` after it closed.
   */
  protectedUntil(sessionId: string, retainDays: number): number | undefined {
    const s = this.sessions.get(sessionId);
    if (!s) return undefined;
    // Orchestrators' and the ops worker's conversations are the chats themselves: never pruned.
    if (s.role === 'dispatcher' || s.role === 'personal' || s.role === 'ops') return Infinity;
    let until = (Date.parse(s.lastAt) || 0) + retainDays * 86_400_000;
    for (const id of Object.keys(s.requests)) {
      const r = this.requests.get(id);
      if (!r || isBucket(id)) continue;
      if (!r.closedAt) return Infinity;
      until = Math.max(until, (Date.parse(r.closedAt) || 0) + retainDays * 86_400_000);
    }
    return until;
  }

  setTranscript(sessionId: string, t: SessionSpend['transcript']) {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    s.transcript = t;
    this.changed();
  }

  /** Requests with spend in the window (UTC days `sinceDay` to `untilDay`, inclusive), with that window's own dollars and tokens. */
  inWindow(sinceDay?: string, untilDay?: string, includeBuckets = false): { r: RequestSpend; window: Tok }[] {
    const out: { r: RequestSpend; window: Tok }[] = [];
    for (const r of this.requests.values()) {
      if (!includeBuckets && isBucket(r.id)) continue;
      let w = zeroTok();
      for (const [d, t] of Object.entries(r.days)) if ((!sinceDay || d >= sinceDay) && (!untilDay || d <= untilDay)) w = addTok(w, t);
      if (w.usd > 0 || w.in + w.out + w.cr + w.cw > 0) out.push({ r, window: w });
    }
    return out;
  }
}

function bucketTitle(id: string): string {
  if (id === '_dispatcher') return 'The dispatcher (turns that name no request)';
  if (id === '_ops') return 'The ops worker (jobs that name no request)';
  if (id === '_unattributed') return 'Worker turns tied to no request';
  if (id.startsWith('_personal:')) return `${id.slice(10)}'s orchestrator (turns that name no request)`;
  if (id.startsWith('_standing:')) return `Standing agent ${id.slice(10)}`;
  return id;
}

// ---------------------------------------------------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------------------------------------------------

const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function buildReport(spend: SpendStore, now: number, o: ReportOptions = {}): SpendReport {
  const days = Math.max(1, Math.min(120, o.days ?? 7));
  const sinceDay = utcDay(now - (days - 1) * 86_400_000);
  const untilDay = utcDay(now);
  const rows = spend.inWindow(sinceDay, untilDay, true);
  const reqs = rows.filter((x) => !isBucket(x.r.id));
  const total = sumTok(rows.map((x) => x.window));
  const estimated = sumTok(rows.map((x) => (x.r.total.usd > 0 ? scaleTok(x.r.estimated, x.window.usd / x.r.total.usd) : zeroTok())));
  let models: ModelTok = {};
  for (const x of rows) if (x.r.total.usd > 0) models = addModels(models, x.r.models, x.window.usd / x.r.total.usd);
  const catShare = (r: RequestSpend, usd: number) => {
    const sum = Object.values(r.cats).reduce((a, c) => a + c.usd, 0);
    return sum > 0 ? Object.entries(r.cats).map(([cat, c]) => ({ cat, usd: (c.usd / sum) * usd, pct: c.usd / sum })) : [];
  };
  const top = reqs
    .sort((a, b) => b.window.usd - a.window.usd)
    .slice(0, o.top ?? 10)
    .map(({ r, window }) => ({
      id: r.id,
      title: r.title,
      kind: r.kind,
      status: r.status,
      person: r.person,
      usd: window.usd,
      tokens: window,
      estimatedUsd: r.total.usd > 0 ? (r.estimated.usd * window.usd) / r.total.usd : 0,
      sessions: Object.keys(r.sessions).length,
      closed: !!r.closedAt,
      cats: catShare(r, window.usd)
        .sort((a, b) => b.usd - a.usd)
        .slice(0, 6),
    }));
  const kindMap = new Map<string, { usd: number; n: number }>();
  for (const x of reqs) {
    const k = kindMap.get(x.r.kind) ?? { usd: 0, n: 0 };
    k.usd += x.window.usd;
    k.n++;
    kindMap.set(x.r.kind, k);
  }
  const kinds = [...kindMap].map(([kind, v]) => ({ kind, usd: v.usd, requests: v.n, avg: v.n ? v.usd / v.n : 0 })).sort((a, b) => b.usd - a.usd);
  const catUsd = new Map<string, number>();
  let measured = 0;
  let reread: SpendReport['reread'];
  for (const x of reqs) {
    const sh = catShare(x.r, x.window.usd);
    if (!sh.length) continue;
    measured += x.window.usd;
    for (const c of sh) catUsd.set(c.cat, (catUsd.get(c.cat) ?? 0) + c.usd);
    if (x.r.reread) {
      const f = x.r.total.usd > 0 ? x.window.usd / x.r.total.usd : 0;
      reread = { n: (reread?.n ?? 0) + x.r.reread.n * f, chars: (reread?.chars ?? 0) + x.r.reread.chars * f, afterCompact: (reread?.afterCompact ?? 0) + x.r.reread.afterCompact * f };
    }
  }
  const where = [...catUsd].map(([cat, usd]) => ({ cat, label: CATEGORY_LABEL[cat] ?? cat, usd, pct: measured > 0 ? usd / measured : 0 })).sort((a, b) => b.usd - a.usd);
  const buckets = rows.filter((x) => isBucket(x.r.id)).map((x) => ({ id: x.r.id, title: x.r.title, usd: x.window.usd })).sort((a, b) => b.usd - a.usd);
  return { sinceDay, untilDay, total, estimated, models, top, kinds, where, buckets, measuredCats: measured, ...(reread ? { reread } : {}) };
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
export function tokLine(t: Tok): string {
  return `${fmtUsd(t.usd)} (in ${fmtTokens(t.in)}, out ${fmtTokens(t.out)}, cache read ${fmtTokens(t.cr)}, cache write ${fmtTokens(t.cw)})`;
}

/** The report as text for the orchestrators' spend_report tool. */
export function renderReport(r: SpendReport): string {
  const lines: string[] = [];
  lines.push(`Spend ${r.sinceDay} to ${r.untilDay} (UTC days): ${tokLine(r.total)}.${r.estimated.usd > 0.005 ? ` Of that ${fmtUsd(r.estimated.usd)} is estimated (sessions that ran before the tracking, daemons that did not send usage, backfilled transcripts); the rest is Claude Code's own per-turn usage.` : ' All of it is Claude Code\'s own per-turn usage.'}`);
  const m = Object.entries(r.models).sort((a, b) => b[1].usd - a[1].usd);
  if (m.length) lines.push(`By model: ${m.map(([k, v]) => `${k} ${fmtUsd(v.usd)} (${pct(r.total.usd ? v.usd / r.total.usd : 0)}; in ${fmtTokens(v.in)}, out ${fmtTokens(v.out)}, read ${fmtTokens(v.cr)}, write ${fmtTokens(v.cw)})`).join('; ')}.`);
  if (r.buckets.length) lines.push(`Not any request's: ${r.buckets.map((b) => `${b.title} ${fmtUsd(b.usd)}`).join('; ')}.`);
  lines.push('', `Top ${r.top.length} requests by cost:`);
  for (const [i, t] of r.top.entries()) {
    lines.push(`${i + 1}. ${t.id} ${fmtUsd(t.usd)} [${t.kind}${t.closed ? ', closed' : t.status ? `, ${t.status}` : ''}] "${t.title.slice(0, 90)}"${t.person ? ` for ${t.person}` : ''}: ${t.sessions} session(s); in ${fmtTokens(t.tokens.in)}, out ${fmtTokens(t.tokens.out)}, read ${fmtTokens(t.tokens.cr)}, write ${fmtTokens(t.tokens.cw)}${t.estimatedUsd > 0.005 ? `; ${fmtUsd(t.estimatedUsd)} estimated` : ''}${t.cats.length ? `. Where it went: ${t.cats.map((c) => `${c.cat} ${pct(c.pct)}`).join(', ')}` : ''}`);
  }
  lines.push('', 'By kind of work (requests with spend in the window):');
  for (const k of r.kinds) lines.push(`- ${k.kind}: ${fmtUsd(k.usd)} over ${k.requests} request(s), ${fmtUsd(k.avg)} each`);
  if (r.where.length) {
    lines.push('', `Where the money goes inside sessions (${fmtUsd(r.measuredCats)} of the window's requests have a context reading; each call's real tokens shared among what the context held, by characters — an estimate of the split, exact in total):`);
    for (const c of r.where.slice(0, 12)) lines.push(`- ${c.cat}: ${fmtUsd(c.usd)} (${pct(c.pct)}) — ${c.label}`);
    if (r.reread) lines.push(`Re-reads: ${Math.round(r.reread.n)} reads of a range already read in the same session, ${fmtTokens(r.reread.chars / 3.5)} tokens of results${r.reread.afterCompact ? `, ${Math.round(r.reread.afterCompact)} of them after a compaction` : ''}.`);
  } else lines.push('', 'No context readings yet in this window: they come from agents that run the w859 code (a machine daemon updated after it).');
  return lines.join('\n');
}

/** The "cost so far" tail of list_work's line for a request: "$12.34 (3 sessions, 4.1M read, 210k out)". */
export function costLine(spend: SpendStore | undefined, id: string): string {
  const r = spend?.request(id);
  if (!r || r.total.usd <= 0) return '';
  const est = r.estimated.usd > 0.005 ? `, ${fmtUsd(r.estimated.usd)} estimated` : '';
  return ` Cost so far: ${fmtUsd(r.total.usd)} (${Object.keys(r.sessions).length} session(s); in ${fmtTokens(r.total.in)}, out ${fmtTokens(r.total.out)}, read ${fmtTokens(r.total.cr)}, write ${fmtTokens(r.total.cw)}${est}).`;
}

/** One request's spend in full: models, sessions with their transcripts, categories. `link(sessionId)` gives a session's transcript URL. */
export function renderRequest(spend: SpendStore, id: string, link: (sessionId: string) => string, retainDays: number): string {
  const r = spend.request(id);
  if (!r) return `No spend recorded for ${id} (spend is recorded from the turns after the w859 deploy and backfilled from older transcripts).`;
  const lines: string[] = [];
  lines.push(`${r.id} "${r.title}" [${r.kind}${r.closedAt ? `, closed ${r.closedAt.slice(0, 10)}` : r.status ? `, ${r.status}` : ''}]: ${tokLine(r.total)}, ${Math.round(r.turns)} turn(s), ${r.firstAt.slice(0, 16).replace('T', ' ')} to ${r.lastAt.slice(0, 16).replace('T', ' ')}.${r.estimated.usd > 0.005 ? ` ${fmtUsd(r.estimated.usd)} of it is estimated.` : ''}`);
  const m = Object.entries(r.models).sort((a, b) => b[1].usd - a[1].usd);
  if (m.length) {
    lines.push('Per model:');
    for (const [k, v] of m) lines.push(`- ${k}: ${tokLine(v)}`);
  }
  lines.push('Sessions (a session that served several requests shows only this request\'s share):');
  for (const { session: s, share } of spend.sessionsOf(id)) {
    const how = Object.entries(share.how).map(([h, n]) => `${h} ${Math.round(n)}`).join(', ');
    const until = spend.protectedUntil(s.id, retainDays);
    const t = s.transcript;
    const kept = t?.state === 'pruned' ? `transcript pruned ${t.prunedAt?.slice(0, 10) ?? ''}` : `transcript ${t?.state === 'gz' ? 'compressed' : 'kept'}${until && Number.isFinite(until) ? ` until ${new Date(until).toISOString().slice(0, 10)}` : until === Infinity ? ' while the request is open' : ''}`;
    lines.push(`- ${s.id} ${s.role} "${s.title}"${s.machine ? ` on ${s.machine}` : ''}: ${tokLine(share.total)}, ${Math.round(share.turns)} turn(s) [${how}${share.shared ? `; ${Math.round(share.shared)} shared with other requests` : ''}]; ${kept}; ${link(s.id)}`);
  }
  const sum = Object.values(r.cats).reduce((a, c) => a + c.usd, 0);
  if (sum > 0) {
    lines.push(`Where the money went (a context reading of ${Math.round(r.calls)} model calls; shares by characters, exact in total):`);
    for (const [cat, c] of Object.entries(r.cats).sort((a, b) => b[1].usd - a[1].usd).slice(0, 8)) lines.push(`- ${cat}: ${pct(c.usd / sum)} (${fmtUsd((c.usd / sum) * r.total.usd)}) ${CATEGORY_LABEL[cat] ?? ''}`);
    if (r.reread) lines.push(`Re-reads: ${Math.round(r.reread.n)}${r.reread.afterCompact ? `, ${Math.round(r.reread.afterCompact)} after a compaction` : ''}.`);
  }
  return lines.join('\n');
}


/** One session's spend, models, context readings and the requests it served. */
export function renderSession(spend: SpendStore, id: string, link: (sessionId: string) => string): string {
  const s = spend.session(id);
  if (!s) return `No spend recorded for session ${id}.`;
  const lines = [`${s.id} ${s.role} "${s.title}"${s.machine ? ` on ${s.machine}` : ''}${s.person ? ` for ${s.person}` : ''}: ${tokLine(s.total)}, ${s.turns} turn(s), ${s.firstAt.slice(0, 16).replace('T', ' ')} to ${s.lastAt.slice(0, 16).replace('T', ' ')}.${s.estimated.usd > 0.005 ? ` ${fmtUsd(s.estimated.usd)} of it is estimated.` : ''} Transcript: ${s.transcript?.state === 'pruned' ? `pruned ${s.transcript.prunedAt?.slice(0, 10) ?? ''}` : s.transcript?.state === 'gz' ? 'compressed' : 'kept'}; ${link(s.id)}`];
  for (const [k, v] of Object.entries(s.models).sort((a, b) => b[1].usd - a[1].usd)) lines.push(`- ${k}: ${tokLine(v)}`);
  const reqs = Object.entries(s.requests).sort((a, b) => b[1] - a[1]);
  if (reqs.length) lines.push(`Requests it served: ${reqs.map(([r, usd]) => `${r} ${fmtUsd(usd)}`).join(', ')}.`);
  const sum = Object.values(s.cats).reduce((a, c) => a + c.usd, 0);
  if (sum > 0) {
    lines.push(`Context readings (${s.calls} model calls, largest context ${fmtTokens(s.ctxMax)} tokens, ${s.compactions} compaction(s)); where the money went:`);
    for (const [cat, c] of Object.entries(s.cats).sort((a, b) => b[1].usd - a[1].usd).slice(0, 10)) lines.push(`- ${cat}: ${pct(c.usd / sum)} (${fmtUsd((c.usd / sum) * s.total.usd)})`);
    if (s.reread) lines.push(`Re-reads: ${s.reread.n} (${s.reread.afterCompact} after a compaction), ${fmtTokens(s.reread.chars / 3.5)} tokens of results.`);
  }
  return lines.join('\n');
}
