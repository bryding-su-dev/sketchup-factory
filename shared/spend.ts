// What a request costs (w859, asked by Lothsahn: "track the per workitem spend as well as the transcript so we can
// optimize token usage"). The pure half, shared by the agent sessions (which measure), the portal (which stores) and
// the web (which shows): the token record, the list prices, and the ContextMeter that says where a session's context
// tokens go. docs/spend.md explains how the numbers are taken and attributed.
//
// Dollars and tokens come from Claude Code's own per-turn usage (the SDK result's modelUsage and total_cost_usd), never
// from an estimate. Only the split of a session's context among kinds of content (ContextMeter) is an estimate: Claude
// Code reports how big each call's context was, not what is in it, so the content is counted in characters and the
// calls' real token counts are shared out in proportion. It says so wherever it is shown.

/** Tokens and dollars of one model, input counted as the API does: `in` is the uncached part, `cr` cache reads, `cw` cache writes. */
export interface Tok {
  in: number;
  out: number;
  cr: number;
  cw: number;
  usd: number;
}
export const zeroTok = (): Tok => ({ in: 0, out: 0, cr: 0, cw: 0, usd: 0 });
export function addTok(a: Tok, b: Partial<Tok>): Tok {
  return { in: a.in + (b.in ?? 0), out: a.out + (b.out ?? 0), cr: a.cr + (b.cr ?? 0), cw: a.cw + (b.cw ?? 0), usd: a.usd + (b.usd ?? 0) };
}
export const scaleTok = (a: Tok, f: number): Tok => ({ in: a.in * f, out: a.out * f, cr: a.cr * f, cw: a.cw * f, usd: a.usd * f });
export const sumTok = (xs: Iterable<Tok>): Tok => {
  let t = zeroTok();
  for (const x of xs) t = addTok(t, x);
  return t;
};
export type ModelTok = Record<string, Tok>;
export function addModels(a: ModelTok, b: ModelTok, f = 1): ModelTok {
  const out: ModelTok = { ...a };
  for (const [m, t] of Object.entries(b)) out[m] = addTok(out[m] ?? zeroTok(), f === 1 ? t : scaleTok(t, f));
  return out;
}
/** Everything in a Tok that counts as tokens read or written (not dollars). */
export const allTokens = (t: Tok) => t.in + t.out + t.cr + t.cw;

/**
 * The SDK's per-model totals for one query() call, cumulative over its turns (result.modelUsage): this is what the
 * result event carries. A resumed conversation continues from the totals it saved, so the first result already holds the
 * earlier turns; the portal takes differences against the last totals it saw (server/spend.ts).
 */
export type Cumulative = ModelTok;

/** Where the context tokens of the calls in a turn went, by kind of content (ContextMeter). `usd` is at list prices. */
export interface CatTok {
  usd: number;
  /** Input-side tokens (read, written, uncached) charged to it. */
  tok: number;
}
export type Cats = Record<string, CatTok>;

/** One turn's reading of its context (ContextMeter.drain). */
export interface MeterTurn {
  /** Model calls of the main loop in the turn (a subagent's own calls are not counted). */
  calls: number;
  cats: Cats;
  /** Reads of a range of a file this session already read (Read, sed -n, cat): how many, their characters, those after a compaction. */
  reread?: { n: number; chars: number; afterCompact: number };
  /** The largest context a call of the turn read, and the last one's. */
  ctxMax: number;
  ctxEnd: number;
  /** A compaction (or /clear) shrank the context in this turn. */
  compacted?: boolean;
}

/** What a result event carries (TranscriptEvent 'result' and 'system'): the SDK's cumulative totals, the main loop's own turn usage, the context reading. */
export interface TurnUsage {
  cum?: Cumulative;
  /** result.usage: the main loop's tokens in this turn, no dollars, no subagents. A fallback for the first result of a session seen without a baseline. */
  main?: { in: number; out: number; cr: number; cw: number };
  meter?: MeterTurn;
  /** The first result of a new agent process whose totals started again from zero (the SDK did not carry the saved ones): `cum` is this turn in full. */
  restarted?: boolean;
}

