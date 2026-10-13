// Where a week of Claude Code sessions on THIS computer spent its tokens (w859). Reads the CLI's own transcripts
// (~/.claude/projects/*/<session>.jsonl: every model call's usage, per message id), ties each call to the request the
// worker was on when it made it, and prints the top requests with where the tokens went. It is the same arithmetic the
// portal's spend record does live (shared/spend.ts ContextMeter and server/spend.ts kindOfWork), applied to what a machine kept,
// so it also answers for sessions that ran before the record existed, on the machines whose transcripts are on disk.
//
//   node scripts/spend-claude.ts [--root <projects dir>] [--days 7] [--top 10] [--json <file>]
//
// What is measured, and what is not: tokens per call (input, output, cache read, cache write) are the API's own usage, exact.
// Dollars are those tokens at list prices (shared/spend.ts), and each session's total is checked against the CLI's own `cost-state`
// record (the SDK's costUSD) and printed. A request is the latest `Request wNNN` / `[about wNNN …]` a message named
// (a worker's first message names it; the dispatcher's follow-ups carry the [about] line); calls before any message that names one are
// "unattributed". The split of a call's context among kinds of content is the ContextMeter's (by characters): an estimate of the
// split, exact in total.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ContextMeter, CATEGORY_LABEL, addCats, fmtTokens, fmtUsd, listUsd, toolKind, zeroTok, addTok, type Cats, type Tok } from '../shared/spend.ts';
import { kindOfWork } from '../server/spend.ts';

interface Args {
  root: string;
  days: number;
  top: number;
  json?: string;
}
function parseArgs(argv: string[]): Args {
  const a: Args = { root: path.join(os.homedir(), '.claude', 'projects'), days: 7, top: 10 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--root') a.root = argv[++i];
    else if (k === '--days') a.days = Number(argv[++i]);
    else if (k === '--top') a.top = Number(argv[++i]);
    else if (k === '--json') a.json = argv[++i];
  }
  return a;
}

interface Line {
  type?: string;
  uuid?: string;
  timestamp?: string;
  isSidechain?: boolean;
  sessionId?: string;
  cwd?: string;
  message?: { id?: string; role?: string; model?: string; content?: unknown; usage?: Usage };
  attachment?: { type?: string; prompt?: string };
  modelUsage?: Record<string, { costUSD?: number }>;
  totalCostUSD?: number;
}
interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number } | null;
  output_tokens_details?: { thinking_tokens?: number } | null;
}

const textOf = (c: unknown): string => {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((b) => (b && typeof b === 'object' && (b as { type?: string }).type === 'text' ? String((b as { text?: unknown }).text ?? '') : '')).join('');
  return '';
};
const imagesIn = (c: unknown): number => (Array.isArray(c) ? c.filter((b) => b && typeof b === 'object' && (b as { type?: string }).type === 'image').length : 0);

/** The request a message names: its [about wNNN] line, else "Request wNNN" (the first message of a worker), else a wake note's "wNNN:". */
export function requestOf(text: string, first = false): string | undefined {
  const about = /\[about\s+(w\d+)\b/i.exec(text)?.[1];
  if (about) return about.toLowerCase();
  // the first message of a worker names its request in its opening: "Request w859", "w841 (lothsahn)", "Goal (w796, …)", "You're on w821", "Finish w790"
  if (first) {
    const open = /\bw\d{2,5}\b/i.exec(text.slice(0, 700))?.[0];
    if (open) return open.toLowerCase();
  }
  const wake = /^\[wake_me\][^\n]*?\b(w\d+):/i.exec(text)?.[1];
  return wake?.toLowerCase();
}
/** A title for a request from the message that named it: its "Title:" line, else the words after the id. */
const titleOf = (text: string): string | undefined => {
  const t = /\bTitle:\s*(.+)/.exec(text)?.[1]?.trim();
  if (t) return t;
  const m = /\bw\d{2,5}\b\s*(?:\([^)]*\))?[:.,]?\s*([^\n]{0,160})/i.exec(text.slice(0, 700));
  return m?.[1]?.replace(/^(Read|Do|Fix|Finish)\b[^.]*\.\s*/i, '').trim().slice(0, 120);
};

