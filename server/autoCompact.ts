// Automatic compaction of the orchestrators' conversations (w535; docs/orchestrators.md, "Compacting a conversation").
// Every turn sends the whole conversation again, so a turn costs about $0.20 per million tokens of context on Opus 5.5
// (cache reads), and Claude Code only compacts by itself near its 1M-token limit: measured on 2026-10-06 over the three
// live orchestrators' 6,950 turns, a turn started at 800k-1M tokens cost a median $0.20-0.36, one at 100k-150k
// $0.04-0.07. FF Factory compacts each orchestrator, the dispatcher included, between turns once its context passes
// orchestrator.compactAtTokens (default 200,000) or a turn costs orchestrator.compactAtTurnUsd (default $1) with the
// context at 100,000 tokens or more, with Claude Code's own /compact and a focus that keeps what is still open. An
// orchestrator may also ask for it itself (compact_conversation), which runs after its turn the same way.
import type { Config } from './config.ts';
import type { SessionInfo } from '../shared/types.ts';
import { COMPACT_FOCUS_CHARS, isMidTurn, type AutoCompaction, type SessionHandle, type SessionManager, type TurnEndMeta } from './sessions.ts';

/** The defaults: the context in tokens, and a turn's cost in USD (with the context at COST_TRIGGER_MIN_TOKENS or more). */
export const AUTO_COMPACT_DEFAULTS = { atTokens: 200_000, atTurnUsd: 1 } as const;

/** What set_app_config accepts for them, besides 0 (off). */
export const AUTO_COMPACT_LIMITS = { minTokens: 50_000, maxTokens: 900_000, minTurnUsd: 0.05, maxTurnUsd: 50 } as const;

/**
 * Below this context the cost trigger waits: a compaction cost about $0.17 at 276k tokens (measured, Lothsahn's /compact
 * on 2026-10-06) and leaves 30-50k, so under 100k it would save under $0.012 a model call.
 */
export const COST_TRIGGER_MIN_TOKENS = 100_000;

/** An automatic compaction waits this many turns after any compaction. */
export const MIN_TURNS_BETWEEN = 3;

/** After an automatic compaction that did not finish, the next automatic one waits this long. */
export const RETRY_AFTER_MS = 30 * 60_000;

/** How long after a turn's end the check waits, so a message sent with the turn's end goes first. */
export const SETTLE_MS = 2_000;

/** What a person's orchestrator keeps across an automatic compaction: Claude Code's /compact focus. */
export const PERSONAL_FOCUS =
  'Automatic compaction by FF Factory. Keep, exactly: every request still open (its wNNN id, title, state, the worker session id, its sandbox or machine, PR numbers, and what it waits on); every question you asked your person that they have not answered, and every question of theirs you have not answered yet; decisions, approvals and holds, each with the person who gave it; timers, heartbeat and wake_me check-ins you set, and why; anything you promised to report or check. Keep every id with what it is. Finished work: one line each at most. Your memory folder is unchanged, and list_work has the ledger.';

/** What the dispatcher keeps across an automatic compaction. */
export const DISPATCHER_FOCUS =
  'Automatic compaction by FF Factory. Keep, exactly: every open or queued request (its wNNN id, title, who asked, its state, the worker session id and sandbox or machine, PR numbers, and what it waits on: a slot, a check, a person); decisions, approvals, holds and priorities, each with the person who gave it; deploy and release checks in flight; timers you set and why; capacity facts you still rely on (which machine or slot is out, and since when). Keep every id with what it is. Finished work: one line each at most. Your memory folder is unchanged, and list_work has the ledger.';

export interface AutoCompactSettings {
  atTokens: number;
  atTurnUsd: number;
}

/** The thresholds in force (config orchestrator.compactAtTokens / compactAtTurnUsd; 0 is off). */
export function autoCompactSettings(cfg: Pick<Config, 'orchestrator'>): AutoCompactSettings {
  const n = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : d);
  return { atTokens: n(cfg.orchestrator?.compactAtTokens, AUTO_COMPACT_DEFAULTS.atTokens), atTurnUsd: n(cfg.orchestrator?.compactAtTurnUsd, AUTO_COMPACT_DEFAULTS.atTurnUsd) };
}

const num = (n: number) => n.toLocaleString('en-US');

/**
 * Whether this orchestrator's conversation is due for an automatic compaction now, by its measured context and its last
 * turn's cost: why (the chat line says it), or undefined. Not within MIN_TURNS_BETWEEN turns of the last compaction, and
 * the token trigger also waits until the context has grown by half the threshold past what the last one left, so a
 * conversation a compaction cannot bring under it is not compacted every few turns.
 */
export function compactionDue(info: Pick<SessionInfo, 'contextTokens' | 'lastTurnCostUsd' | 'lastCompaction' | 'turns'>, s: AutoCompactSettings): AutoCompaction | undefined {
  const ctx = info.contextTokens;
  if (!ctx) return undefined;
  const last = info.lastCompaction;
  if (last && info.turns - last.turns < MIN_TURNS_BETWEEN) return undefined;
  if (s.atTokens > 0 && ctx >= s.atTokens && ctx >= (last?.after ?? 0) + s.atTokens / 2) return { trigger: 'tokens', reason: `the context passed ${num(s.atTokens)} tokens` };
  const spent = info.lastTurnCostUsd ?? 0;
  if (s.atTurnUsd > 0 && spent >= s.atTurnUsd && ctx >= COST_TRIGGER_MIN_TOKENS) return { trigger: 'cost', reason: `its last turn cost $${spent.toFixed(2)}, $${s.atTurnUsd.toFixed(2)} or more, with the context at ${num(ctx)} tokens` };
  return undefined;
}