/** The kinds of content a context holds, in the order they are shown. The list comes from what the tool results of a week of workers held. */
export const CATEGORIES = [
  'base',
  'summary',
  'brief',
  'assistant',
  'file-read',
  'reread',
  'search',
  'git',
  'ci-poll',
  'build-test',
  'shell',
  'edit',
  'mcp-unity',
  'mcp-machine',
  'web',
  'subagent',
  'other',
] as const;
export type Category = (typeof CATEGORIES)[number];
export const CATEGORY_LABEL: Record<string, string> = {
  base: 'Base context (system prompt, tool definitions, CLAUDE.md, skill lists, reminders)',
  summary: 'Summary left by a compaction',
  brief: 'Messages to the agent (briefs, follow-ups, harness notices)',
  assistant: "The agent's own text, thinking and tool calls (output tokens included)",
  'file-read': 'File reads (Read, sed -n, cat, head, tail)',
  reread: 'Re-reads of a range of a file it already read',
  search: 'Searches (Grep, Glob, grep, find, ls)',
  git: 'git and gh (not CI)',
  'ci-poll': 'CI and wait polling (gh pr checks, gh run, sleep and until loops, Monitor)',
  'build-test': 'Builds, tests and scripts (python, node, npm, dotnet, tsc, unity-slot, Unity tests)',
  shell: 'Other shell output',
  edit: 'Edits and writes',
  'mcp-unity': 'Unity editor tools and MCP resources',
  'mcp-machine': 'Machine tools (read_work, unity, publish_review, wake_me, blocked_on, …)',
  web: 'Web fetch and search',
  subagent: 'Subagent results',
  other: 'Other tools',
};

/**
 * Characters of tool output and messages per newly written context token, MEASURED on a week of beast's sessions: a least-squares
 * fit over 52,187 calls of the tokens a call wrote (cache write plus uncached input) on the characters of tool results and
 * messages since the previous call and that call's output tokens gave 0.431 tokens per character (2.32 characters per token),
 * 1.01 tokens per output token and 96 tokens per call of nothing visible (docs/spend.md "Calibration"). It is lower than the 3 to 4
 * of plain text because paths, JSON and escapes tokenize densely. The 96 a call (system reminders, hook output) fall in `base`.
 */
export const CHARS_PER_TOKEN = 2.3;
/** Output tokens per visible character of the agent's text and tool calls: thinking is output no transcript shows (MEASURED on the same week: 30.8M output tokens for 40.9M visible characters). */
export const OUTPUT_TOKENS_PER_CHAR = 0.75;
/** What an image in a tool result costs the context, in characters at CHARS_PER_TOKEN (a guess: about 1,500 tokens). */
export const IMAGE_CHARS = 3200;

// ---------------------------------------------------------------------------------------------------------------------
// List prices, USD per million tokens (the claude-api skill's table, 2026-10-06; cache reads 0.1x input except where the
// table says otherwise, cache writes 1.25x input for 5 minutes and 2x for 1 hour). Used ONLY to weigh the shares of a
// session's context among categories and to price the backfill's estimates: every dollar the portal shows as measured
// is the SDK's own costUSD.
// ---------------------------------------------------------------------------------------------------------------------
export interface Price {
  in: number;
  out: number;
  cr: number;
}
const PRICES: [prefix: string, p: Price][] = [
  ['claude-fable', { in: 10, out: 50, cr: 0.25 }],
  ['claude-mythos', { in: 10, out: 50, cr: 0.25 }],
  ['claude-opus-5-5', { in: 4, out: 20, cr: 0.2 }],
  ['claude-opus', { in: 5, out: 25, cr: 0.5 }],
  ['claude-sonnet-5', { in: 2, out: 10, cr: 0.2 }],
  ['claude-sonnet', { in: 3, out: 15, cr: 0.3 }],
  ['claude-haiku-5', { in: 0.1, out: 0.5, cr: 0.01 }],
  ['claude-haiku', { in: 1, out: 5, cr: 0.1 }],
];
const DEFAULT_PRICE: Price = { in: 2, out: 10, cr: 0.2 };
export function priceOf(model: string | undefined): Price {
  const m = (model ?? '').toLowerCase();
  for (const [prefix, p] of PRICES) if (m.startsWith(prefix) || m.includes(`/${prefix}`)) return p;
  // an alias the CLI reports ("opus", "sonnet", "haiku", with or without [1m])
  if (m.startsWith('opus')) return { in: 4, out: 20, cr: 0.2 };
  if (m.startsWith('haiku')) return { in: 0.1, out: 0.5, cr: 0.01 };
  if (m.startsWith('fable')) return { in: 10, out: 50, cr: 0.25 };
  return DEFAULT_PRICE;
}
/** The list price of some tokens: cache writes at the 1-hour rate (the CLI writes 1-hour entries) unless `cw5` says 5-minute. */
export function listUsd(model: string | undefined, t: Partial<Tok> & { cw5?: number }): number {
  const p = priceOf(model);
  const cw5 = t.cw5 ?? 0;
  const cw1 = (t.cw ?? 0) - cw5;
  return ((t.in ?? 0) * p.in + (t.out ?? 0) * p.out + (t.cr ?? 0) * p.cr + cw1 * 2 * p.in + cw5 * 1.25 * p.in) / 1e6;
}

