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
import fs from 'node:fs';
import path from 'node:path';
import { SnapshotFile, readJsonDurable, checkObject } from './durable.ts';
import { SESSION_REQUESTS_TOP } from './toolOutput.ts';
import type { SessionInfo, TranscriptEvent, WorkItem } from '../shared/types.ts';
import { WORK_OPEN } from '../shared/types.ts';
import { UNRECORDED_ACCOUNT, coordKey, coordLabel, isCoordinatorRole, COORDINATION_NOTE, type Coordination, type How, type ReportOptions, type RequestSpend, type SessionSpend, type SpendReport, type SpendRole } from '../shared/spend.ts';
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
  /** A label for a session's account when the process left none (ranAs): a host session's account key. */
  accountLabel?: (info: SessionInfo) => string | undefined;
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
/** When the portal began recording by the rules of w1160 and w1161 (the a9d5eae restart, 2026-10-13 01:52:30 -06:00, from the journal's first spend backfill line 90 s later). Turns before it were recorded by the old ones. */
export const RULES_FROM_MS = Date.parse('2026-10-13T07:52:30Z');
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
export function kindOfWork(w: Pick<WorkItem, 'title' | 'brief' | 'source' | 'delegation'>): WorkKind {
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

/**
 * Harness notices that cite a request as a reference, not as their subject (w1161: "[machines] … agents run on through an update
 * (w605)" and "[app restarted] … (… w605)" reach the dispatcher on every restart and billed its turns to w605). An id inside
 * parentheses in one of these is not what the turn is about.
 */
const NOTICE = /^\s*\[(machines|app restarted|restart|host|heartbeat|data restored|machine updates)\]/i;
const withoutParens = (s: string): string => {
  let out = s;
  for (let prev = ''; prev !== out; ) {
    prev = out;
    out = out.replace(/\([^()]*\)/g, ' ');
  }
  return out.replace(/\([^()]*$/, ' ');
};

/** Request ids named in the first line(s) of each message: an orchestrator's trigger ("[work request] w859 …", "[worker update] …"). */
export function namedIdsIn(texts: readonly string[], max = 4, legacy = false): string[] {
  const out: string[] = [];
  for (const t of texts) {
    let head = t.split('\n').slice(0, 3).join('\n').slice(0, 400);
    if (!legacy && NOTICE.test(head)) head = withoutParens(head);
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

const CLOSED = new Set<string>(['merged', 'done', 'rejected', 'cancelled']);
/**
 * Of the requests a worker serves, those not closed before the turn began, unless all are (w1209): a worker that keeps its
 * closed request linked (the ledger never unlinks) spent the turn on the one still open, not half on the closed one. A request reopened is open again.
 */
export function openFirst(ids: readonly string[], items: readonly WorkItem[], startMs: number): string[] {
  if (ids.length < 2) return [...ids];
  const byId = new Map(items.map((w) => [w.id.toLowerCase(), w]));
  const live = ids.filter((id) => {
    const w = byId.get(id.toLowerCase());
    return !(w && CLOSED.has(w.status) && (Date.parse(w.updatedAt) || 0) <= startMs);
  });
  return live.length ? live : [...ids];
}

/** What a session's record says about its kind, for a turn whose session the store no longer holds (a coordinator must never fall to the worker rules). */
function infoOfRecord(s: SessionSpend): Pick<SessionInfo, 'id' | 'kind' | 'orchestratorRole' | 'standingId' | 'requestedBy' | 'title'> | undefined {
  if (s.role === 'worker') return undefined;
  const kind = s.role === 'ops' ? 'ops' : s.role === 'standing' ? 'standing' : 'orchestrator';
  return { id: s.id, kind, title: s.title, ...(kind === 'orchestrator' ? { orchestratorRole: s.role === 'dispatcher' ? ('dispatcher' as const) : ('personal' as const) } : {}), ...(s.person ? { requestedBy: { userId: s.person, displayName: s.person } } : {}) };
}

/** Which request(s) or bucket a turn goes to. `info` is the session; `texts` the messages that began the turn (oldest first). */
export function attribute(info: Pick<SessionInfo, 'id' | 'kind' | 'orchestratorRole' | 'standingId' | 'requestedBy' | 'title'> | undefined, items: readonly WorkItem[], texts: readonly string[], startMs: number, known?: ReadonlySet<string>, legacy = false, closedAware = true): Alloc[] {
  const exists = new Set(items.map((w) => w.id.toLowerCase()));
  // `known`: ids the spend record holds too (the replay of an old turn names a request the ledger has since dropped)
  if (known) for (const id of known) if (!id.startsWith('_')) exists.add(id);
  const even = (ids: string[], how: How): Alloc[] => ids.map((id) => ({ id, weight: 1 / ids.length, how }));
  const kind = info?.kind;
  if (kind === 'standing') return [{ id: `_standing:${info?.standingId ?? 'unknown'}`, weight: 1, how: 'bucket' }];
  if (kind === 'orchestrator') {
    // The ids a message names must be requests (a "w3" in prose is not): only ones the ledger holds count.
    const ids = namedIdsIn(texts, 4, legacy).filter((id) => exists.has(id));
    if (ids.length) return even(ids, 'message');
    return [{ id: info?.orchestratorRole === 'dispatcher' ? '_dispatcher' : `_personal:${info?.requestedBy?.userId ?? 'unknown'}`, weight: 1, how: 'bucket' }];
  }
  if (kind === 'ops') {
    const ids = namedIdsIn(texts, 4, legacy).filter((id) => exists.has(id));
    return ids.length ? even(ids, 'message') : [{ id: '_ops', weight: 1, how: 'bucket' }];
  }
  // a worker
  const about = aboutIds(texts);
  if (about.length) return even(about, 'about');
  const served = info ? (closedAware ? openFirst(servedAt(info.id, items, startMs), items, startMs) : servedAt(info.id, items, startMs)) : [];
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
  private readonly path: string;
  private readonly ctx: SpendContext;
  /** The messages that began each session's current turn, newest last: in memory only; a restart falls back to the links. */
  private readonly texts = new Map<string, { uuid?: string; text: string }[]>();
  private readonly now: () => number;

  constructor(dataDir: string, ctx: SpendContext) {
    this.ctx = ctx;
    this.now = ctx.now ?? Date.now;
    const file = path.join(dataDir, 'spend.json');
    this.path = file;
    this.file = new SnapshotFile(file, () => JSON.stringify(this.persisted()), SAVE);
    const f = readJsonDurable<SpendFile>(file, { check: checkObject });
    for (const r of Object.values(f?.requests ?? {})) this.requests.set(r.id, r);
    for (const s of Object.values(f?.sessions ?? {})) this.sessions.set(s.id, s);
    this.backfill = f?.backfill;
    // w1160: coordination days are keyed by the coordinator's session; the first version keyed them by "dispatcher" and the like,
    // on days that were wrong. Those go, and every coordinator without coordV 2 is rebuilt from its transcript (rebuildCoordination).
    for (const r of this.requests.values()) {
      if (!r.coordDays) continue;
      for (const k of Object.keys(r.coordDays)) if (!this.sessions.has(k)) delete r.coordDays[k];
    }
  }

  private persisted(): SpendFile {
    const requests: Record<string, RequestSpend> = {};
    for (const [id, r] of this.requests) {
      requests[id] = {
        ...r,
        total: roundTok(r.total),
        estimated: roundTok(r.estimated),
        models: roundModels(r.models),
        ...(r.accounts ? { accounts: roundModels(r.accounts) } : {}),
        ...(r.coordDays ? { coordDays: Object.fromEntries(Object.entries(r.coordDays).map(([k, d]) => [k, Object.fromEntries(Object.entries(d).map(([day, t]) => [day, roundTok(t)]))])) } : {}),
        cats: roundCats(r.cats),
        days: Object.fromEntries(Object.entries(r.days).map(([d, t]) => [d, roundTok(t)])),
        sessions: Object.fromEntries(Object.entries(r.sessions).map(([k, v]) => [k, { ...v, total: roundTok(v.total), models: roundModels(v.models) }])),
      };
    }
    const sessions: Record<string, SessionSpend> = {};
    for (const [id, s] of this.sessions) sessions[id] = { ...s, total: roundTok(s.total), estimated: roundTok(s.estimated), models: roundModels(s.models), ...(s.accounts ? { accounts: roundModels(s.accounts) } : {}), cats: roundCats(s.cats), requests: Object.fromEntries(Object.entries(s.requests).map(([k, v]) => [k, round(v)])) };
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
      // a coordinator first seen by this code records its days live: nothing to split afterwards (w1160)
      if (isCoordinatorRole(s.role)) s.coordV = 2;
      s.fixV = 2; // recorded by the current rules from its first turn
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
  private delta(s: SessionSpend, id: string, u: TurnUsage | undefined, cost: number | undefined, info: SessionInfo | undefined, fromStart = false, legacy = false): { models: ModelTok; estimated: boolean } {
    const cum = u?.cum && Object.keys(u.cum).length ? u.cum : undefined;
    const fallbackModel = info?.model ?? Object.keys(s.models)[0] ?? 'unknown';
    if (cum) {
      const prev = s.cum;
      s.cum = structuredClone(cum);
      if (cost !== undefined) s.lastCost = cost;
      if (!prev) {
        // The first result this store saw for the session. A session that had no result before it started from zero: exact.
        if (fromStart || this.ctx.priorResults(id) <= 1) return { models: structuredClone(cum), estimated: false };
        // One that ran before: its earlier turns are in the totals. This turn alone is the main loop's own usage, priced at list.
        const m = u?.main;
        if (!m) return { models: {}, estimated: true };
        return { models: { [fallbackModel]: { in: m.in, out: m.out, cr: m.cr, cw: m.cw, usd: listUsd(fallbackModel, m) } }, estimated: true };
      }
      const out: ModelTok = {};
      for (const [model, c] of Object.entries(cum)) {
        const p = prev[model] ?? zeroTok();
        // Totals that grew on every count since the last result continued (a resumed process carries its saved totals, w1161):
        // the difference is the turn, whatever the restarted flag says (a portal before w1161 set it on every resume once
        // its own figure ran ahead, and each portal restart then counted the whole running total again).
        const grew = c.usd >= p.usd && c.in >= p.in && c.out >= p.out && c.cr >= p.cr && c.cw >= p.cw;
        // totals that began again: the agent process says so (usage.restarted), else a drop to half or less (a /clear, an older daemon)
        const reset = (legacy || !grew) && (u?.restarted === true || c.usd < p.usd * 0.5 || c.in < p.in * 0.5 || c.cr < p.cr * 0.5);
        const d = reset ? c : { in: Math.max(0, c.in - p.in), out: Math.max(0, c.out - p.out), cr: Math.max(0, c.cr - p.cr), cw: Math.max(0, c.cw - p.cw), usd: Math.max(0, c.usd - p.usd) };
        if (d.in || d.out || d.cr || d.cw || d.usd) out[model] = d;
      }
      return { models: out, estimated: false };
    }
    // Usage missing (a daemon older than w859): dollars from total_cost_usd, no tokens.
    if (cost === undefined) return { models: {}, estimated: true };
    const prev = s.lastCost;
    s.lastCost = cost;
    const usd = prev === undefined ? (fromStart || this.ctx.priorResults(id) <= 1 ? cost : 0) : cost >= prev ? cost - prev : cost;
    return { models: usd > 0 ? { [fallbackModel]: { ...zeroTok(), usd } } : {}, estimated: true };
  }

  private record(sessionId: string, at: string, u: TurnUsage | undefined, cost: number | undefined, durationMs: number, seq: number, answers?: string[]) {
    const info = this.ctx.session(sessionId);
    const s = this.sessionRec(sessionId, info, at);
    s.liveFrom ??= seq;
    if (isCoordinatorRole(s.role) && s.coordV !== 2) s.coordFrom ??= seq;
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
    const allocs = attribute(info ?? infoOfRecord(s), items, texts, startMs);
    this.add({ s, at, models, total, estimated, meter: u?.meter, allocs, items, info, account: this.accountOf(info) });
    this.changed();
  }

  /** The account a live turn ran on: its process's (ranAs, set at each process start), else a host session's account label. */
  private accountOf(info: SessionInfo | undefined): string {
    return info?.ranAs ?? (info ? this.ctx.accountLabel?.(info) : undefined) ?? UNRECORDED_ACCOUNT;
  }

  /** Add one turn's spend to its session and, by weight, to its requests. Also the backfill's entry (no account). */
  add(a: { s: SessionSpend; at: string; models: ModelTok; total: Tok; estimated: boolean; meter?: MeterTurn; allocs: Alloc[]; items?: readonly WorkItem[]; info?: SessionInfo; account?: string; accountMix?: Record<string, number>; sign?: 1 | -1 }) {
    const { s, at, allocs } = a;
    // sign -1 takes a turn back out (correctHistory, w1209): every figure is linear in it except the largest context and the dates
    const k = a.sign ?? 1;
    const total = k === 1 ? a.total : scaleTok(a.total, -1);
    const models = k === 1 ? a.models : addModels({}, a.models, -1);
    // the account(s) the turn ran on: one, or (a turn put back by correctHistory, whose account is not known) the session's own mix
    const parts: [string, number][] = a.accountMix ? Object.entries(a.accountMix) : [[a.account ?? UNRECORDED_ACCOUNT, 1]];
    for (const [acc, p] of parts) s.accounts = addModels(s.accounts ?? {}, { [acc]: total }, p);
    if (k === 1) {
      s.lastAt = at > s.lastAt ? at : s.lastAt;
      if (at < s.firstAt) s.firstAt = at;
    }
    s.turns += k;
    s.total = addTok(s.total, total);
    s.models = addModels(s.models, models);
    if (a.estimated) s.estimated = addTok(s.estimated, total);
    if (a.meter) {
      s.cats = addCats(s.cats, a.meter.cats, k);
      s.calls += a.meter.calls * k;
      if (k === 1) s.ctxMax = Math.max(s.ctxMax, a.meter.ctxMax);
      if (a.meter.compacted) s.compactions += k;
      if (a.meter.reread) s.reread = { n: (s.reread?.n ?? 0) + a.meter.reread.n * k, chars: (s.reread?.chars ?? 0) + a.meter.reread.chars * k, afterCompact: (s.reread?.afterCompact ?? 0) + a.meter.reread.afterCompact * k };
    }
    for (const al of allocs) {
      const f = al.weight * k;
      const r = this.requestRec(al.id, a.items, at);
      if (k === 1) {
        r.lastAt = at > r.lastAt ? at : r.lastAt;
        if (at < r.firstAt) r.firstAt = at;
      }
      r.turns += f;
      r.total = addTok(r.total, scaleTok(a.total, f));
      r.models = addModels(r.models, a.models, f);
      for (const [acc, p] of parts) r.accounts = addModels(r.accounts ?? {}, { [acc]: a.total }, f * p);
      if (a.estimated) r.estimated = addTok(r.estimated, scaleTok(a.total, f));
      const d = day(at);
      r.days[d] = addTok(r.days[d] ?? zeroTok(), scaleTok(a.total, f));
      if (isCoordinatorRole(s.role) && !isBucket(al.id)) {
        const byDay = ((r.coordDays ??= {})[s.id] ??= {});
        byDay[d] = addTok(byDay[d] ?? zeroTok(), scaleTok(a.total, f));
      }
      const rs = (r.sessions[s.id] ??= { role: s.role, total: zeroTok(), models: {}, turns: 0, how: {} });
      rs.total = addTok(rs.total, scaleTok(a.total, f));
      rs.models = addModels(rs.models, a.models, f);
      rs.turns += f;
      rs.how[al.how] = (rs.how[al.how] ?? 0) + f;
      if (allocs.length > 1) rs.shared = (rs.shared ?? 0) + f;
      s.requests[al.id] = (s.requests[al.id] ?? 0) + a.total.usd * f;
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

  /**
   * Record the turns the old rules got wrong again by the current rules (w1209; lothsahn: "The billing needs to be accurate so we can
   * optimize."). Two rules changed on 2026-10-13 (`RULES_FROM_MS`): a restart's first result no longer counts the CLI's whole running total
   * as one turn (w1161: about $200 each for the dispatcher and each orchestrator, per restart, and the same for every resumed worker), and an
   * id cited in parentheses in a harness notice no longer bills the turn to that request (w1160: w605's $1,836). The session's transcript is
   * replayed twice, by the old rules and by the current ones; for each live-recorded turn before then that the two read differently, the
   * old reading is taken out of the record and the current one put in, so the session and every request it touched change by the
   * difference and nothing else. The category figures (`cats`) come from the calls' own usage and do not move with the cost rule.
   * Guarded: the replay must explain the session's recorded total within 5% (backfilled turns are replayed the same way), else nothing is
   * changed and the reason is returned. Once per session (`fixV` 1). Returns what it did.
   */
  correctHistory(sessionId: string, events: readonly TranscriptEvent[] | undefined, info: SessionInfo | undefined): { removedUsd: number; movedUsd: number; turns: number; skipped?: string } {
    const none = { removedUsd: 0, movedUsd: 0, turns: 0 };
    const s = this.sessions.get(sessionId);
    if (!s || s.fixV === 2) return none;
    // fixV 1 (the first release) corrected the live-recorded turns; this one also looks at the backfilled ones, so a session that release corrected is not corrected twice
    const liveDone = s.fixApplied === true;
    s.fixV = 2;
    this.changed();
    if (!events?.length) return { ...none, skipped: 'no transcript' };
    const items = [...this.ctx.work()];
    const known = new Set(this.requests.keys());
    const scL = { models: {} } as SessionSpend;
    const scN = { models: {} } as SessionSpend;
    const liveFrom = s.liveFrom ?? Infinity;
    const diffs: { at: string; mL: ModelTok; mN: ModelTok; tL: Tok; tN: Tok; AL: Alloc[]; AN: Alloc[]; meter?: MeterTurn; estimated?: boolean; backfill?: boolean }[] = [];
    let replayed = 0;
    let pending: { uuid?: string; text: string }[] = [];
    // the backfill's own reading (backfillSession): the recorded cost totals differenced, tokens estimated from the characters
    let prevCost: number | undefined;
    let outChars = 0;
    let freshChars = 0;
    const model = info?.model ?? 'unknown';
    for (const e of events) {
      if (e.kind === 'assistant' || e.kind === 'thinking') outChars += e.text.length;
      else if (e.kind === 'tool_use') outChars += Math.min(20_000, JSON.stringify(e.input ?? {}).length);
      else if (e.kind === 'tool_result') freshChars += e.text.length;
      if (e.kind === 'user') {
        pending.push({ uuid: e.uuid, text: e.text.slice(0, 1500) });
        freshChars += e.text.length;
      } else if (e.kind === 'result' && e.seq < liveFrom) {
        // A turn backfilled from the cost totals. Before w1161 the portal's own total doubled at a restart (it added the CLI's whole running
        // total to its own), so the turn after a restart read as the running total again: a turn that costs as much as the session had cost
        // so far, from $20 up, is that and nothing else (a real turn cannot), and what it really cost is what is left over.
        const before = prevCost ?? 0;
        let dOld = e.costUsd >= before ? e.costUsd - before : e.costUsd;
        prevCost = e.costUsd;
        if (info && info.costUsd > 0 && dOld > info.costUsd * 1.05) dOld = info.costUsd;
        const restart = before >= 20 && e.costUsd >= before && dOld >= before * 0.9;
        const dNew = restart ? Math.max(0, dOld - before) : dOld;
        replayed += dOld;
        const mine = e.answers?.length ? pending.filter((t) => t.uuid && e.answers!.includes(t.uuid)) : [];
        const used = mine.length ? mine : pending;
        pending = mine.length ? pending.filter((t) => !mine.includes(t)) : [];
        if (dNew !== dOld) {
          const tokOld = dOld > 0 ? estimateTurn(model, dOld, outChars, freshChars) : zeroTok();
          const tokNew = dNew > 0 ? estimateTurn(model, dNew, outChars, freshChars) : zeroTok();
          const startMs = (Date.parse(e.t) || 0) - e.durationMs;
          const texts = used.map((t) => t.text);
          diffs.push({ at: e.t, mL: { [model]: tokOld }, mN: { [model]: tokNew }, tL: tokOld, tN: tokNew, AL: attribute(info ?? infoOfRecord(s), items, texts, startMs, known, true, false), AN: attribute(info ?? infoOfRecord(s), items, texts, startMs, known, false, false), estimated: true, backfill: true });
        }
        outChars = 0;
        freshChars = 0;
      } else if (e.kind === 'result') {
        const old = (Date.parse(e.t) || 0) < RULES_FROM_MS;
        const mL = this.delta(scL, sessionId, e.usage, e.costUsd, info, true, true).models;
        const mN = this.delta(scN, sessionId, e.usage, e.costUsd, info, true, false).models;
        const mine = e.answers?.length ? pending.filter((t) => t.uuid && e.answers!.includes(t.uuid)) : [];
        const used = mine.length ? mine : pending;
        pending = mine.length ? pending.filter((t) => !mine.includes(t)) : [];
        const tL = sumTok(Object.values(mL));
        const tN = sumTok(Object.values(mN));
        replayed += old && !liveDone ? tL.usd : tN.usd;
        outChars = 0;
        freshChars = 0;
        if (!old || liveDone) continue;
        const startMs = (Date.parse(e.t) || 0) - e.durationMs;
        const texts = used.map((t) => t.text);
        const AL = attribute(info ?? infoOfRecord(s), items, texts, startMs, known, true, false);
        const AN = attribute(info ?? infoOfRecord(s), items, texts, startMs, known, false, false);
        const sameAlloc = AL.length === AN.length && AL.every((x, i) => x.id === AN[i].id && Math.abs(x.weight - AN[i].weight) < 1e-9);
        if (sameAlloc && Math.abs(tL.usd - tN.usd) < 1e-9) continue;
        diffs.push({ at: e.t, mL, mN, tL, tN, AL, AN, meter: e.usage?.meter });
      }
    }
    if (!diffs.length) return none;
    if (!(s.total.usd > 0) || Math.abs(replayed - s.total.usd) > s.total.usd * 0.05) return { ...none, skipped: `the replay reads $${replayed.toFixed(2)} where the record holds $${s.total.usd.toFixed(2)}` };
    // the turns' accounts are not in the transcript: spread by the mix the session ran on, so no account goes below what it spent
    const accTotal = Object.values(s.accounts ?? {}).reduce((x, t) => x + Math.max(0, t.usd), 0);
    const accountMix = accTotal > 0 ? Object.fromEntries(Object.entries(s.accounts!).filter(([, t]) => t.usd > 0).map(([k, t]) => [k, t.usd / accTotal])) : undefined;
    let removedUsd = 0;
    let movedUsd = 0;
    for (const d of diffs) {
      this.add({ s, at: d.at, models: d.mL, total: d.tL, estimated: d.estimated ?? false, meter: d.meter, allocs: d.AL, items, accountMix, sign: -1 });
      this.add({ s, at: d.at, models: d.mN, total: d.tN, estimated: d.estimated ?? false, meter: d.meter, allocs: d.AN, items, accountMix, sign: 1 });
      removedUsd += d.tL.usd - d.tN.usd;
      if (d.AL.length !== d.AN.length || d.AL.some((x, i) => x.id !== d.AN[i].id)) movedUsd += d.tN.usd;
    }
    if (diffs.some((d) => !d.backfill) || liveDone) s.fixApplied = true;
    s.acctV = 1;
    if (isCoordinatorRole(s.role)) s.coordV = undefined; // its days are rebuilt from the corrected record
    this.changed();
    return { removedUsd, movedUsd, turns: diffs.length };
  }

  /**
   * Put right the accounts of what correctHistory changed in its first release (w1209): it took each turn out of, and put it back on, the
   * session's biggest account, so other accounts read negative (-$2,018 and -$1,428 in a 7-day report). The accounts of a corrected session
   * are its accounts before the correction (from the copy of the record, `spend.json.pre-w1209`) scaled to what it now holds, and a request
   * those sessions touched has its accounts spread from its sessions' mixes: an estimate, the totals unchanged. Once per session.
   */
  repairAccounts(): { sessions: number; requests: number } {
    const none = { sessions: 0, requests: 0 };
    const todo = [...this.sessions.values()].filter((x) => x.fixApplied && x.acctV !== 1);
    if (!todo.length) return none;
    let backup: SpendFile | undefined;
    try {
      backup = JSON.parse(fs.readFileSync(`${this.path}.pre-w1209`, 'utf8')) as SpendFile;
    } catch {
      return none;
    }
    const touched = new Set<string>();
    let n = 0;
    for (const s of todo) {
      s.acctV = 1;
      const was = backup.sessions?.[s.id]?.accounts;
      const sum = Object.values(was ?? {}).reduce((x, t) => x + Math.max(0, t.usd), 0);
      if (!was || sum <= 0 || !(s.total.usd > 0)) continue;
      s.accounts = Object.fromEntries(Object.entries(was).filter(([, t]) => t.usd > 0).map(([k, t]) => [k, scaleTok(t, s.total.usd / sum)]));
      for (const id of Object.keys(s.requests)) touched.add(id);
      n++;
    }
    for (const id of touched) {
      const r = this.requests.get(id);
      if (!r) continue;
      let acc: ModelTok = {};
      for (const [sid, rs] of Object.entries(r.sessions)) {
        const s = this.sessions.get(sid);
        const tot = Object.values(s?.accounts ?? {}).reduce((x, t) => x + Math.max(0, t.usd), 0);
        if (!s?.accounts || tot <= 0) acc = addModels(acc, { [UNRECORDED_ACCOUNT]: rs.total });
        else for (const [k, t] of Object.entries(s.accounts)) if (t.usd > 0) acc = addModels(acc, { [k]: rs.total }, t.usd / tot);
      }
      r.accounts = acc;
    }
    this.changed();
    return { sessions: n, requests: touched.size };
  }

  /** A copy of the record before something rewrites history in it (once per tag). */
  backupOnce(tag: string): void {
    const to = `${this.path}.${tag}`;
    if (!fs.existsSync(this.path) || fs.existsSync(to)) return;
    this.file.flushSync();
    fs.copyFileSync(this.path, to);
  }

  /**
   * Give a coordinator session's coordination its days (w1160), from its own transcript (a chat is never pruned). Its turns are
   * replayed the way they were recorded: before `coordFrom` (the first turn the current code recorded) by the older attribution
   * and cost rules (`legacy`: an id cited in parentheses in a harness notice counted, a restart's whole running total was one
   * turn), after it by the current ones, so each request gets the days its recorded dollars were really spent on. The first version
   * replayed old turns by the new rules and scaled the result to the recorded size, which put w605's $1,836 on the wrong days
   * (it read as $1,475 of worker cost in the 3-day window). What the replay does not explain is spread over the days with room
   * left (the request's spend that day minus what coordinators already hold), and no day holds more coordination than the request
   * spent. The session's recorded dollars per request (`SessionSpend.requests`) stay the totals. Estimated where the replay differs.
   * Runs for a session without `coordV` 2; forgets what the session put in the days first. Returns the usd given days.
   */
  rebuildCoordination(sessionId: string, events: readonly TranscriptEvent[] | undefined, info: SessionInfo | undefined): number {
    const s = this.sessions.get(sessionId);
    if (!s || !isCoordinatorRole(s.role) || s.coordV === 2) return 0;
    for (const r of this.requests.values()) if (r.coordDays?.[sessionId]) delete r.coordDays[sessionId];
    const items = [...this.ctx.work()];
    const known = new Set(this.requests.keys());
    const scratch = { models: {} } as SessionSpend;
    const replay = new Map<string, Map<string, Tok>>();
    let pending: { uuid?: string; text: string }[] = [];
    for (const e of events ?? []) {
      if (e.kind === 'user') pending.push({ uuid: e.uuid, text: e.text.slice(0, 1500) });
      else if (e.kind === 'result') {
        // before the rules changed, a turn was read by the old ones unless correctHistory has already put the current reading in the record
        const legacy = !s.fixApplied && (Date.parse(e.t) || 0) < RULES_FROM_MS;
        const { models } = this.delta(scratch, sessionId, e.usage, e.costUsd, info, true, legacy);
        const mine = e.answers?.length ? pending.filter((t) => t.uuid && e.answers!.includes(t.uuid)) : [];
        const used = mine.length ? mine : pending;
        pending = mine.length ? pending.filter((t) => !mine.includes(t)) : [];
        const total = sumTok(Object.values(models));
        const startMs = (Date.parse(e.t) || 0) - e.durationMs;
        for (const al of attribute(info, items, used.map((t) => t.text), startMs, known, legacy)) {
          if (isBucket(al.id)) continue;
          const days = replay.get(al.id) ?? new Map<string, Tok>();
          days.set(day(e.t), addTok(days.get(day(e.t)) ?? zeroTok(), scaleTok(total, al.weight)));
          replay.set(al.id, days);
        }
      }
    }
    let given = 0;
    for (const [rid, recorded] of Object.entries(s.requests)) {
      const r = this.requests.get(rid);
      if (!r || isBucket(rid) || recorded <= 0) continue;
      // room each day has: what the request spent, less what other coordinators already hold
      const room = new Map<string, number>();
      for (const [d, t] of Object.entries(r.days)) {
        let others = 0;
        for (const [sid, days] of Object.entries(r.coordDays ?? {})) if (sid !== sessionId) others += days[d]?.usd ?? 0;
        room.set(d, Math.max(0, t.usd - others));
      }
      const mine = new Map<string, Tok>();
      const found = replay.get(rid);
      let basis = 0;
      if (found) for (const t of found.values()) basis += t.usd;
      const f = basis > recorded ? recorded / basis : 1;
      let placed = 0;
      if (found) {
        for (const [d, t] of found) {
          const take = Math.min(t.usd * f, room.get(d) ?? 0);
          if (take <= 0) continue;
          mine.set(d, scaleTok(t, take / t.usd));
          room.set(d, (room.get(d) ?? 0) - take);
          placed += take;
        }
      }
      const rest = recorded - placed;
      const roomLeft = [...room.values()].reduce((a, x) => a + x, 0);
      if (rest > 1e-6 && roomLeft > 0) {
        const share = r.sessions[sessionId]?.total;
        const give = Math.min(rest, roomLeft);
        for (const [d, x] of room) {
          if (x <= 0) continue;
          const part = (give * x) / roomLeft;
          const tok = share && share.usd > 0 ? scaleTok(share, part / share.usd) : { ...zeroTok(), usd: part };
          mine.set(d, addTok(mine.get(d) ?? zeroTok(), tok));
          placed += part;
        }
      }
      if (!mine.size) continue;
      const byDay = ((r.coordDays ??= {})[sessionId] ??= {});
      for (const [d, t] of mine) byDay[d] = addTok(byDay[d] ?? zeroTok(), t);
      given += placed;
    }
    s.coordV = 2;
    this.changed();
    return given;
  }

  // ---- reading

  /**
   * A request's cost over its whole life, split into the workers' own and the coordinators' (w1160). Exact: the sessions hold
   * both, whatever the days say. `coordination.by` is per coordinator.
   */
  splitOf(r: RequestSpend): { workers: Tok; coordination: Coordination } {
    let coord = zeroTok();
    const by = new Map<string, number>();
    for (const [sid, rs] of Object.entries(r.sessions)) {
      if (!isCoordinatorRole(rs.role)) continue;
      coord = addTok(coord, rs.total);
      const k = coordKey(rs.role, this.sessions.get(sid)?.person);
      by.set(k, (by.get(k) ?? 0) + rs.total.usd);
    }
    return { workers: subTok(r.total, coord), coordination: mkCoordination(coord, by) };
  }

  /** The same for the UTC days `sinceDay` to `untilDay` (`window` is the request's whole spend in them): the coordination is the days recorded for it, never more than the window. */
  windowSplit(r: RequestSpend, sinceDay: string, untilDay: string, window: Tok): { workers: Tok; coordination: Coordination } {
    let coord = zeroTok();
    const by = new Map<string, number>();
    for (const [sid, days] of Object.entries(r.coordDays ?? {})) {
      const who = this.sessions.get(sid);
      const k = who ? coordKey(who.role, who.person) : 'coordinator';
      for (const [d, t] of Object.entries(days)) {
        if (d < sinceDay || d > untilDay) continue;
        coord = addTok(coord, t);
        by.set(k, (by.get(k) ?? 0) + t.usd);
      }
    }
    if (coord.usd > window.usd && coord.usd > 0) {
      const f = window.usd / coord.usd;
      coord = scaleTok(coord, f);
      for (const [k, v] of by) by.set(k, v * f);
    }
    return { workers: subTok(window, coord), coordination: mkCoordination(coord, by) };
  }

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

/** a - b, no field below zero (rounding, and a window that holds less than the days recorded). */
const subTok = (a: Tok, b: Tok): Tok => ({ in: Math.max(0, a.in - b.in), out: Math.max(0, a.out - b.out), cr: Math.max(0, a.cr - b.cr), cw: Math.max(0, a.cw - b.cw), usd: Math.max(0, a.usd - b.usd) });
const mkCoordination = (tokens: Tok, by: Map<string, number>): Coordination => ({ usd: tokens.usd, tokens, by: [...by].filter(([, v]) => v > 0).map(([k, v]) => ({ who: coordLabel(k), usd: v })).sort((a, b) => b.usd - a.usd) });
const byLine = (c: Coordination) => (c.by.length ? ` (${c.by.map((b) => `${b.who} ${fmtUsd(b.usd)}`).join(', ')})` : '');

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
  let byAccount: Record<string, Tok> = {};
  for (const x of rows) {
    if (x.r.total.usd <= 0) continue;
    models = addModels(models, x.r.models, x.window.usd / x.r.total.usd);
    byAccount = addModels(byAccount, x.r.accounts ?? { [UNRECORDED_ACCOUNT]: x.r.total }, x.window.usd / x.r.total.usd);
  }
  const catShare = (r: RequestSpend, usd: number) => {
    const sum = Object.values(r.cats).reduce((a, c) => a + c.usd, 0);
    return sum > 0 ? Object.entries(r.cats).map(([cat, c]) => ({ cat, usd: (c.usd / sum) * usd, pct: c.usd / sum })) : [];
  };
  // w1160: a request's headline cost is its workers' own; the coordinators' turns on it are billed beside it, so the two add up to the window.
  const split = new Map(reqs.map((x) => [x.r.id, spend.windowSplit(x.r, sinceDay, untilDay, x.window)] as const));
  const workers = sumTok(reqs.map((x) => split.get(x.r.id)!.workers));
  const coordTok = sumTok(reqs.map((x) => split.get(x.r.id)!.coordination.tokens));
  const coordBy = new Map<string, number>();
  for (const x of reqs) for (const b of split.get(x.r.id)!.coordination.by) coordBy.set(b.who, (coordBy.get(b.who) ?? 0) + b.usd);
  const coordination: Coordination = { usd: coordTok.usd, tokens: coordTok, by: [...coordBy].map(([who, usd]) => ({ who, usd })).sort((a, b) => b.usd - a.usd) };
  const topCoordination = [...reqs]
    .filter((x) => split.get(x.r.id)!.coordination.usd > 0.005)
    .sort((a, b) => split.get(b.r.id)!.coordination.usd - split.get(a.r.id)!.coordination.usd)
    .slice(0, Math.min(o.top ?? 10, 10))
    .map(({ r }) => ({ id: r.id, title: r.title, status: r.status, coordination: split.get(r.id)!.coordination, workers: split.get(r.id)!.workers.usd }));
  const top = [...reqs]
    .sort((a, b) => split.get(b.r.id)!.workers.usd - split.get(a.r.id)!.workers.usd)
    .slice(0, o.top ?? 10)
    .map(({ r, window }) => ({
      id: r.id,
      title: r.title,
      kind: r.kind,
      status: r.status,
      person: r.person,
      usd: split.get(r.id)!.workers.usd,
      tokens: split.get(r.id)!.workers,
      coordination: split.get(r.id)!.coordination,
      estimatedUsd: r.total.usd > 0 ? (r.estimated.usd * window.usd) / r.total.usd : 0,
      sessions: Object.values(r.sessions).filter((x) => !isCoordinatorRole(x.role)).length,
      closed: !!r.closedAt,
      cats: catShare(r, window.usd)
        .sort((a, b) => b.usd - a.usd)
        .slice(0, 6),
    }));
  const kindMap = new Map<string, { usd: number; n: number; coord: number }>();
  for (const x of reqs) {
    const k = kindMap.get(x.r.kind) ?? { usd: 0, n: 0, coord: 0 };
    k.usd += split.get(x.r.id)!.workers.usd;
    k.coord += split.get(x.r.id)!.coordination.usd;
    k.n++;
    kindMap.set(x.r.kind, k);
  }
  const kinds = [...kindMap].map(([kind, v]) => ({ kind, usd: v.usd, requests: v.n, avg: v.n ? v.usd / v.n : 0, coordination: v.coord })).sort((a, b) => b.usd - a.usd);
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
  const accounts = Object.entries(byAccount).map(([account, tokens]) => ({ account, usd: tokens.usd, tokens })).sort((a, b) => b.usd - a.usd);
  return { sinceDay, untilDay, total, estimated, models, accounts, top, workers, coordination, topCoordination, kinds, where, buckets, measuredCats: measured, ...(reread ? { reread } : {}) };
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
  if (r.accounts.length) lines.push(`By Claude account the turns ran on (the account of the process that ran each turn, last four characters only): ${r.accounts.map((a) => `${a.account} ${fmtUsd(a.usd)} (${pct(r.total.usd ? a.usd / r.total.usd : 0)})`).join('; ')}.`);
  const loose = r.buckets.reduce((a, b) => a + b.usd, 0);
  lines.push(`Of that: the workers' own cost on requests ${fmtUsd(r.workers.usd)}; coordination on requests ${fmtUsd(r.coordination.usd)}${byLine(r.coordination)}; not any request's ${fmtUsd(loose)}. ${COORDINATION_NOTE}`);
  if (r.buckets.length) lines.push(`Not any request's: ${r.buckets.map((b) => `${b.title} ${fmtUsd(b.usd)}`).join('; ')}.`);
  lines.push('', `Top ${r.top.length} requests by the workers' own cost (coordination is billed beside it, not in it):`);
  for (const [i, t] of r.top.entries()) {
    lines.push(`${i + 1}. ${t.id} workers ${fmtUsd(t.usd)}${t.coordination.usd > 0.005 ? `, coordination ${fmtUsd(t.coordination.usd)}${byLine(t.coordination)}` : ''} [${t.kind}${t.closed ? ', closed' : t.status ? `, ${t.status}` : ''}] "${t.title.slice(0, 90)}"${t.person ? ` for ${t.person}` : ''}: ${t.sessions} worker session(s); in ${fmtTokens(t.tokens.in)}, out ${fmtTokens(t.tokens.out)}, read ${fmtTokens(t.tokens.cr)}, write ${fmtTokens(t.tokens.cw)}${t.estimatedUsd > 0.005 ? `; ${fmtUsd(t.estimatedUsd)} estimated` : ''}${t.cats.length ? `. Where it went (all its sessions): ${t.cats.map((c) => `${c.cat} ${pct(c.pct)}`).join(', ')}` : ''}`);
  }
  if (r.topCoordination.length) {
    lines.push('', `Most coordination on a request (an estimate: a turn naming several requests is split evenly), top ${r.topCoordination.length}:`);
    for (const t of r.topCoordination) lines.push(`- ${t.id} coordination ${fmtUsd(t.coordination.usd)}${byLine(t.coordination)}, workers ${fmtUsd(t.workers)}${t.status ? ` [${t.status}]` : ''} "${t.title.slice(0, 70)}"`);
  }
  lines.push('', "By kind of work (requests with spend in the window; the workers' own cost, coordination beside it):");
  for (const k of r.kinds) lines.push(`- ${k.kind}: ${fmtUsd(k.usd)} over ${k.requests} request(s), ${fmtUsd(k.avg)} each; coordination ${fmtUsd(k.coordination)}`);
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
  // The workers' own cost; the coordinators' turns on the request are billed beside it (w1160).
  const { workers, coordination } = spend!.splitOf(r);
  const est = r.estimated.usd > 0.005 ? `, ${fmtUsd(r.estimated.usd)} estimated` : '';
  const n = Object.values(r.sessions).filter((s) => !isCoordinatorRole(s.role)).length;
  const coord = coordination.usd > 0.005 ? ` Coordination (dispatcher and orchestrator turns on it, an estimate): ${fmtUsd(coordination.usd)}.` : '';
  return ` Cost so far: ${fmtUsd(workers.usd)} (${n} session(s); in ${fmtTokens(workers.in)}, out ${fmtTokens(workers.out)}, read ${fmtTokens(workers.cr)}, write ${fmtTokens(workers.cw)}${est}).${coord}`;
}

/** One request's spend in full: models, sessions with their transcripts, categories. `link(sessionId)` gives a session's transcript URL. */
export function renderRequest(spend: SpendStore, id: string, link: (sessionId: string) => string, retainDays: number): string {
  const r = spend.request(id);
  if (!r) return `No spend recorded for ${id} (spend is recorded from the turns after the w859 deploy and backfilled from older transcripts).`;
  const lines: string[] = [];
  const { workers, coordination } = spend.splitOf(r);
  if (isBucket(r.id)) {
    // Spend that is no request's (w1209: its days used to read "workers", the header "coordination"): one figure, said once
    const who = coordination.usd > workers.usd ? 'coordinators (dispatcher, orchestrators, ops worker, standing agents)' : 'workers tied to no request';
    lines.push(`${r.id} "${r.title}" [not any request's]: ${tokLine(r.total)}, from ${who}, ${Math.round(r.turns)} turn(s), ${r.firstAt.slice(0, 16).replace('T', ' ')} to ${r.lastAt.slice(0, 16).replace('T', ' ')}.${r.estimated.usd > 0.005 ? ` ${fmtUsd(r.estimated.usd)} of it is estimated.` : ''}`);
    const byDay = Object.entries(r.days).sort((a, b) => b[0].localeCompare(a[0]));
    if (byDay.length) lines.push(`By UTC day, newest first: ${byDay.slice(0, 14).map(([d, t]) => `${d} ${fmtUsd(t.usd)}`).join('; ')}${byDay.length > 14 ? `; ${byDay.length - 14} earlier day(s)` : ''}.`);
  } else {
  lines.push(`${r.id} "${r.title}" [${r.kind}${r.closedAt ? `, closed ${r.closedAt.slice(0, 10)}` : r.status ? `, ${r.status}` : ''}]: workers' own cost ${tokLine(workers)}; coordination ${fmtUsd(coordination.usd)}${byLine(coordination)}; all together ${fmtUsd(r.total.usd)}. ${Math.round(r.turns)} turn(s), ${r.firstAt.slice(0, 16).replace('T', ' ')} to ${r.lastAt.slice(0, 16).replace('T', ' ')}.${r.estimated.usd > 0.005 ? ` ${fmtUsd(r.estimated.usd)} of the all-together figure is estimated.` : ''}`);
  if (coordination.usd > 0.005) lines.push(COORDINATION_NOTE);
  const dayRows = daySplit(r);
  if (dayRows.length) lines.push(`By UTC day (workers / coordination), newest first: ${dayRows.slice(0, 14).map((d) => `${d.day} ${fmtUsd(d.workers)} / ${fmtUsd(d.coordination)}`).join('; ')}${dayRows.length > 14 ? `; ${dayRows.length - 14} earlier day(s)` : ''}.`);
  }
  const m = Object.entries(r.models).sort((a, b) => b[1].usd - a[1].usd);
  if (m.length) {
    lines.push(isBucket(r.id) ? 'Per model:' : 'Per model (workers and coordination together):');
    for (const [k, v] of m) lines.push(`- ${k}: ${tokLine(v)}`);
  }
  const accounts = Object.entries(r.accounts ?? {}).sort((a, b) => b[1].usd - a[1].usd);
  if (accounts.length) {
    lines.push('Per Claude account (the account of the process that ran each turn):');
    for (const [k, v] of accounts) lines.push(`- ${k}: ${tokLine(v)}`);
  }
  lines.push('Sessions, the workers first, then the coordinators (a session that served several requests shows only this request\'s share):');
  const sessionRows = spend.sessionsOf(id).sort((a, b) => Number(isCoordinatorRole(a.share.role)) - Number(isCoordinatorRole(b.share.role)));
  // _unattributed holds hundreds of sessions (an 87k-character answer, w1209): the biggest 25, then a count and their sum
  const SHOWN = 25;
  for (const { session: s, share } of sessionRows.slice(0, SHOWN)) {
    const how = Object.entries(share.how).map(([h, n]) => `${h} ${Math.round(n)}`).join(', ');
    const until = spend.protectedUntil(s.id, retainDays);
    const t = s.transcript;
    const kept = t?.state === 'pruned' ? `transcript pruned ${t.prunedAt?.slice(0, 10) ?? ''}` : `transcript ${t?.state === 'gz' ? 'compressed' : 'kept'}${until && Number.isFinite(until) ? ` until ${new Date(until).toISOString().slice(0, 10)}` : until === Infinity ? ' while the request is open' : ''}`;
    lines.push(`- ${s.id} ${isCoordinatorRole(s.role) ? `coordination (${s.role})` : s.role} "${s.title}"${s.machine ? ` on ${s.machine}` : ''}: ${tokLine(share.total)}, ${Math.round(share.turns)} turn(s) [${how}${share.shared ? `; ${Math.round(share.shared)} shared with other requests` : ''}]; ${kept}; ${link(s.id)}`);
  }
  if (sessionRows.length > SHOWN) lines.push(`- and ${sessionRows.length - SHOWN} more session(s), ${fmtUsd(sessionRows.slice(SHOWN).reduce((a, x) => a + x.share.total.usd, 0))} together`);
  const sum = Object.values(r.cats).reduce((a, c) => a + c.usd, 0);
  if (sum > 0) {
    lines.push(`Where the money went, all its sessions (a context reading of ${Math.round(r.calls)} model calls; shares by characters, exact in total):`);
    for (const [cat, c] of Object.entries(r.cats).sort((a, b) => b[1].usd - a[1].usd).slice(0, 8)) lines.push(`- ${cat}: ${pct(c.usd / sum)} (${fmtUsd((c.usd / sum) * r.total.usd)}) ${CATEGORY_LABEL[cat] ?? ''}`);
    if (r.reread) lines.push(`Re-reads: ${Math.round(r.reread.n)}${r.reread.afterCompact ? `, ${Math.round(r.reread.afterCompact)} after a compaction` : ''}.`);
  }
  return lines.join('\n');
}


/** A request's days, newest first: the workers' own dollars and the coordinators'. */
function daySplit(r: RequestSpend): { day: string; workers: number; coordination: number }[] {
  const coord = new Map<string, number>();
  for (const days of Object.values(r.coordDays ?? {})) for (const [d, t] of Object.entries(days)) coord.set(d, (coord.get(d) ?? 0) + t.usd);
  return Object.entries(r.days)
    .map(([d, t]) => ({ day: d, workers: Math.max(0, t.usd - (coord.get(d) ?? 0)), coordination: Math.min(t.usd, coord.get(d) ?? 0) }))
    .sort((a, b) => b.day.localeCompare(a.day));
}

/** One session's spend, models, context readings and the requests it served. */
export function renderSession(spend: SpendStore, id: string, link: (sessionId: string) => string, requestsTop: number = SESSION_REQUESTS_TOP): string {
  const s = spend.session(id);
  if (!s) return `No spend recorded for session ${id}.`;
  const lines = [`${s.id} ${s.role}${isCoordinatorRole(s.role) ? ' (its cost is coordination)' : ''} "${s.title}"${s.machine ? ` on ${s.machine}` : ''}${s.person ? ` for ${s.person}` : ''}: ${tokLine(s.total)}, ${s.turns} turn(s), ${s.firstAt.slice(0, 16).replace('T', ' ')} to ${s.lastAt.slice(0, 16).replace('T', ' ')}.${s.estimated.usd > 0.005 ? ` ${fmtUsd(s.estimated.usd)} of it is estimated.` : ''} Transcript: ${s.transcript?.state === 'pruned' ? `pruned ${s.transcript.prunedAt?.slice(0, 10) ?? ''}` : s.transcript?.state === 'gz' ? 'compressed' : 'kept'}; ${link(s.id)}`];
  for (const [k, v] of Object.entries(s.models).sort((a, b) => b[1].usd - a[1].usd)) lines.push(`- ${k}: ${tokLine(v)}`);
  for (const [k, v] of Object.entries(s.accounts ?? {}).sort((a, b) => b[1].usd - a[1].usd)) lines.push(`- on ${k}: ${tokLine(v)}`);
  const reqs = Object.entries(s.requests).sort((a, b) => b[1] - a[1]);
  /** The first `requestsTop` of the requests a session served, most costly first, and what the rest came to (w1159). */
  const top = (entries: [string, number][]) => {
    const shown = entries.slice(0, requestsTop);
    const rest = entries.slice(shown.length);
    return { count: entries.length, cut: rest.length > 0, list: shown.map(([r, usd]) => `${r} ${fmtUsd(usd)}`).join(', '), more: rest.length ? `; and ${rest.length} more, ${fmtUsd(rest.reduce((a, [, usd]) => a + usd, 0))} together (spend_report session with requests: ${Math.min(entries.length, 2000)} lists them all)` : '' };
  };
  if (isCoordinatorRole(s.role)) {
    // a coordinator's turns are billed to the requests its messages name, as coordination, not as the workers' own cost (w1160)
    const owned = reqs.filter(([r]) => !isBucket(r));
    const loose = reqs.filter(([r]) => isBucket(r));
    if (owned.length) {
      const t = top(owned);
      lines.push(`Coordination it billed to requests (a turn naming several is split evenly, an estimate${t.cut ? `; ${t.count} requests, the top ${requestsTop} by cost` : ''}): ${t.list}${t.more}.`);
    }
    if (loose.length) lines.push(`Not any request's: ${loose.map(([r, usd]) => `${r} ${fmtUsd(usd)}`).join(', ')}.`);
  } else if (reqs.length) {
    const t = top(reqs);
    lines.push(`Requests it served (the workers' own cost${t.cut ? `; ${t.count} requests, the top ${requestsTop} by cost` : ''}): ${t.list}${t.more}.`);
  }
  const sum = Object.values(s.cats).reduce((a, c) => a + c.usd, 0);
  if (sum > 0) {
    lines.push(`Context readings (${s.calls} model calls, largest context ${fmtTokens(s.ctxMax)} tokens, ${s.compactions} compaction(s)); where the money went:`);
    for (const [cat, c] of Object.entries(s.cats).sort((a, b) => b[1].usd - a[1].usd).slice(0, 10)) lines.push(`- ${cat}: ${pct(c.usd / sum)} (${fmtUsd((c.usd / sum) * s.total.usd)})`);
    if (s.reread) lines.push(`Re-reads: ${s.reread.n} (${s.reread.afterCompact} after a compaction), ${fmtTokens(s.reread.chars / 3.5)} tokens of results.`);
  }
  return lines.join('\n');
}