/**
 * Why this orchestrator must not be compacted now, or undefined. Only between turns: not mid-turn, no permission
 * prompt, no message of anyone's waiting in the send queue or unanswered, not compacting already, and its process up
 * (a stopped one is not started just to compact; it is checked again after its next turn).
 */
export function compactBlocker(s: SessionHandle & { compactingNow?: boolean }, queued: boolean): string | undefined {
  const i = s.info;
  if (i.kind !== 'orchestrator' || !s.compact) return 'not an orchestrator of this host';
  if (!i.sdkSessionId) return 'no conversation yet';
  if (!s.live) return 'its process is not running';
  if (s.compactingNow) return 'compacting already';
  if (isMidTurn(i) || i.status !== 'idle') return `it is ${i.status.replace('_', ' ')}`;
  if (i.turnOpenSince) return 'a message to it is not answered yet';
  if (i.pendingPermissions.length) return 'a permission prompt is open';
  if (queued) return 'a message to it is waiting in the send queue';
  return undefined;
}

/**
 * Compacts the orchestrators by themselves (see the top of this file). Listens to every turn's end; a compaction's own end
 * is not a turn to check. Nothing is persisted here: the triggers read the session's own fields, which are.
 */
export class AutoCompactor {
  /** compact_conversation requests (w535), by session: the focus the orchestrator gave, '' for the default one. */
  private readonly requested = new Map<string, string>();
  /** When each session's last automatic compaction started: one that did not finish holds the next for RETRY_AFTER_MS. */
  private readonly attempts = new Map<string, number>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly settleMs: number;
  private readonly sessions: SessionManager;
  private readonly cfg: Pick<Config, 'orchestrator'>;

  constructor(sessions: SessionManager, cfg: Pick<Config, 'orchestrator'>, opts: { settleMs?: number } = {}) {
    this.sessions = sessions;
    this.cfg = cfg;
    this.settleMs = opts.settleMs ?? SETTLE_MS;
    sessions.events.on('turnEnd', (s: SessionHandle, _text: string, meta?: TurnEndMeta) => {
      if (s.info.kind !== 'orchestrator' || meta?.compaction) return;
      this.soon(s.info.id);
    });
  }

  /** Check this session after SETTLE_MS (a later turn end moves it). */
  private soon(id: string) {
    clearTimeout(this.timers.get(id));
    const t = setTimeout(() => {
      this.timers.delete(id);
      try {
        this.check(id);
      } catch (e) {
        console.warn(`auto-compact ${id}: ${(e as Error).message}`);
      }
    }, this.settleMs);
    t.unref?.();
    this.timers.set(id, t);
  }

  /**
   * Compact this orchestrator now when it is due and between turns: what it did ("compacting: <why>"), or why not. For
   * the turn-end check and tests.
   */
  check(id: string, now = Date.now()): string {
    const s = this.sessions.sessions.get(id) as (SessionHandle & { compactingNow?: boolean }) | undefined;
    if (!s) return 'no such session';
    const blocked = compactBlocker(s, this.sessions.queued().some((q) => q.id === id));
    if (blocked) return `not now: ${blocked}`;
    const asked = this.requested.get(id);
    const due: AutoCompaction | undefined = asked !== undefined ? { trigger: 'self', reason: 'the orchestrator asked for it' } : compactionDue(s.info, autoCompactSettings(this.cfg));
    if (!due) return 'not due';
    const tried = this.attempts.get(id);
    const finished = tried !== undefined && s.info.lastCompaction && Date.parse(s.info.lastCompaction.at) >= tried;
    if (due.trigger !== 'self' && tried !== undefined && !finished && now - tried < RETRY_AFTER_MS) return 'not now: the last automatic compaction did not finish; it is tried again later';
    const dispatcher = s.info.orchestratorRole === 'dispatcher' || (!s.info.orchestratorRole && !s.info.requestedBy);
    const focus = asked || (dispatcher ? DISPATCHER_FOCUS : PERSONAL_FOCUS);
    this.requested.delete(id);
    this.attempts.set(id, now);
    console.log(`auto-compact ${id} (${s.info.title}): ${due.reason}; context ${s.info.contextTokens ?? '?'} tokens`);
    this.sessions.compact(id, focus, undefined, due);
    return `compacting: ${due.reason}`;
  }

  /**
   * compact_conversation (w535): the orchestrator asks to compact its own conversation. It runs once this turn has ended,
   * under the same rules as the automatic one (never mid-turn, never ahead of a message waiting for an answer).
   */
  request(id: string, focus = ''): string {
    const s = this.sessions.get(id);
    if (s.info.kind !== 'orchestrator' || !s.compact) throw new Error('only an orchestrator of this host compacts its conversation');
    const f = focus.replace(/\s+/g, ' ').trim();
    if (f.length > COMPACT_FOCUS_CHARS) throw new Error(`the focus is ${f.length} characters; keep it to ${COMPACT_FOCUS_CHARS}`);
    const last = s.info.lastCompaction;
    if (last && s.info.turns - last.turns < MIN_TURNS_BETWEEN) throw new Error(`it was compacted ${s.info.turns - last.turns} turn(s) ago (${num(last.before)} → ${last.after !== undefined ? num(last.after) : '?'} tokens); compact again after ${MIN_TURNS_BETWEEN} turns at the earliest`);
    this.requested.set(id, f);
    const ctx = s.info.contextTokens;
    return `Your conversation is compacted once this turn ends${ctx ? ` (its context is ${num(ctx)} tokens now)` : ''}, before any message that arrives later. End your turn now; anything still open must be in what you have said, the ledger or your memory folder. ${f ? 'Your focus goes with it.' : 'The default focus keeps open requests, unanswered questions, decisions and ids.'}`;
  }

  /** Stop the pending checks (tests, the server stopping). */
  stop() {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }
}