/** What a session with no request id in its opening is, from that opening. */
export function bucketOf(text: string): string {
  // the dispatcher's own turns open with the harness's notices
  if (/^\[(worker update|work request|work update|dispatch|heartbeat|ledger|restarted|resumed|intake escalation|run [0-9a-f]+)\b/i.test(text) && !/^\[run /i.test(text)) return '_dispatcher';
  if (/^\[from (ben|lothsahn|[a-z]+)\]/i.test(text)) return '_chat';
  if (/^Task delegated by the standing agent/i.test(text)) return '_delegation';
  if (/^\[run [0-9a-f]+\]/i.test(text)) return '_standing';
  if (/^\[from the orchestrator/i.test(text)) return '_worker-no-id';
  return '_other';
}

interface Req {
  id: string;
  title: string;
  total: Tok;
  /** usd by day (UTC) */
  days: Record<string, number>;
  cats: Cats;
  /** What the calls cost by the kind of tool result that made the call necessary ("round trips"). */
  trips: Record<string, { n: number; usd: number }>;
  sessions: Set<string>;
  calls: number;
  rereads: number;
  rereadAfterCompact: number;
  rewriteUsd: number;
  firstAt: string;
  lastAt: string;
  models: Record<string, Tok>;
  ctxSum: number;
  ctxMax: number;
  compactions: number;
}
const newReq = (id: string): Req => ({ id, title: '', total: zeroTok(), days: {}, cats: {}, trips: {}, sessions: new Set(), calls: 0, rereads: 0, rereadAfterCompact: 0, rewriteUsd: 0, firstAt: '9', lastAt: '', models: {}, ctxSum: 0, ctxMax: 0, compactions: 0 });

export interface Result {
  requests: Req[];
  sessions: number;
  calls: number;
  total: Tok;
  /** Per session: computed dollars against the CLI's own cost-state total. */
  check: { session: string; computed: number; cli: number }[];
  models: Record<string, Tok>;
  /** What the week's calls say about how to spend less (all main-loop calls in the window). */
  extra: Extra;
}

/** The sizes behind the optimization opportunities. */
export interface Extra {
  /** Calls and dollars by the size of the context they read. */
  ctx: Record<string, { n: number; usd: number }>;
  /** Modelled: the same calls if the session compacted whenever its context passed the threshold (tokens). */
  sim: Record<number, { real: number; sim: number; compactions: number }>;
  /** Opus calls priced as Sonnet 5.5. */
  sonnet: { real: number; asSonnet: number; calls: number };
  thinking: { think: number; out: number };
  /** Calls that came after a pause of over 55 minutes and wrote most of their context again. */
  cold: { n: number; usd: number; extra: number };
  /** Calls by the pause before them. */
  gaps: Record<string, { n: number; usd: number }>;
  /** Sessions by their last context size. */
  sessionsOver: Record<string, number>;
  /** Dollars by UTC day and model. */
  byDay: Record<string, Record<string, number>>;
}
export const SIM_AT = [150_000, 200_000, 300_000];
/** After a compaction the context is the base (the median first call, measured) plus a summary, and some files are read again. */
const SIM_AFTER = 54_000 + 16_000 + 15_000;
const ctxBucket = (c: number) => (c <= 100_000 ? '0-100k' : c <= 200_000 ? '100-200k' : c <= 400_000 ? '200-400k' : c <= 700_000 ? '400-700k' : '700k+');
const gapBucket = (ms: number) => (ms < 60_000 ? 'under 1 min' : ms < 300_000 ? '1-5 min' : ms < 3_600_000 ? '5-60 min' : 'over 1 hour');

export function analyze(root: string, sinceMs: number): Result {
  const files = new Map<string, string[]>();
  for (const dir of safeDir(root)) {
    const full = path.join(root, dir);
    for (const f of safeDir(full)) if (f.endsWith('.jsonl')) (files.get(f.slice(0, -6)) ?? files.set(f.slice(0, -6), []).get(f.slice(0, -6))!).push(path.join(full, f));
  }
  const reqs = new Map<string, Req>();
  const req = (id: string) => reqs.get(id) ?? reqs.set(id, newReq(id)).get(id)!;
  const total = { t: zeroTok() };
  const models: Record<string, Tok> = {};
  const check: Result['check'] = [];
  const extra: Extra = { ctx: {}, sim: Object.fromEntries(SIM_AT.map((t) => [t, { real: 0, sim: 0, compactions: 0 }])), sonnet: { real: 0, asSonnet: 0, calls: 0 }, thinking: { think: 0, out: 0 }, cold: { n: 0, usd: 0, extra: 0 }, gaps: {}, sessionsOver: {}, byDay: {} };
  let sessions = 0;
  let calls = 0;
  for (const [sid, paths] of files) {
    // a session that moved sandboxes has a file in each project folder: one conversation, in time order
    const lines: Line[] = [];
    const seen = new Set<string>();
    for (const p of paths) {
      let st: fs.Stats;
      try {
        st = fs.statSync(p);
      } catch {
        continue;
      }
      if (st.mtimeMs < sinceMs) continue;
      for (const raw of fs.readFileSync(p, 'utf8').split('\n')) {
        if (!raw) continue;
        let d: Line;
        try {
          d = JSON.parse(raw);
        } catch {
          continue;
        }
        if (d.uuid) {
          if (seen.has(d.uuid)) continue;
          seen.add(d.uuid);
        }
        lines.push(d);
      }
    }
    if (!lines.length) continue;
    lines.sort((a, b) => (a.timestamp ?? '').localeCompare(b.timestamp ?? ''));
    const meter = new ContextMeter();
    let cur: string | undefined;
    let callReq: string | undefined;
    let lastCallId: string | undefined;
    let lastCallAt = 0;
    let trigger = 'brief';
    let firstSeen = false;
    let bucket = '_other';
    let computed = 0;
    let cli = 0;
    let any = false;
    let prevCtx = 0;
    let lastCtx = 0;
    const simCtx: Record<number, number> = {};
    // the final usage of each message id (blocks of one call repeat it; the output count grows)
    const usages = new Map<string, { model: string; u: Usage; at: string; side: boolean }>();
    for (const d of lines) if (d.type === 'assistant' && d.message?.id && d.message.usage) usages.set(d.message.id, { model: d.message.model ?? 'unknown', u: d.message.usage, at: d.timestamp ?? '', side: !!d.isSidechain });
    const charged = new Set<string>();
    const flush = (r: string | undefined, atTrigger: string) => {
      const t = meter.drain();
      if (!r) return;
      const q = req(r);
      q.cats = addCats(q.cats, t.cats);
      if (t.reread) {
        q.rereads += t.reread.n;
        q.rereadAfterCompact += t.reread.afterCompact;
      }
      if (t.compacted) q.compactions++;
      void atTrigger;
    };
    for (const d of lines) {
      const at = d.timestamp ?? '';
      const inWindow = Date.parse(at) >= sinceMs;
      if (d.type === 'cost-state' && d.totalCostUSD !== undefined) cli = Math.max(cli, d.totalCostUSD); // the CLI's running total only grows
      if (d.type === 'user' && d.message && typeof d.message.content === 'string') {
        if (!firstSeen) bucket = bucketOf(d.message.content);
        // a worker's first message names its request in its opening; an orchestrator's or a chat's does not (what it names is the subject of one turn)
        const r = requestOf(d.message.content, !firstSeen && (bucket === '_worker-no-id' || bucket === '_delegation' || bucket === '_other'));
        firstSeen = true;
        if (r) {
          cur = r;
          const q = req(r);
          q.title ||= titleOf(d.message.content) ?? '';
        }
        meter.addUser(d.message.content.length);
        trigger = 'brief';
      } else if (d.type === 'queue-operation' || d.type === 'attachment') {
        // queued messages reach the model as user text; the attachment copy of a queued command names the request too
        const prompt = d.type === 'attachment' && d.attachment?.type === 'queued_command' ? d.attachment.prompt : undefined;
        if (prompt && /^\[(from the orchestrator|wake_me)/.test(prompt)) {
          const r = requestOf(prompt);
          if (r) {
            cur = r;
            req(r).title ||= titleOf(prompt) ?? '';
          }
        }
      } else if (d.type === 'user' && Array.isArray(d.message?.content) && !d.isSidechain) {
        for (const b of d.message!.content as { type?: string; tool_use_id?: string; content?: unknown; text?: string }[]) {
          if (b.type === 'tool_result' && b.tool_use_id) {
            meter.addToolResult(b.tool_use_id, textOf(b.content).length, imagesIn(b.content));
            trigger = triggerOf.get(b.tool_use_id) ?? 'other';
          } else if (b.type === 'text' && b.text) {
            meter.addUser(b.text.length);
            const r = requestOf(b.text);
            if (r) cur = r;
          }
        }
      } else if (d.type === 'assistant' && d.message?.id) {
        const mid = d.message.id;
        const info = usages.get(mid);
        if (!info) continue;
        const u = info.u;
        if (!d.isSidechain) {
          if (lastCallId !== mid) {
            // the previous call's context reading belongs to the request it was made for
            if (lastCallId) flush(callReq, trigger);
            lastCallId = mid;
            callReq = cur;
          }
          meter.call({ id: mid, model: info.model, in: u.input_tokens ?? 0, out: u.output_tokens ?? 0, cr: u.cache_read_input_tokens ?? 0, cw: u.cache_creation_input_tokens ?? 0, cw5: u.cache_creation?.ephemeral_5m_input_tokens ?? 0 });
          for (const b of (Array.isArray(d.message.content) ? d.message.content : []) as { type?: string; text?: string; thinking?: string; id?: string; name?: string; input?: unknown }[]) {
            if (b.type === 'text') meter.addAssistant((b.text ?? '').length);
            else if (b.type === 'thinking') meter.addAssistant((b.thinking ?? '').length);
            else if (b.type === 'tool_use' && b.id) {
              meter.addToolUse(b.id, b.name ?? '', b.input, JSON.stringify(b.input ?? {}).length);
              triggerOf.set(b.id, toolKind(b.name ?? '', b.input).cat);
              if (triggerOf.size > 5000) triggerOf.delete(triggerOf.keys().next().value as string);
            }
          }
        }
        // money: once per message id, at the request the worker was on
        if (charged.has(mid)) continue;
        charged.add(mid);
        const cw5 = u.cache_creation?.ephemeral_5m_input_tokens ?? 0;
        const t: Tok = { in: u.input_tokens ?? 0, out: u.output_tokens ?? 0, cr: u.cache_read_input_tokens ?? 0, cw: u.cache_creation_input_tokens ?? 0, usd: 0 };
        t.usd = listUsd(info.model, { ...t, cw5 });
        any = true;
        computed += t.usd;
        if (!inWindow) continue;
        calls++;
        total.t = addTok(total.t, t);
        models[info.model] = addTok(models[info.model] ?? zeroTok(), t);
        const q = req(cur ?? bucket);
        q.sessions.add(sid);
        q.total = addTok(q.total, t);
        q.models[info.model] = addTok(q.models[info.model] ?? zeroTok(), t);
        const day = at.slice(0, 10);
        q.days[day] = (q.days[day] ?? 0) + t.usd;
        const bd = (extra.byDay[day] ??= {});
        bd[info.model] = (bd[info.model] ?? 0) + t.usd;
        q.calls++;
        const ctx = t.in + t.cr + t.cw;
        q.ctxSum += ctx;
        q.ctxMax = Math.max(q.ctxMax, ctx);
        if (at < q.firstAt) q.firstAt = at;
        if (at > q.lastAt) q.lastAt = at;
        const trip = (q.trips[info.side ? 'subagent' : trigger] ??= { n: 0, usd: 0 });
        trip.n++;
        trip.usd += t.usd;
        // a context written again after the cache went cold: a call that wrote most of its context after a pause of an hour
        const gap = lastCallAt ? Date.parse(at) - lastCallAt : 0;
        if (!info.side && gap > 55 * 60_000 && t.cw > 0.5 * ctx && ctx > 50_000) q.rewriteUsd += listUsd(info.model, { cw: t.cw, cw5 }) - listUsd(info.model, { cr: t.cw });
        if (!info.side) {
          const gapMs = lastCallAt ? Date.parse(at) - lastCallAt : 0;
          if (lastCallAt) {
            const gb = (extra.gaps[gapBucket(gapMs)] ??= { n: 0, usd: 0 });
            gb.n++;
            gb.usd += t.usd;
          }
          const cb = (extra.ctx[ctxBucket(ctx)] ??= { n: 0, usd: 0 });
          cb.n++;
          cb.usd += t.usd;
          extra.thinking.think += u.output_tokens_details?.thinking_tokens ?? 0;
          extra.thinking.out += t.out;
          if (info.model.startsWith('claude-opus')) {
            extra.sonnet.real += t.usd;
            extra.sonnet.asSonnet += listUsd('claude-sonnet-5-5', { ...t, cw5 });
            extra.sonnet.calls++;
          }
          if (gapMs > 55 * 60_000 && t.cw > 0.5 * ctx && ctx > 50_000) {
            extra.cold.n++;
            extra.cold.usd += t.usd;
            extra.cold.extra += listUsd(info.model, { cw: t.cw, cw5 }) - listUsd(info.model, { cr: t.cw });
          }
          // the model: the same calls with the context capped by compaction
          const newTok = t.cw + t.in;
          const growth = prevCtx && ctx >= prevCtx * 0.6 ? ctx - prevCtx : ctx;
          for (const T of SIM_AT) {
            let s = prevCtx ? (simCtx[T] ?? ctx) + growth : ctx;
            const e = extra.sim[T];
            if (s > T) {
              e.compactions++;
              e.sim += listUsd(info.model, { cr: s, cw: 16_000, out: 6_000 });
              s = SIM_AFTER;
            }
            simCtx[T] = s;
            e.real += t.usd;
            e.sim += listUsd(info.model, { cr: Math.max(0, s - newTok), cw: Math.min(newTok, s), out: t.out });
          }
          prevCtx = ctx;
          lastCtx = ctx;
        }
        if (!info.side) lastCallAt = Date.parse(at);
      }
    }
    if (lastCallId) flush(callReq, trigger);
    if (any) {
      sessions++;
      const sb = lastCtx > 700_000 ? '700k+' : lastCtx > 400_000 ? '400-700k' : lastCtx > 200_000 ? '200-400k' : lastCtx > 100_000 ? '100-200k' : '0-100k';
      extra.sessionsOver[sb] = (extra.sessionsOver[sb] ?? 0) + 1;
      check.push({ session: sid, computed, cli });
    }
  }
  return { requests: [...reqs.values()], sessions, calls, total: total.t, check, models, extra };
}
const triggerOf = new Map<string, string>();
const safeDir = (d: string): string[] => {
  try {
    return fs.readdirSync(d);
  } catch {
    return [];
  }
};

const pct = (x: number) => `${Math.round(x * 100)}%`;

export function render(r: Result, days: number, top: number): string {
  const out: string[] = [];
  const reqs = r.requests.filter((q) => q.total.usd > 0);
  const sum = r.total.usd;
  const comp = r.check.reduce((a, c) => a + c.computed, 0);
  const cli = r.check.filter((c) => c.cli > 0);
  out.push(`${r.sessions} sessions, ${r.calls} model calls in the last ${days} days: ${fmtUsd(sum)} at list prices (in ${fmtTokens(r.total.in)}, out ${fmtTokens(r.total.out)}, cache read ${fmtTokens(r.total.cr)}, cache write ${fmtTokens(r.total.cw)}).`);
  out.push(`Cache reads ${fmtUsd(listUsdOf(r, 'cr'))} (${pct(listUsdOf(r, 'cr') / sum)}), cache writes ${fmtUsd(listUsdOf(r, 'cw'))} (${pct(listUsdOf(r, 'cw') / sum)}), output ${fmtUsd(listUsdOf(r, 'out'))} (${pct(listUsdOf(r, 'out') / sum)}), uncached input ${fmtUsd(listUsdOf(r, 'in'))}.`);
  out.push(`By model: ${Object.entries(r.models).sort((a, b) => b[1].usd - a[1].usd).map(([m, t]) => `${m} ${fmtUsd(t.usd)} (${pct(t.usd / sum)}, ${fmtTokens(t.in + t.out + t.cr + t.cw)} tokens)`).join('; ')}.`);
  if (cli.length) out.push(`Check against the CLI's own cost-state totals (${cli.length} sessions that have one; whole-session totals, so a session that began before the window differs): computed ${fmtUsd(cli.reduce((a, c) => a + c.computed, 0))} vs CLI ${fmtUsd(cli.reduce((a, c) => a + c.cli, 0))}.`);
  void comp;
  const ranked = reqs.sort((a, b) => b.total.usd - a.total.usd);
  out.push('', `Top ${top} requests by cost:`);
  for (const [i, q] of ranked.slice(0, top).entries()) {
    const csum = Object.values(q.cats).reduce((a, c) => a + c.usd, 0);
    const cats = Object.entries(q.cats).sort((a, b) => b[1].usd - a[1].usd).slice(0, 6).map(([k, v]) => `${k} ${pct(v.usd / csum)}`).join(', ');
    const trips = Object.entries(q.trips).sort((a, b) => b[1].usd - a[1].usd).slice(0, 5).map(([k, v]) => `${k} ${v.n} calls ${fmtUsd(v.usd)}`).join('; ');
    out.push(`${i + 1}. ${q.id} ${fmtUsd(q.total.usd)} [${q.title ? kindOfWork({ title: q.title, brief: '', source: undefined, delegation: undefined }) : '?'}] "${q.title.slice(0, 80)}": ${q.sessions.size} session(s), ${q.calls} calls, mean context ${fmtTokens(q.ctxSum / Math.max(1, q.calls))}, largest ${fmtTokens(q.ctxMax)}; read ${fmtTokens(q.total.cr)}, written ${fmtTokens(q.total.cw)}, out ${fmtTokens(q.total.out)}`);
    out.push(`     where the context cost went: ${cats}`);
    out.push(`     calls by what made them necessary: ${trips}${q.rereads ? `; ${q.rereads} re-reads (${q.rereadAfterCompact} after a compaction)` : ''}${q.rewriteUsd > 0.05 ? `; ${fmtUsd(q.rewriteUsd)} extra to write contexts again after the cache went cold` : ''}`);
  }
  // kinds
  const kinds = new Map<string, { usd: number; n: number }>();
  for (const q of ranked) {
    const k = q.id.startsWith('_') ? 'no request' : q.title ? kindOfWork({ title: q.title, brief: '', source: undefined, delegation: undefined }) : 'unknown';
    const e = kinds.get(k) ?? { usd: 0, n: 0 };
    e.usd += q.total.usd;
    e.n++;
    kinds.set(k, e);
  }
  out.push('', 'By kind of work:');
  for (const [k, v] of [...kinds].sort((a, b) => b[1].usd - a[1].usd)) out.push(`- ${k}: ${fmtUsd(v.usd)} over ${v.n} request(s), ${fmtUsd(v.usd / v.n)} each`);
  // where
  let cats: Cats = {};
  for (const q of ranked) cats = addCats(cats, q.cats);
  const csum = Object.values(cats).reduce((a, c) => a + c.usd, 0);
  out.push('', `Where the money goes inside sessions (context shares by characters, applied to ${fmtUsd(csum)} of main-loop calls):`);
  for (const [k, v] of Object.entries(cats).sort((a, b) => b[1].usd - a[1].usd).slice(0, 12)) out.push(`- ${k}: ${pct(v.usd / csum)} (${fmtUsd((v.usd / csum) * sum)} of ${fmtUsd(sum)}) ${CATEGORY_LABEL[k] ?? ''}`);
  const trip: Record<string, { n: number; usd: number }> = {};
  for (const q of ranked) for (const [k, v] of Object.entries(q.trips)) {
    const e = (trip[k] ??= { n: 0, usd: 0 });
    e.n += v.n;
    e.usd += v.usd;
  }
  out.push('', 'Calls by what made them necessary (the kind of tool result they follow; each call re-reads the whole context):');
  for (const [k, v] of Object.entries(trip).sort((a, b) => b[1].usd - a[1].usd).slice(0, 12)) out.push(`- ${k}: ${v.n} calls, ${fmtUsd(v.usd)} (${pct(v.usd / sum)}), ${fmtUsd(v.usd / v.n)} a call`);
  const rr = ranked.reduce((a, q) => a + q.rereads, 0);
  const rra = ranked.reduce((a, q) => a + q.rereadAfterCompact, 0);
  const rew = ranked.reduce((a, q) => a + q.rewriteUsd, 0);
  out.push('', `Re-reads of a range already read: ${rr} (${rra} after a compaction). Contexts written again after a pause of over an hour: ${fmtUsd(rew)} extra over reading them from the cache.`);
  const comps = ranked.reduce((a, q) => a + q.compactions, 0);
  out.push(`Compactions seen: ${comps}.`);
  const x = r.extra;
  out.push('', 'Calls and dollars by the size of the context they read:');
  for (const k of ['0-100k', '100-200k', '200-400k', '400-700k', '700k+']) if (x.ctx[k]) out.push(`- ${k}: ${x.ctx[k].n} calls, ${fmtUsd(x.ctx[k].usd)} (${pct(x.ctx[k].usd / sum)})`);
  out.push(`Sessions by the context they ended with: ${Object.entries(x.sessionsOver).map(([k, v]) => `${k} ${v}`).join(', ')}.`);
  out.push('', 'Calls by the pause before them:');
  for (const k of ['under 1 min', '1-5 min', '5-60 min', 'over 1 hour']) if (x.gaps[k]) out.push(`- ${k}: ${x.gaps[k].n} calls, ${fmtUsd(x.gaps[k].usd)} (${pct(x.gaps[k].usd / sum)}), ${fmtUsd(x.gaps[k].usd / x.gaps[k].n)} a call`);
  out.push(`After a pause of over an hour, ${x.cold.n} calls wrote most of a context again: ${fmtUsd(x.cold.usd)} for those calls, ${fmtUsd(x.cold.extra)} more than reading it from the cache.`);
  out.push('', 'Modelled from the measured growth of each call: the same calls if a session compacted whenever its context passed a threshold (down to 85k, which is the base, a summary and some files read again):');
  for (const T of SIM_AT) {
    const e = x.sim[T];
    out.push(`- at ${fmtTokens(T)}: ${fmtUsd(e.real)} -> ${fmtUsd(e.sim)} (saves ${fmtUsd(e.real - e.sim)}, ${pct((e.real - e.sim) / e.real)}) with ${e.compactions} compactions`);
  }
  out.push('', 'Dollars by day and model:');
  for (const [d, m] of Object.entries(x.byDay).sort((a, b) => a[0].localeCompare(b[0]))) out.push(`- ${d}: ${Object.entries(m).filter(([, v]) => v >= 0.5).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k.replace('claude-', '')} ${fmtUsd(v)}`).join(', ')}`);
  out.push('', `Opus calls repriced as Sonnet 5.5: ${fmtUsd(x.sonnet.real)} -> ${fmtUsd(x.sonnet.asSonnet)} over ${x.sonnet.calls} calls (saves ${fmtUsd(x.sonnet.real - x.sonnet.asSonnet)}).`);
  out.push(`Thinking: ${fmtTokens(x.thinking.think)} of ${fmtTokens(x.thinking.out)} output tokens (${pct(x.thinking.think / Math.max(1, x.thinking.out))}).`);
  return out.join('\n');
}

const listUsdOf = (r: Result, k: 'cr' | 'cw' | 'out' | 'in') => {
  let s = 0;
  for (const [m, t] of Object.entries(r.models)) s += listUsd(m, k === 'cw' ? { cw: t.cw } : k === 'cr' ? { cr: t.cr } : k === 'out' ? { out: t.out } : { in: t.in });
  return s;
};

if (process.argv[1] && path.basename(process.argv[1]) === 'spend-claude.ts') {
  const a = parseArgs(process.argv.slice(2));
  const result = analyze(a.root, Date.now() - a.days * 86_400_000);
  console.log(render(result, a.days, a.top));
  if (a.json) fs.writeFileSync(a.json, JSON.stringify({ ...result, requests: result.requests.map((q) => ({ ...q, sessions: [...q.sessions] })) }, null, 1));
}