// ---------------------------------------------------------------------------------------------------------------------
// What a tool result is: the categories of the week's tool output
// ---------------------------------------------------------------------------------------------------------------------

export interface ToolKind {
  cat: Category;
  /** With a file read: the file and the range, to see the same range read again. */
  readKey?: string;
}

/** `cd <dir> &&` / `cd <dir>;` at the start of a command is only where it runs. */
export function stripCd(cmd: string): string {
  let c = cmd.trim();
  for (let i = 0; i < 3; i++) {
    const m = /^cd\s+("[^"]*"|'[^']*'|\S+)\s*(?:&&|;)\s*/.exec(c);
    if (!m) break;
    c = c.slice(m[0].length).trim();
  }
  return c;
}

const normPath = (p: string) => p.replace(/\\/g, '/').replace(/^["']|["']$/g, '').toLowerCase();

/** The file a shell reader (sed -n 'a,bp' f, cat f, head -n 20 f, Get-Content f) reads, with its range. */
function shellRead(c: string): string | undefined {
  const m = /^(sed|cat|head|tail|type|Get-Content|gc|bat|nl)\b(.*)$/s.exec(c);
  if (!m) return undefined;
  // only the first command of a pipeline is the read
  const first = m[2].split(/\s*(?:\||&&|;|>)\s*/)[0];
  const toks = first.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  const range = m[1] === 'sed' ? /(\d+),(\d+)p/.exec(first) : m[1] === 'head' || m[1] === 'tail' ? /-n?\s*(\d+)/.exec(first) : undefined;
  for (let i = toks.length - 1; i >= 0; i--) {
    const t = toks[i];
    if (t.startsWith('-') || /^['"]?\d+(,\d+)?p?['"]?$/.test(t) || /^['"]\d+/.test(t)) continue;
    if (m[1] === 'sed' && /^['"]?[0-9$,]*[pdqs]/.test(t) && !/[./\\]/.test(t)) continue;
    return `${normPath(t)}:${m[1]}${range ? `:${range[1]}${range[2] ? `-${range[2]}` : ''}` : ''}`;
  }
  return undefined;
}

const CI = /\bgh\s+(pr\s+checks|run\s+(view|watch|list)|workflow\s+view)\b|\bgh\s+api\b[^\n]*\b(check-runs|check-suites|actions\/runs)\b|\b(until|while)\b[^\n]*\b(gh|sleep)\b|^\s*sleep\s+\d|\bStart-Sleep\b/;
const BUILD = /^(python3?|py|node|npm|npx|pnpm|yarn|tsc|dotnet|cargo|make|cmake|pytest|unity-slot|bash|sh|powershell|pwsh|\.\/|\.\\|ffsb|fffctl|msbuild|gradle|go)\b/;
const SEARCH = /^(grep|egrep|rg|find|ls|dir|tree|Select-String|Get-ChildItem|fd|ag|locate|wc|which|where)\b/;
const GIT = /^(git|gh)\b/;

/** What kind of content a tool call's result is, from the tool name and input. */
export function toolKind(tool: string, input: unknown): ToolKind {
  const inp = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const t = tool;
  if (t === 'Read') {
    const p = typeof inp.file_path === 'string' ? inp.file_path : '';
    return { cat: 'file-read', readKey: `${normPath(p)}:read:${inp.offset ?? 0}-${inp.limit ?? ''}${inp.pages ? `:p${inp.pages}` : ''}` };
  }
  if (t === 'Grep' || t === 'Glob' || t === 'LS') return { cat: 'search' };
  if (t === 'Edit' || t === 'Write' || t === 'NotebookEdit' || t === 'MultiEdit') return { cat: 'edit' };
  if (t === 'WebFetch' || t === 'WebSearch') return { cat: 'web' };
  if (t === 'Agent' || t === 'Task') return { cat: 'subagent' };
  if (t === 'Monitor' || t === 'ScheduleWakeup' || t === 'TaskOutput' || t === 'BashOutput' || t === 'TaskStop') return { cat: 'ci-poll' };
  if (t === 'Bash' || t === 'PowerShell') {
    const c = stripCd(typeof inp.command === 'string' ? inp.command : '');
    if (CI.test(c)) return { cat: 'ci-poll' };
    const key = shellRead(c);
    if (key) return { cat: 'file-read', readKey: key };
    if (GIT.test(c)) return { cat: 'git' };
    if (SEARCH.test(c)) return { cat: 'search' };
    if (BUILD.test(c)) return { cat: 'build-test' };
    return { cat: 'shell' };
  }
  if (t.startsWith('mcp__')) {
    if (/UnityMCP|unity/i.test(t)) return { cat: 'mcp-unity' };
    if (/wake_me|blocked_on|waiting_on_person|cancel_wake/.test(t)) return { cat: 'ci-poll' };
    return { cat: 'mcp-machine' };
  }
  if (t === 'ReadMcpResourceTool' || t === 'ListMcpResourcesTool') return { cat: 'mcp-unity' };
  return { cat: 'other' };
}

// ---------------------------------------------------------------------------------------------------------------------
// ContextMeter
// ---------------------------------------------------------------------------------------------------------------------

/** One model call's usage, as the assistant message reports it. */
export interface CallUsage {
  id: string;
  model?: string;
  in: number;
  out: number;
  cr: number;
  cw: number;
  /** Of `cw`, the 5-minute entries (the rest are 1-hour). */
  cw5?: number;
}

/**
 * Says where the context tokens of a session go. Feed it what the session sees in order: the user messages, the
 * assistant's content blocks, each tool call and its result, and each model call's usage. For every call it shares the call's real
 * token counts among the kinds of content the context holds, by characters: cache reads go to what was in the context
 * before the call, cache writes and uncached input to what is new since the previous call, and output tokens to the
 * agent's own text. What no content explains (the system prompt, tool definitions, CLAUDE.md, reminders) is `base`. A
 * context that suddenly shrinks (a compaction, a /clear) starts a new epoch: the summary is `summary` and files read
 * again after it are counted in `reread.afterCompact`.
 *
 * Characters are the estimate; the totals per call are exact. A result's real tokens cannot be told apart from another's by
 * Claude Code's numbers, so the split inside a call is proportional to characters (CHARS_PER_TOKEN only fixes the base).
 */
export class ContextMeter {
  /** Characters of each kind in the context before the next call. */
  private held = new Map<string, number>();
  /** Characters added since the last call: the next call writes them. */
  private fresh = new Map<string, number>();
  private readonly tools = new Map<string, ToolKind>();
  private readonly readSeen = new Set<string>();
  private readSeenBeforeCompact = new Set<string>();
  private cur?: { id: string; model?: string; out: number };
  private lastCtx = 0;
  private turn = blankTurn();
  private compactedOnce = false;

  /** Text that goes into the context from outside: a message to the agent. */
  addUser(chars: number) {
    this.add('brief', chars);
  }
  /**
   * The agent's text, thinking or a tool call's input: nothing to add. The next call writes the previous call's output tokens
   * to the context, and those are exact (a call's usage), thinking included; they are added when the call is seen.
   */
  addAssistant(_chars: number) {}
  addToolUse(id: string, name: string, input: unknown, _inputChars: number) {
    this.tools.set(id, toolKind(name, input));
    if (this.tools.size > 4000) this.tools.delete(this.tools.keys().next().value as string);
  }
  addToolResult(id: string, chars: number, images = 0) {
    const kind = this.tools.get(id) ?? { cat: 'other' as Category };
    this.tools.delete(id);
    const n = chars + images * IMAGE_CHARS;
    let cat: string = kind.cat;
    if (kind.cat === 'file-read' && kind.readKey) {
      const again = this.readSeen.has(kind.readKey);
      // read before the last compaction and not since: the summary did not keep it, so it is read again
      const afterCompact = !again && this.readSeenBeforeCompact.has(kind.readKey);
      if (again || afterCompact) {
        cat = 'reread';
        const r = (this.turn.reread ??= { n: 0, chars: 0, afterCompact: 0 });
        r.n++;
        r.chars += n;
        if (afterCompact) r.afterCompact++;
      }
      this.readSeen.add(kind.readKey);
    }
    this.add(cat, n);
  }
  private add(cat: string, chars: number) {
    if (chars > 0) this.fresh.set(cat, (this.fresh.get(cat) ?? 0) + chars);
  }

  /**
   * A model call of the main loop. Called on each assistant message; the first one of a message id counts the call, later
   * ones (the message's other content blocks) only raise its output tokens.
   */
  call(u: CallUsage) {
    if (this.cur && this.cur.id === u.id) {
      this.chargeOutput(u.out - this.cur.out, u.model, true);
      this.cur.out = Math.max(this.cur.out, u.out);
      return;
    }
    const ctx = u.in + u.cr + u.cw;
    if (ctx <= 0) return;
    this.cur = { id: u.id, model: u.model, out: u.out };
    this.chargeOutput(u.out, u.model, false);
    this.turn.calls++;
    this.turn.ctxMax = Math.max(this.turn.ctxMax, ctx);
    this.turn.ctxEnd = ctx;
    if (this.lastCtx > 0 && ctx < this.lastCtx * 0.6) {
      // The context shrank: a compaction or a /clear. What was held is gone; what the summary holds is not known by content.
      this.turn.compacted = true;
      this.compactedOnce = true;
      for (const k of this.readSeen) this.readSeenBeforeCompact.add(k);
      this.readSeen.clear();
      this.held = new Map([['summary', 0]]);
    }
    this.lastCtx = ctx;
    const toks = (m: Map<string, number>) => [...m].map(([k, v]) => [k, v / CHARS_PER_TOKEN] as const);
    const heldEst = toks(this.held);
    const freshEst = toks(this.fresh);
    const heldSum = heldEst.reduce((a, [, v]) => a + v, 0);
    const freshSum = freshEst.reduce((a, [, v]) => a + v, 0);
    const newTok = u.cw + u.in;
    // New content: the call wrote cw and read in; if more is explained than was written, the estimate is scaled down;
    // if less (the system prompt on the first call, reminders), the rest is base.
    const shares: Record<string, { r: number; w: number }> = {};
    const give = (cat: string, r: number, w: number) => {
      const s = (shares[cat] ??= { r: 0, w: 0 });
      s.r += r;
      s.w += w;
    };
    const fscale = freshSum > newTok ? newTok / freshSum : 1;
    for (const [k, v] of freshEst) give(k, 0, v * fscale);
    give('base', 0, Math.max(0, newTok - freshSum * fscale));
    const hscale = heldSum > u.cr ? u.cr / heldSum : 1;
    for (const [k, v] of heldEst) give(k, v * hscale, 0);
    give('base', Math.max(0, u.cr - heldSum * hscale), 0);
    const p = priceOf(u.model);
    const cw5 = Math.min(u.cw, u.cw5 ?? 0);
    const wPrice = u.cw + u.in > 0 ? (u.in * p.in + (u.cw - cw5) * 2 * p.in + cw5 * 1.25 * p.in) / (u.cw + u.in) : p.in;
    for (const [k, s] of Object.entries(shares)) {
      const c = (this.turn.cats[k] ??= { usd: 0, tok: 0 });
      c.usd += (s.r * p.cr + s.w * wPrice) / 1e6;
      c.tok += s.r + s.w;
    }
    // Everything this call read is in the context of the next one, and so is what it wrote (added by chargeOutput: first message of the call below).
    for (const [k, v] of this.fresh) this.held.set(k, (this.held.get(k) ?? 0) + v);
    this.fresh = new Map();
    this.add('assistant', u.out * CHARS_PER_TOKEN);
  }
  /**
   * The output of a call is the agent's own text: charged when first seen, and again for what a later message of the same call adds.
   * It reaches the context with the next call; a rise after the call was seen is added to what that call will write.
   */
  private chargeOutput(tokens: number, model: string | undefined, late: boolean) {
    if (tokens <= 0) return;
    const c = (this.turn.cats.assistant ??= { usd: 0, tok: 0 });
    c.usd += (tokens * priceOf(model).out) / 1e6;
    c.tok += tokens;
    if (late) this.add('assistant', tokens * CHARS_PER_TOKEN);
  }

  /** The reading of the turn that just ended, and a fresh start for the next one (what the context holds is kept). */
  drain(): MeterTurn {
    const t = this.turn;
    this.turn = blankTurn();
    this.cur = undefined;
    return t;
  }
  get compacted() {
    return this.compactedOnce;
  }
}

const blankTurn = (): MeterTurn => ({ calls: 0, cats: {}, ctxMax: 0, ctxEnd: 0 });

export function addCats(a: Cats, b: Cats, f = 1): Cats {
  const out: Cats = { ...a };
  for (const [k, v] of Object.entries(b)) {
    const o = out[k] ?? { usd: 0, tok: 0 };
    out[k] = { usd: o.usd + v.usd * f, tok: o.tok + v.tok * f };
  }
  return out;
}

/** 1,234,567 → "1.2M", 12,345 → "12k". */
export function fmtTokens(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e9) return `${(n / 1e9).toFixed(a >= 1e10 ? 0 : 1)}B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(a >= 1e4 ? 0 : 1)}k`;
  return String(Math.round(n));
}
/** "$12.34", "$0.05", "$1,234". */
export function fmtUsd(n: number): string {
  if (n >= 1000) return `$${Math.round(n).toLocaleString('en-US')}`;
  if (n >= 100) return `$${n.toFixed(0)}`;
  return `$${n.toFixed(2)}`;
}

// ---------------------------------------------------------------------------------------------------------------------
// What the portal stores and answers (server/spend.ts); here so the web can type its replies
// ---------------------------------------------------------------------------------------------------------------------

export type SpendRole = 'worker' | 'dispatcher' | 'personal' | 'ops' | 'standing';

/** How a turn was tied to a request: the `[about]` line, the request the worker was last sent, the ids a message named, or none. */
export type How = 'about' | 'link' | 'message' | 'bucket' | 'backfill';

/** One session's spend, over every request it served. */
export interface SessionSpend {
  id: string;
  role: SpendRole;
  title: string;
  machine?: string;
  /** Who it worked for (their display name), when known. */
  person?: string;
  firstAt: string;
  lastAt: string;
  turns: number;
  total: Tok;
  models: ModelTok;
  /** The part of `total` that is estimated (see Estimated). */
  estimated: Tok;
  /** The SDK's cumulative totals at the last result, to take differences against. */
  cum?: ModelTok;
  lastCost?: number;
  /** usd by request (or bucket) id. */
  requests: Record<string, number>;
  cats: Cats;
  calls: number;
  ctxMax: number;
  compactions: number;
  reread?: { n: number; chars: number; afterCompact: number };
  /** The transcript: kept as is, compressed, or pruned (with when). The numbers above stay either way. */
  transcript?: { state: 'full' | 'gz' | 'pruned'; bytes?: number; prunedAt?: string };
  /** The seq of the first transcript event recorded live; the backfill takes only the events before it. */
  liveFrom?: number;
  /** The backfill has read this session's transcript. */
  backfilled?: boolean;
}

/** One request's spend (or a bucket's: ids starting with "_"). */
export interface RequestSpend {
  id: string;
  title: string;
  status?: string;
  kind: string;
  person?: string;
  firstAt: string;
  lastAt: string;
  closedAt?: string;
  turns: number;
  total: Tok;
  models: ModelTok;
  estimated: Tok;
  sessions: Record<string, { role: SpendRole; total: Tok; models: ModelTok; turns: number; how: Partial<Record<How, number>>; shared?: number }>;
  cats: Cats;
  calls: number;
  compactions: number;
  reread?: { n: number; chars: number; afterCompact: number };
  /** Tokens and dollars by UTC day, for a report over a window. */
  days: Record<string, Tok>;
}

export interface ReportOptions {
  /** Days back (default 7). */
  days?: number;
  top?: number;
  includeBuckets?: boolean;
}

export interface SpendReport {
  sinceDay: string;
  untilDay: string;
  total: Tok;
  estimated: Tok;
  /** Share of the window's dollars by model. */
  models: ModelTok;
  top: { id: string; title: string; kind: string; status?: string; person?: string; usd: number; tokens: Tok; estimatedUsd: number; sessions: number; closed: boolean; cats: { cat: string; usd: number; pct: number }[] }[];
  kinds: { kind: string; usd: number; requests: number; avg: number }[];
  /** Where the context tokens went across the window's requests, by category (list-price shares applied to the measured dollars). */
  where: { cat: string; label: string; usd: number; pct: number }[];
  /** Spend that is no request's: the dispatcher, orchestrators, ops, standing agents, unattributed. */
  buckets: { id: string; title: string; usd: number }[];
  measuredCats: number;
  reread?: { n: number; chars: number; afterCompact: number };
}


export interface DataGuardConfig {
  /** Days a transcript is kept after the last request it served closed (default 7). */
  retainDays: number;
  /** Compress idle transcripts from this share of the disk used (default 50). */
  gzipAtUsedPercent: number;
  /** Delete transcripts past their retention from this share (default 75). */
  pruneAtUsedPercent: number;
  /** Say so from this share, when the guard cannot get below (default 90). */
  alertAtUsedPercent: number;
  /** A transcript is idle (compressible) when untouched for this long (default 24). */
  gzipIdleHours: number;
  /** How often the guard runs, in minutes (default 60). */
  everyMinutes: number;
}
/** What the transcripts weigh now, how fast they grow and what 7 more days would add (the measurements docs/spend.md reports). */
export interface Footprint {
  at: string;
  files: number;
  bytes: number;
  gzFiles: number;
  gzBytes: number;
  /** Plain transcripts by the day they were started (file birth time, else last write), newest first, last 14 days. */
  perDay: { day: string; files: number; bytes: number }[];
  /** Average bytes a day over those days that had files. */
  growthPerDay: number;
  /** The largest ones. */
  biggest: { id: string; bytes: number }[];
  disk?: { usedBytes: number; totalBytes: number };
  /** Plain transcripts + 7 days' growth, and the same if every plain transcript were compressed at `gzipRatio`. */
  projected7d: { plain: number; compressed: number };
  gzipRatio?: number;
}


/** GET /api/spend/summary: the cost of each request the page holds. */
export interface SpendSummaryReply {
  requests: Record<string, { usd: number; in: number; out: number; cr: number; cw: number; sessions: number; estimatedUsd: number }>;
}
/** GET /api/spend/request/<id>: one request's spend with its sessions and what happens to their transcripts. */
export interface SpendRequestReply {
  request: RequestSpend | null;
  retainDays?: number;
  sessions: {
    id: string;
    role: SpendRole;
    title: string;
    machine?: string;
    share: RequestSpend['sessions'][string];
    transcript: NonNullable<SessionSpend['transcript']>;
    /** When its transcript may go (ISO), or null when it stays while the request is open or is a chat. */
    keptUntil: string | null;
    keptWhileOpen: boolean;
    hasTranscript: boolean;
  }[];
}
/** GET /api/spend/report: the analysis. */
export interface SpendReportReply {
  report: SpendReport;
  footprint: Footprint;
  guard: DataGuardConfig;
  backfill: { at: string; sessions: number; turns: number; usd: number } | null;
}
