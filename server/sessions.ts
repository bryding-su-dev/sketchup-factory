import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { query, type Options, type PermissionResult, type Query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { Config } from './config.ts';
import type { Store } from './store.ts';
import type { CompactionTrigger, DeliveredAttachment, EffortLevel, ImageInput, ImageRef, OrchestratorRole, PendingPermission, PermissionMode, Requester, SessionInfo, SessionKind } from '../shared/types.ts';
import { attachmentBlock } from '../shared/attachments.ts';
import { emit } from './store.ts';
import { accountKeyOf } from './usage.ts';
import { senderOf, type SessionSnapshot, type Unanswered } from './restart.ts';
import { checkObject, readJsonDurable, writeJsonDurable } from './durable.ts';

/** A session is mid-turn: working, starting or waiting for a permission answer. Only these count toward the agent limits (w384). */
export const MID_TURN: ReadonlySet<SessionInfo['status']> = new Set(['running', 'starting', 'waiting_permission']);
export const isMidTurn = (i: Pick<SessionInfo, 'status'>) => MID_TURN.has(i.status);

/**
 * The agents that hold up a branch switch of their place (switch_branch), on the portal and on a machine's daemon (w422):
 * mid-turn with a process behind them, other than the caller, which is mid-turn by definition since it is in the tool
 * call. A mid-turn status with no process (left by an agent that stopped or crashed) does not count: those are `stale`,
 * for the portal to clear. 'starting' counts without one: a machine's agent is 'starting' before its daemon reports it.
 */
export function othersMidTurn<T extends { readonly info: SessionInfo; readonly live: boolean }>(handles: Iterable<T | undefined>, callerId?: string) {
  const busy: T[] = [];
  const stale: T[] = [];
  for (const h of handles) {
    if (!h || h.info.id === callerId || !isMidTurn(h.info)) continue;
    (h.live || h.info.status === 'starting' ? busy : stale).push(h);
  }
  return { busy, stale };
}

/** switch_branch's refusal while othersMidTurn found agents: who they are, by title. */
export const midTurnRefusal = (busy: { info: SessionInfo }[], where: string) =>
  `agent(s) ${busy.map((s) => `"${s.info.title}"`).join(', ')} ${busy.length === 1 ? 'is' : 'are'} mid-turn in ${where}; wait for them (or stop them) first`;

/** A message waiting for a free running slot (w384): delivered in order once one frees. Kept in data/send-queue.json. */
export interface QueuedSend {
  uuid: string;
  id: string;
  text: string;
  from: 'human' | 'orchestrator' | 'system';
  images?: ImageInput[];
  requestedBy?: Requester;
  attachments?: DeliveredAttachment[];
  bypassGate?: boolean;
  at: string;
  why: string;
  /** The last error a delivery attempt threw (w496): it stays queued and is tried again, up to QUEUE_HOLD_MS. */
  lastError?: string;
}

/**
 * How long a queued message that cannot be delivered yet (its machine's daemon outdated or offline, the host guard) is
 * tried again before it is given up, with an error in its transcript (w496).
 */
export const QUEUE_HOLD_MS = 24 * 3_600_000;

/** Idle agent processes kept on this host besides the running ones (limits.maxIdleAgents); the oldest idle one goes first. */
export const DEFAULT_MAX_IDLE_AGENTS = 6;

/** The prompt stream for one query(): messages pushed here become user turns, in order. */
class InputQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = [];
  private waiter?: (r: IteratorResult<SDKUserMessage>) => void;
  private closed = false;

  push(text: string, uuid: string, images: ImageInput[] = []) {
    const content: SDKUserMessage['message']['content'] = images.length
      ? [
          ...images.map((i) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: i.mediaType as 'image/png', data: i.data } })),
          ...(text ? [{ type: 'text' as const, text }] : []),
        ]
      : text;
    const msg: SDKUserMessage = { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, uuid: uuid as SDKUserMessage['uuid'] };
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = undefined;
      w({ value: msg, done: false });
    } else this.items.push(msg);
  }

  close() {
    this.closed = true;
    this.waiter?.({ value: undefined, done: true });
    this.waiter = undefined;
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item) return Promise.resolve({ value: item, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => (this.waiter = resolve));
      },
    };
  }
}

/** The Agent SDK's query(). The E2E server (e2e/server.ts) swaps in a scripted fake agent. */
let runQuery: typeof query = query;
export function setQueryForTesting(q: typeof query) {
  runQuery = q;
}

/** Builds the SDK options for a session each time its process (re)starts. */
export type OptionsFactory = (info: SessionInfo) => Options;

/** Where an AgentSession records itself: the Store here, or the link back to the portal on a machine daemon. */
/** Where a session records itself; `noteActivity` (the portal's Store) marks streamed output as activity. */
export type SessionSink = Pick<Store, 'putSession' | 'append' | 'amend' | 'saveImage'> & { noteActivity?: (sessionId: string) => void; flush?: () => void };

/**
 * How long (ms) a session whose process ended by itself keeps its restart marks (turnOpenSince, backgroundTasks).
 * Agent processes can end a moment before the server does (a console close or a process-tree stop reaches
 * them first); if the server is still up after this, the process ended on its own and there is nothing to resume.
 */
export const restartMarks = { graceMs: 60_000 };

/**
 * What the managers need from a session, wherever its process runs: an AgentSession in this process,
 * or a RemoteSession whose process runs on a machine (server/machines.ts).
 */
export interface SessionHandle {
  readonly info: SessionInfo;
  readonly live: boolean;
  lastFrom: 'human' | 'orchestrator' | 'system';
  /**
   * Who the current turn is answering: 'human' only when every message it has not answered yet is a person's (the CLI
   * folds messages sent during a turn into it, so harness text can share a person's turn); else the first sender that
   * is not a person. Without any, the last sender. What decides whether a turn is a person's (docs/orchestrators.md).
   */
  readonly turnFrom?: 'human' | 'orchestrator' | 'system';
  /**
   * `requestedBy`: the person who wrote it, or for whom the orchestrator or the harness sends it (docs/identity.md).
   * `attachments` (docs/attachments.md): files that come with it, with where this agent's copy is; on a machine, the
   * daemon fetches the copies first and fills that in.
   */
  send(text: string, from?: 'human' | 'orchestrator' | 'system', uuid?: string, images?: ImageInput[], requestedBy?: Requester, attachments?: DeliveredAttachment[]): string;
  interrupt(): Promise<void>;
  /**
   * Compact the conversation now (w518, a person's `/compact [focus]`): Claude Code's own /compact, between turns only.
   * Returns what to tell the person; throws why it cannot. Only sessions in this process have it.
   */
  compact?(instructions?: string, by?: Requester, auto?: AutoCompaction): string;
  setMode(mode: PermissionMode): Promise<void>;
  /** `onPurpose` false: the server is stopping, not a person or the orchestrator; the restart marks stay. */
  stop(onPurpose?: boolean): void;
  decide(requestId: string, allow: boolean, message?: string): boolean;
  /** Drop the restart marks once a restart has resumed it, or decided not to. */
  clearRestartMarks?(): void;
  /** Called when the session is removed for good. */
  dispose?(): void;
  /** What a restart needs to know (server/restart.ts); without it, snapshotOf() works from info alone. */
  snapshot?(): SessionSnapshot;
}

/** A session's state for the restart logic, wherever it runs. */
export function snapshotOf(h: SessionHandle): SessionSnapshot {
  if (h.snapshot) return h.snapshot();
  const i = h.info;
  return { id: i.id, kind: i.kind, title: i.title, sandboxId: i.sandboxId, machineId: i.machineId, status: i.status, unanswered: [], lastFrom: h.lastFrom, ...(i.stoppedOnPurpose ? { stoppedOnPurpose: true } : {}) };
}

const MAX_TOOL_RESULT = 6000;

/** A session's statusDetail while its /compact runs (w518). */
export const COMPACTING = 'compacting the conversation';

/**
 * A compaction FF Factory starts itself (w535, server/autoCompact.ts): why, as the chat line says it ("the context
 * passed 200,000 tokens"). No line in the chat when it starts and no push notification when it ends: one line when it
 * is done, "Compacted: N → M tokens (…)".
 */
export interface AutoCompaction {
  trigger: Exclude<CompactionTrigger, 'person' | 'claude'>;
  reason: string;
}

/** What 'turnEnd' carries besides the session and its text (w535): set when the turn was a compaction, and whose. */
export interface TurnEndMeta {
  compaction?: CompactionTrigger;
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === 'object' && 'type' in b ? (b.type === 'text' ? String((b as { text: unknown }).text) : `[${String(b.type)}]`) : ''))
      .join('\n');
  }
  return content == null ? '' : JSON.stringify(content);
}

/**
 * What the model reads for a message: every message from a person, or from the orchestrator on a person's behalf,
 * starts with whose it is, in every kind of session (w389: a worker read a person's unmarked "Undo the release hold"
 * as the portal owner's and wrote his name on a release decision he never made). Harness messages carry their own tag.
 */
export function promptText(_kind: SessionKind, text: string, from: 'human' | 'orchestrator' | 'system', requestedBy?: Requester): string {
  const who = senderOf(from, requestedBy);
  return who ? `[from ${who}]\n${text}` : text;
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + `\n… (${s.length - n} more chars)` : s);

/** The longest focus a `/compact <focus>` may carry, in characters. */
export const COMPACT_FOCUS_CHARS = 2000;

/**
 * A person's message that is Claude Code's `/compact`, alone or with focus instructions after it (w518): the focus
 * (empty for none), or undefined for any other message. `/compactly` and a `/compact` inside a sentence are messages.
 */
export function compactCommand(text: string): string | undefined {
  const m = /^\/compact(?:\s+([\s\S]*))?$/.exec(text.trim());
  return m ? (m[1] ?? '').replace(/\s+/g, ' ').trim() : undefined;
}

const tokens = (n: number) => `${n.toLocaleString('en-US')} tokens`;

/**
 * The transcript line a finished /compact leaves (w518). `before` is Claude Code's own count of the context it compacted
 * (compact_boundary pre_tokens); `after` the context measured once it was done (getContextUsage), or, when that could not
 * be measured, the summary that replaced the conversation (post_tokens), which leaves out the system prompt and tools.
 */
export function compactedLine(before: number, after: { total: number; max?: number } | undefined, summary: number | undefined, ms: number | undefined, auto?: AutoCompaction): string {
  const took = ms ? `, in ${Math.max(1, Math.round(ms / 1000))} s` : '';
  // An automatic one (w535): the one line the chat gets, "Compacted: N → M tokens (why)".
  if (auto) {
    const to = after ? tokens(after.total) : `${summary !== undefined ? tokens(summary) : 'an unknown number of tokens'} (the summary alone: the context after it could not be measured)`;
    return `Compacted: ${before.toLocaleString('en-US')} → ${to} (automatically: ${auto.reason})${took}.`;
  }
  if (after) return `Compacted: the context went from ${tokens(before)} to ${tokens(after.total)}${after.max ? ` (of ${tokens(after.max)})` : ''}${took}, as Claude Code measured it before and after.`;
  return `Compacted: the context was ${tokens(before)}; the summary that replaces it is ${summary !== undefined ? tokens(summary) : 'of unknown size'} (the context after it could not be measured)${took}.`;
}

/**
 * One Claude Code conversation, driven through the Agent SDK in streaming-input mode so a person
 * (or the orchestrator) can keep talking to it, interrupt it and answer its permission prompts.
 * The process is started lazily on the first message and resumed from the SDK session id after
 * a stop or a server restart.
 */
export class AgentSession implements SessionHandle {
  readonly info: SessionInfo;
  private q?: Query;
  private input?: InputQueue;
  private abort?: AbortController;
  private readonly pending = new Map<string, { resolve: (r: PermissionResult) => void; seq: number; input: Record<string, unknown> }>();
  /** Who sent the message that started the current turn; the orchestrator only hears about turns it started. */
  lastFrom: 'human' | 'orchestrator' | 'system' = 'human';
  private costBase = 0;
  /** Set once the CLI has sent a session_state_changed; until then `result` doubles as turn end. */
  private stateEvents = false;
  private backgroundTasks = 0;
  private lastTurnText = '';
  private firstResult = true;
  /** Messages sent but not yet answered by a finished turn, by uuid: what a restart would cut off. */
  private readonly outstanding = new Map<string, Unanswered>();
  /** Stopped or interrupted by a person or the orchestrator since its last message: a restart leaves it alone. */
  private stoppedOnPurpose = false;
  private graceTimer?: NodeJS.Timeout;
  /** The /compact in progress (w518): the uuid of its message, when it was sent, and FF Factory's reason when it started it (w535). */
  private compacting?: { uuid: string; at: number; auto?: AutoCompaction };
  /** The last compaction's trigger until a message comes after it (w535): its end is no turn of a person's. */
  private compactTurn?: CompactionTrigger;
  /** The session's spend when its current turn opened (w535): what the turn's cost is measured from. */
  private costAtTurnOpen = 0;
  /** The uuids of /compact messages not answered yet: their results are no turn a person reads. */
  private readonly compactUuids = new Set<string>();
  private readonly store: SessionSink;
  private readonly makeOptions: OptionsFactory;
  private readonly events: EventEmitter;

  constructor(info: SessionInfo, store: SessionSink, makeOptions: OptionsFactory, events: EventEmitter) {
    this.info = info;
    this.store = store;
    this.makeOptions = makeOptions;
    this.events = events;
  }

  get live() {
    return !!this.q;
  }

  /** A compaction is running (w518, w535). */
  get compactingNow() {
    return !!this.compacting;
  }

  get turnFrom(): 'human' | 'orchestrator' | 'system' {
    const froms = [...this.outstanding.values()].map((u) => u.from);
    if (!froms.length) return this.lastFrom;
    return froms.find((f) => f !== 'human') ?? 'human';
  }

  private update(patch: Partial<SessionInfo>) {
    Object.assign(this.info, patch, { lastActivityAt: new Date().toISOString() });
    this.store.putSession(this.info);
  }

  /** Queue a user message; returns its uuid, which the answering turn's result lists in `answers`. */
  send(text: string, from: 'human' | 'orchestrator' | 'system' = 'human', uuid: string = randomUUID(), images: ImageInput[] = [], requestedBy?: Requester, attachments: DeliveredAttachment[] = []): string {
    // A person's message (or the orchestrator's on a person's behalf) says who this session now works for; the
    // harness's own messages carry the person they are about, but do not change that.
    if (requestedBy && from !== 'system') this.info.lastRequestedBy = requestedBy;
    if (!this.q) this.start();
    this.lastFrom = from;
    this.stoppedOnPurpose = false;
    clearTimeout(this.graceTimer);
    this.outstanding.set(uuid, { text, from, ...(requestedBy ? { requestedBy } : {}) });
    // Images arrive stored already (with an id) or are kept here, so the transcript can show them.
    const refs = images.map((i) => ({ id: i.id ?? this.store.saveImage(this.info.id, i.mediaType, i.data), mediaType: i.mediaType }));
    this.store.append(this.info.id, { kind: 'user', text, from, uuid, ...(refs.length ? { images: refs } : {}), ...(attachments.length ? { attachments } : {}), ...(requestedBy ? { requestedBy } : {}) });
    // The files come after the text, as a block the agent reads as data (shared/attachments.ts).
    const files = attachmentBlock(attachments, this.info.kind === 'orchestrator' ? 'orchestrator' : 'worker');
    this.input!.push(promptText(this.info.kind, files ? (text ? `${text}\n\n${files}` : files) : text, from, requestedBy), uuid, images);
    const opens = !this.info.turnOpenSince;
    // A message after a compaction: the turn that ends next is this message's, not the compaction's (w535).
    this.compactTurn = undefined;
    if (opens) this.costAtTurnOpen = this.info.costUsd;
    this.update({ status: 'running', statusDetail: undefined, ...(opens ? { turnOpenSince: new Date().toISOString() } : {}) });
    if (opens) this.store.flush?.();
    return uuid;
  }

  /**
   * Compact the conversation now (w518): Claude Code's own `/compact [focus]`, sent as a message of its own (without
   * the sender line, which would make it text). Between turns only: mid-turn it throws, and nothing is sent. A stopped
   * session resumes for it. Messages that arrive meanwhile (a wake_me, a timer, a worker's report) wait in the input
   * and are answered after it, with the compacted history. Progress goes to the transcript as system lines.
   */
  compact(instructions = '', by?: Requester, auto?: AutoCompaction): string {
    if (this.compacting) throw new Error('it is compacting already');
    if (isMidTurn(this.info)) throw new Error(`it is mid-turn (${this.info.status.replace('_', ' ')}); /compact runs between turns, so send it again once this turn has ended, or stop the turn first`);
    if (!this.info.sdkSessionId) throw new Error('there is no conversation to compact yet');
    const focus = instructions.replace(/\s+/g, ' ').trim();
    if (focus.length > COMPACT_FOCUS_CHARS) throw new Error(`the focus is ${focus.length} characters; keep it to ${COMPACT_FOCUS_CHARS}`);
    if (!this.q) this.start();
    const uuid = randomUUID();
    this.compacting = { uuid, at: Date.now(), ...(auto ? { auto } : {}) };
    this.compactTurn = auto?.trigger ?? 'person';
    this.compactUuids.add(uuid);
    // An automatic one (w535) leaves one line, when it is done; a person's says at once that it started.
    if (!auto) this.store.append(this.info.id, { kind: 'system', text: `Compacting this conversation${by ? ` (asked by ${by.displayName})` : ''}${focus ? `, with the focus: ${focus}` : ''}. Messages that arrive meanwhile are answered after it.` });
    this.input!.push(`/compact${focus ? ` ${focus}` : ''}`, uuid);
    this.update({ status: 'running', statusDetail: COMPACTING });
    return 'Compacting the conversation; the chat says when it is done.';
  }

  /** The /compact ended without a boundary (it failed, or the process went): say so, and the turn's end says it too. */
  private compactFailed(why: string) {
    if (!this.compacting) return;
    const auto = this.compacting.auto;
    this.compacting = undefined;
    const line = `The ${auto ? 'automatic ' : ''}compaction failed: ${why}.`;
    // An automatic one's failure is no reply a person waits for: the last turn's text stays (w535).
    if (!auto) this.lastTurnText = line;
    this.store.append(this.info.id, { kind: 'error', text: line });
    if (this.info.statusDetail === COMPACTING) this.update({ statusDetail: undefined });
  }

  /** The context in use now, as Claude Code measures it (getContextUsage), or undefined when it cannot say within 20 s. */
  private async contextNow(q: Query): Promise<{ total: number; max: number } | undefined> {
    if (typeof q.getContextUsage !== 'function') return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const u = await Promise.race([q.getContextUsage({ detail: 'full' }), new Promise<undefined>((r) => (timer = setTimeout(() => r(undefined), 20_000)))]);
      return u && Number.isFinite(u.totalTokens) ? { total: u.totalTokens, max: u.maxTokens } : undefined;
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  private start() {
    this.input = new InputQueue();
    this.abort = new AbortController();
    const base = this.makeOptions(this.info);
    const options: Options = {
      ...base,
      model: this.info.model ?? base.model,
      permissionMode: this.info.permissionMode,
      allowDangerouslySkipPermissions: true,
      includePartialMessages: true,
      abortController: this.abort,
      canUseTool: (toolName, input, { signal, blockedPath }) => this.askPermission(toolName, input, signal, blockedPath),
      ...(this.info.sdkSessionId ? { resume: this.info.sdkSessionId } : {}),
      // Opt in to session_state_changed: the authoritative "turn is over" signal. A `result` alone is
      // not — background subagents and tasks can re-invoke the session after it.
      // Git fails fast instead of hanging on a credential prompt nobody will answer (an orphaned
      // `git fetch` once sat at an askpass prompt for hours).
      env: { ...(base.env ?? process.env), CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
    };
    this.costBase = this.info.costUsd;
    this.firstResult = true;
    // A new process: the last one's background tasks ended with it.
    this.backgroundTasks = 0;
    this.info.backgroundTasks = undefined;
    this.q = runQuery({ prompt: this.input, options });
    // What this process runs on, whatever the config says later (the account meters, docs/accounts.md).
    this.update({ status: 'starting', account: accountKeyOf(options.env ?? process.env) });
    void this.consume(this.q);
  }

  private async consume(q: Query) {
    try {
      for await (const m of q) {
        // After stop() this query is no longer the session's: a buffered state event must not mark a stopped session idle.
        if (this.q !== q) break;
        this.handle(m);
      }
      if (this.q === q) this.update({ status: 'stopped', statusDetail: undefined });
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      const aborted = this.abort?.signal.aborted;
      if (!aborted) this.store.append(this.info.id, { kind: 'error', text: msg });
      if (this.q === q) this.update({ status: aborted ? 'stopped' : 'error', statusDetail: aborted ? undefined : clip(msg, 300) });
    } finally {
      if (this.q === q) {
        this.q = undefined;
        this.input = undefined;
        this.denyAllPending('session ended');
        this.compactFailed('the agent process ended first');
        this.keepMarksBriefly();
        this.events.emit('ended', this);
      }
    }
  }

  private handle(m: SDKMessage) {
    const id = this.info.id;
    switch (m.type) {
      case 'system':
        if (m.subtype === 'init') {
          this.update({ sdkSessionId: m.session_id, model: m.model, status: this.info.status === 'starting' ? 'running' : this.info.status });
        } else if (m.subtype === 'session_state_changed') {
          this.stateEvents = true;
          if (m.state === 'running') this.update({ status: 'running' });
          else if (m.state === 'requires_action') this.update({ status: 'waiting_permission' });
          else if (m.state === 'idle') {
            // Idle means the input queue is drained: everything sent has been answered.
            this.outstanding.clear();
            this.update({ status: this.pending.size ? 'waiting_permission' : 'idle', turnOpenSince: undefined });
            this.store.flush?.();
            this.emitTurnEnd(this.lastTurnText);
          }
        } else if (m.subtype === 'status') {
          // A /compact (w518): Claude Code says whether it failed.
          if (m.compact_result === 'failed') this.compactFailed(m.compact_error || 'Claude Code gave no reason');
        } else if (m.subtype === 'compact_boundary') {
          const meta = m.compact_metadata;
          if (meta.trigger === 'manual' && this.compacting) {
            const c = this.compacting;
            this.compacting = undefined;
            // What the turn's end says when nothing else was asked meanwhile (the notification); the transcript line
            // follows once the context after it is measured. An automatic one keeps the last reply's text (w535).
            if (!c.auto) this.lastTurnText = `Compacted the conversation (the context was ${tokens(meta.pre_tokens)}).`;
            const turns = this.info.turns;
            // Until it is measured, the context is at least the summary (w535): the automatic trigger must not read the old size.
            this.info.contextTokens = meta.post_tokens;
            const q = this.q;
            void (q ? this.contextNow(q) : Promise.resolve(undefined)).then((after) => {
              this.store.append(id, { kind: 'system', text: compactedLine(meta.pre_tokens, after, meta.post_tokens, meta.duration_ms ?? Date.now() - c.at, c.auto) });
              const record = { at: new Date().toISOString(), trigger: c.auto?.trigger ?? 'person', before: meta.pre_tokens, ...(after ? { after: after.total } : {}), turns } as const;
              // A call answered meanwhile has measured the context since; this measurement is the older one then.
              const measured = after && this.info.contextTokens === meta.post_tokens ? { contextTokens: after.total } : {};
              this.update({ lastCompaction: record, ...measured, ...(this.info.statusDetail === COMPACTING ? { statusDetail: undefined } : {}) });
            });
          } else if (meta.trigger === 'auto') {
            this.store.append(id, { kind: 'system', text: `Claude Code compacted this conversation by itself: the context was ${tokens(meta.pre_tokens)}.` });
            this.info.contextTokens = meta.post_tokens;
            this.update({ lastCompaction: { at: new Date().toISOString(), trigger: 'claude', before: meta.pre_tokens, turns: this.info.turns } });
          }
        } else if (m.subtype === 'background_tasks_changed') {
          this.backgroundTasks = m.tasks.filter((t) => !t.ambient).length;
          this.update({ statusDetail: this.backgroundTasks ? `${this.backgroundTasks} background task(s)` : undefined, backgroundTasks: this.backgroundTasks || undefined });
        }
        return;
      case 'stream_event': {
        if (m.parent_tool_use_id) return;
        const ev = m.event;
        if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
          emit({ type: 'delta', sessionId: id, text: ev.delta.text });
          this.store.noteActivity?.(id);
        }
        return;
      }
      case 'assistant': {
        const sub = m.parent_tool_use_id;
        // The context the next call reads (w535): this call's input, cached or not, and its output. Kept in memory here;
        // the next update (the turn's end at the latest) saves it.
        const u = sub ? undefined : (m.message as { usage?: { input_tokens?: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null; output_tokens?: number } }).usage;
        if (u) {
          const n = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.output_tokens ?? 0);
          if (n > 0) this.info.contextTokens = n;
        }
        for (const b of m.message.content) {
          if (b.type === 'text' && !sub && b.text.trim()) this.store.append(id, { kind: 'assistant', text: b.text });
          else if (b.type === 'thinking' && !sub && b.thinking.trim()) this.store.append(id, { kind: 'thinking', text: b.thinking });
          else if (b.type === 'tool_use') this.store.append(id, { kind: 'tool_use', toolUseId: b.id, name: b.name, input: b.input, parentToolUseId: sub });
        }
        if (m.error) this.store.append(id, { kind: 'error', text: `assistant error: ${m.error}` });
        return;
      }
      case 'user': {
        const content = m.message.content;
        if (!Array.isArray(content)) return;
        for (const b of content) {
          if (b.type === 'tool_result') {
            const images = this.keepImages(b.content);
            this.store.append(id, { kind: 'tool_result', toolUseId: b.tool_use_id, isError: !!b.is_error, text: clip(textOf(b.content), MAX_TOOL_RESULT), ...(images.length ? { images } : {}) });
          }
        }
        return;
      }
      case 'rate_limit_event':
        // Plan usage moved; server/usage.ts refetches the numbers.
        this.events.emit('rateLimit', this, m.rate_limit_info);
        return;
      case 'result': {
        const total = m.total_cost_usd ?? 0;
        // A resumed session's first result may already carry the earlier spend; do not count it twice.
        if (this.firstResult && total >= this.costBase) this.costBase = 0;
        this.firstResult = false;
        const answered = m.user_message_uuids ?? (m.user_message_uuid ? [m.user_message_uuid] : []);
        // A /compact's own result (w518) is no turn: its cost counts, but it leaves no reply and keeps the last report.
        if (answered.length && answered.every((u) => this.compactUuids.has(u))) {
          for (const u of answered) this.compactUuids.delete(u);
          if (m.subtype !== 'success' || m.is_error) this.compactFailed(m.subtype === 'success' ? m.result || 'an error result' : m.subtype);
          this.update({ costUsd: this.costBase + total });
          if (!this.stateEvents) {
            this.update({ status: this.pending.size ? 'waiting_permission' : 'idle', turnOpenSince: undefined });
            this.emitTurnEnd(this.lastTurnText);
          }
          return;
        }
        for (const u of answered) this.compactUuids.delete(u);
        const text = m.subtype === 'success' ? m.result : `stopped: ${m.subtype}`;
        for (const u of answered) this.outstanding.delete(u);
        this.store.append(id, {
          kind: 'result',
          ok: m.subtype === 'success' && !m.is_error,
          text: clip(text, 2000),
          costUsd: total,
          turns: m.num_turns,
          durationMs: m.duration_ms,
          answers: m.user_message_uuids ?? (m.user_message_uuid ? [m.user_message_uuid] : undefined),
        });
        this.lastTurnText = text;
        const spent = this.costBase + total;
        this.update({ turns: this.info.turns + 1, costUsd: spent, lastResult: clip(text, 1200), lastTurnCostUsd: Math.max(0, spent - this.costAtTurnOpen) });
        this.events.emit('result', this, m.subtype);
        if (!this.stateEvents) {
          // Older CLI without state events: best effort from the result itself.
          const queued = (m as { queued_turn_count?: number }).queued_turn_count ?? 0;
          if (!queued) this.outstanding.clear();
          this.update({ status: queued > 0 ? 'running' : this.pending.size ? 'waiting_permission' : 'idle', ...(queued > 0 ? {} : { turnOpenSince: undefined }) });
          this.emitTurnEnd(text);
        }
        return;
      }
      default:
        return;
    }
  }

  /** The turn ended: 'turnEnd' with its text, and whose compaction it was when it was one (w535). */
  private emitTurnEnd(text: string) {
    const meta: TurnEndMeta = this.compactTurn ? { compaction: this.compactTurn } : {};
    this.compactTurn = undefined;
    this.events.emit('turnEnd', this, text, meta);
  }

  /** Keep the images in a tool result (a screenshot, a Read of a PNG) so the transcript can show them. */
  private keepImages(content: unknown): ImageRef[] {
    if (!Array.isArray(content)) return [];
    const out: ImageRef[] = [];
    for (const b of content) {
      const src = b && typeof b === 'object' && (b as { type?: unknown }).type === 'image' ? (b as { source?: { type?: string; media_type?: string; data?: string } }).source : undefined;
      if (src?.type !== 'base64' || !src.data || !src.media_type || src.data.length > 14_000_000 || out.length >= 8) continue;
      try {
        out.push({ id: this.store.saveImage(this.info.id, src.media_type, src.data), mediaType: src.media_type });
      } catch {
        // an image type we do not keep; the text still says [image]
      }
    }
    return out;
  }

  private askPermission(toolName: string, input: Record<string, unknown>, signal: AbortSignal, blockedPath?: string): Promise<PermissionResult> {
    const requestId = randomUUID();
    const ev = this.store.append(this.info.id, { kind: 'permission', requestId, toolName, input });
    const p: PendingPermission = {
      requestId,
      toolName,
      input,
      reason: blockedPath ? `touches ${blockedPath}` : undefined,
      createdAt: new Date().toISOString(),
    };
    this.update({ status: 'waiting_permission', pendingPermissions: [...this.info.pendingPermissions, p] });
    this.events.emit('permission', this, p);
    return new Promise<PermissionResult>((resolve) => {
      this.pending.set(requestId, { resolve, seq: ev.seq, input });
      signal.addEventListener('abort', () => this.decide(requestId, false, 'aborted'), { once: true });
    });
  }

  decide(requestId: string, allow: boolean, message?: string) {
    const p = this.pending.get(requestId);
    if (!p) return false;
    this.pending.delete(requestId);
    this.store.amend(this.info.id, p.seq, { decision: allow ? 'allow' : 'deny' } as never);
    p.resolve(allow ? { behavior: 'allow', updatedInput: p.input } : { behavior: 'deny', message: message || 'Denied by the user in the sandbox UI.' });
    this.update({
      pendingPermissions: this.info.pendingPermissions.filter((x) => x.requestId !== requestId),
      status: this.pending.size ? 'waiting_permission' : this.q ? 'running' : 'stopped',
    });
    return true;
  }

  private denyAllPending(reason: string) {
    for (const id of [...this.pending.keys()]) this.decide(id, false, reason);
    if (this.info.pendingPermissions.length) this.update({ pendingPermissions: [] });
  }

  async interrupt() {
    if (!this.q) return;
    this.denyAllPending('interrupted');
    await this.q.interrupt();
    this.compactFailed('it was interrupted');
    this.outstanding.clear();
    this.stoppedOnPurpose = true;
    this.store.append(this.info.id, { kind: 'system', text: 'Interrupted.' });
    this.update({ status: 'idle', turnOpenSince: undefined });
    this.store.flush?.();
  }

  async setMode(mode: PermissionMode) {
    this.info.permissionMode = mode;
    if (this.q) await this.q.setPermissionMode(mode);
    this.update({});
  }

  snapshot(): SessionSnapshot {
    const i = this.info;
    return {
      id: i.id,
      kind: i.kind,
      title: i.title,
      sandboxId: i.sandboxId,
      machineId: i.machineId,
      status: i.status,
      unanswered: [...this.outstanding.values()],
      lastFrom: this.lastFrom,
      turnOpen: !!i.turnOpenSince,
      backgroundTasks: i.backgroundTasks ?? 0,
      stoppedOnPurpose: this.stoppedOnPurpose,
    };
  }

  /**
   * Stop the process. On purpose (a person, the orchestrator): nothing is left to resume after a restart, not
   * even messages it had not answered. Not on purpose (the server is stopping): the restart marks stay.
   */
  stop(onPurpose = true) {
    if (onPurpose) {
      this.stoppedOnPurpose = true;
      this.outstanding.clear();
      this.clearRestartMarks();
    }
    if (!this.q) return;
    this.input?.close();
    this.abort?.abort();
    this.q = undefined;
    this.input = undefined;
    this.denyAllPending('session stopped');
    this.compactFailed('the session was stopped');
    this.update({ status: 'stopped', statusDetail: undefined });
    this.events.emit('ended', this);
  }

  clearRestartMarks() {
    clearTimeout(this.graceTimer);
    if (!this.info.turnOpenSince && !this.info.backgroundTasks) return;
    this.info.turnOpenSince = undefined;
    this.info.backgroundTasks = undefined;
    this.store.putSession(this.info);
    this.store.flush?.();
  }

  /** The process ended by itself: keep the restart marks for restartMarks.graceMs in case the server is going down too. */
  private keepMarksBriefly() {
    clearTimeout(this.graceTimer);
    this.graceTimer = setTimeout(() => {
      if (this.q) return;
      // It ended on its own: what it had not answered is for a person to pick up, not for a later restart.
      this.outstanding.clear();
      this.clearRestartMarks();
    }, restartMarks.graceMs);
    this.graceTimer.unref?.();
  }
}

export class SessionManager {
  readonly sessions = new Map<string, SessionHandle>();
  /**
   * 'turnEnd' (session, text, TurnEndMeta) and 'permission' (session, pending) — the orchestrator listens;
   * 'result' (session, subtype) after every turn result and 'ended' (session) when the process
   * goes away — standing agents track their runs with these.
   */
  readonly events = new EventEmitter();
  private readonly cfg: Config;
  private readonly store: Store;
  private readonly factories = new Map<string, OptionsFactory>();
  /** Messages waiting for a free running slot, oldest first (w384). */
  private queue: QueuedSend[] = [];
  private readonly queueFile?: string;
  private drainTimer?: NodeJS.Timeout;
  /**
   * A machine session's place is full of mid-turn agents (its sandbox, its sandboxes, its main clone): why, or undefined.
   * Set by MachineManager; a session on a machine is never counted against this host's limits.maxSessions.
   */
  placeFull?: (s: SessionHandle) => string | undefined;
  /** Why this idle session must not be stopped to make room (a pending wake_me, a dirty sandbox, …), or undefined. Set by Agents. */
  keepIdle?: (s: SessionHandle) => string | undefined;

  constructor(cfg: Config, store: Store) {
    this.cfg = cfg;
    this.store = store;
    const dir = (cfg as { dataDir?: string }).dataDir;
    if (dir) {
      this.queueFile = path.join(dir, 'send-queue.json');
      try {
        this.queue = readJsonDurable<{ queue: QueuedSend[] }>(this.queueFile, { check: checkObject })?.queue ?? [];
      } catch {
        this.queue = [];
      }
    }
    // A slot frees when a turn ends or a process goes: deliver what waits then, and every half minute in case.
    this.events.on('turnEnd', () => this.drainSoon());
    this.events.on('ended', () => this.drainSoon());
    this.drainTimer = setInterval(() => this.drain(), 30_000);
    this.drainTimer.unref?.();
  }

  /**
   * Re-attach sessions persisted by an earlier run. They come back stopped and resume on the next
   * message. Returns the local sessions an unclean stop cut off mid-turn.
   */
  restore(factoryFor: (info: SessionInfo) => OptionsFactory | undefined, remote?: (info: SessionInfo) => SessionHandle | undefined): SessionInfo[] {
    const cutOff: SessionInfo[] = [];
    for (const info of this.store.sessions.values()) {
      if (info.machineId) {
        const h = remote?.(info);
        if (!h) continue;
        // Busy on a Mac when this server stopped: its process may well still run there (the daemon reports it
        // live when it reconnects); resumeAfterRestart checks before resuming it.
        if (info.status === 'running' || info.status === 'starting' || info.status === 'waiting_permission') cutOff.push({ ...info });
        info.pendingPermissions = [];
        if (info.status !== 'stopped') info.status = 'stopped';
        this.sessions.set(info.id, h);
        this.store.putSession(info);
        continue;
      }
      const f = factoryFor(info);
      if (!f) continue;
      info.pendingPermissions = [];
      // Busy by its status, or by the marks its process left (it may have ended a moment before the server did).
      const busy = info.status === 'running' || info.status === 'starting' || info.status === 'waiting_permission' || !!info.turnOpenSince;
      if (busy) {
        // Say so in the transcript: otherwise a turn cut off by a restart just looks finished.
        this.store.append(info.id, { kind: 'system', text: 'The server restarted while this session was working, so that turn was cut off. Send a message to resume it.' });
        cutOff.push({ ...info });
      } else if (info.backgroundTasks) {
        this.store.append(info.id, { kind: 'system', text: `The server restarted while this session had ${info.backgroundTasks} background task(s) running; they were stopped.` });
        cutOff.push({ ...info });
      }
      if (info.status !== 'stopped') info.status = 'stopped';
      this.sessions.set(info.id, new AgentSession(info, this.store, f, this.events));
      this.store.putSession(info);
    }
    return cutOff;
  }

  create(opts: { kind: SessionKind; title: string; sandboxId?: string; standingId?: string; model?: string; effort?: EffortLevel; permissionMode: PermissionMode; options: OptionsFactory; id?: string; requestedBy?: Requester; orchestratorRole?: OrchestratorRole }) {
    const now = new Date().toISOString();
    const info: SessionInfo = {
      id: opts.id ?? randomUUID().slice(0, 8),
      kind: opts.kind,
      sandboxId: opts.sandboxId,
      standingId: opts.standingId,
      title: opts.title,
      status: 'stopped',
      model: opts.model,
      effort: opts.effort,
      permissionMode: opts.permissionMode,
      createdAt: now,
      lastActivityAt: now,
      turns: 0,
      costUsd: 0,
      pendingPermissions: [],
      ...(opts.requestedBy ? { requestedBy: opts.requestedBy } : {}),
      ...(opts.orchestratorRole ? { orchestratorRole: opts.orchestratorRole } : {}),
    };
    const s = new AgentSession(info, this.store, opts.options, this.events);
    this.sessions.set(info.id, s);
    this.store.putSession(info);
    return s;
  }

  get(id: string) {
    const s = this.sessions.get(id);
    if (!s) throw new Error(`no session "${id}"`);
    return s;
  }

  /** Adopt a session built elsewhere (a machine's RemoteSession). */
  adopt(h: SessionHandle) {
    this.sessions.set(h.info.id, h);
    this.store.putSession(h.info);
    return h;
  }

  /**
   * Agent processes on THIS host (workers and standing agents, idle or mid-turn): what holds memory. Sessions on a machine
   * live there instead.
   */
  liveAgents() {
    return [...this.sessions.values()].filter((s) => s.info.kind !== 'orchestrator' && !s.info.machineId && s.live).length;
  }

  /**
   * Agents on THIS host that are mid-turn: what limits.maxSessions counts (w384). An idle agent, its process up or not,
   * takes no slot: on 2026-10-04 a follow-up to an idle worker was refused because six idle ones held all the slots.
   */
  runningAgents() {
    return [...this.sessions.values()].filter((s) => s.info.kind !== 'orchestrator' && !s.info.machineId && isMidTurn(s.info)).length;
  }

  /** The most idle agent processes kept on this host besides the running ones. */
  get maxIdleAgents() {
    const n = (this.cfg.limits as { maxIdleAgents?: number }).maxIdleAgents;
    return typeof n === 'number' && n >= 0 ? n : DEFAULT_MAX_IDLE_AGENTS;
  }

  /** Why a message to this session must wait for a free running slot, or undefined (it may go now). */
  private fullFor(s: SessionHandle): string | undefined {
    if (s.info.kind === 'orchestrator' || isMidTurn(s.info)) return undefined;
    if (s.info.machineId) return this.placeFull?.(s);
    const n = this.runningAgents();
    return n >= this.cfg.limits.maxSessions ? `${n} of ${this.cfg.limits.maxSessions} agents on this host are mid-turn (limits.maxSessions)` : undefined;
  }

  /** The messages waiting for a slot (oldest first): for the status views and tests. */
  queued(): readonly QueuedSend[] {
    return this.queue;
  }

  /** Whether the message with this uuid is waiting for a slot. */
  isQueued(uuid: string) {
    return this.queue.some((q) => q.uuid === uuid);
  }

  private saveQueue() {
    if (!this.queueFile) return;
    try {
      writeJsonDurable(this.queueFile, { queue: this.queue }, { indent: 1 });
    } catch (e) {
      console.warn('send queue: could not save it:', (e as Error).message);
    }
  }

  private enqueue(q: QueuedSend) {
    this.queue.push(q);
    this.saveQueue();
    this.store.append(q.id, { kind: 'system', text: `A message is waiting for a free agent slot (${q.why}); it is delivered as soon as one frees.` });
    console.log(`sessions: queued a message for ${q.id}: ${q.why}`);
    return q.uuid;
  }

  private drainSoon() {
    setImmediate(() => this.drain());
  }

  /** Deliver the queued messages that may go now, in order. Returns how many went. */
  drain(now = Date.now()): number {
    let sent = 0;
    // A session whose first waiting message cannot go keeps the rest waiting too, so its messages go in order (w496).
    const held = new Set<string>();
    for (const q of [...this.queue]) {
      if (held.has(q.id)) continue;
      const s = this.sessions.get(q.id);
      const drop = () => {
        this.queue = this.queue.filter((x) => x !== q);
        this.saveQueue();
      };
      if (!s) {
        drop();
        continue;
      }
      if (this.fullFor(s)) {
        held.add(q.id);
        continue;
      }
      const startsHere = !s.live && s.info.kind !== 'orchestrator' && !s.info.machineId;
      if (startsHere && !q.bypassGate && this.startGate?.()) {
        held.add(q.id);
        continue;
      }
      try {
        if (startsHere) this.makeRoom(s);
        s.send(q.text, q.from, q.uuid, q.images, q.requestedBy, q.attachments);
        drop();
        sent++;
      } catch (e) {
        // Removed only once delivered (w496: a worker's brief was dropped when LothDesktop's daemon was outdated):
        // tried again on the next pass, given up only after QUEUE_HOLD_MS.
        const why = (e as Error).message;
        if (now - (Date.parse(q.at) || now) >= QUEUE_HOLD_MS) {
          drop();
          this.store.append(q.id, { kind: 'error', text: `A queued message could not be delivered within ${QUEUE_HOLD_MS / 3_600_000} hours and was given up: ${why}. It began: ${q.text.replace(/\s+/g, ' ').slice(0, 200)}` });
          continue;
        }
        held.add(q.id);
        if (q.lastError !== why) {
          q.lastError = why;
          this.saveQueue();
          this.store.append(q.id, { kind: 'system', text: `A waiting message could not be delivered yet (${why}); it is tried again shortly.` });
        }
      }
    }
    return sent;
  }

  /**
   * Before a new process starts on this host: with limits.maxSessions + limits.maxIdleAgents processes up already, stop
   * the oldest idle ones nothing protects (keepIdle) until there is room. Stopped, not lost: a message resumes them with
   * their history. Returns the ids stopped.
   */
  makeRoom(s: SessionHandle): string[] {
    const cap = this.cfg.limits.maxSessions + this.maxIdleAgents;
    const stopped: string[] = [];
    const idle = [...this.sessions.values()]
      .filter((x) => x !== s && x.live && x.info.kind !== 'orchestrator' && !x.info.machineId && !isMidTurn(x.info) && !this.keepIdle?.(x))
      .sort((a, b) => a.info.lastActivityAt.localeCompare(b.info.lastActivityAt));
    while (this.liveAgents() >= cap && idle.length) {
      const x = idle.shift()!;
      this.store.append(x.info.id, { kind: 'system', text: `Stopped while idle to make room for another agent (${cap} agent processes on this host at most). Its history is kept: a message resumes it.` });
      x.stop(true);
      stopped.push(x.info.id);
      console.log(`sessions: stopped idle ${x.info.id} to make room (limits.maxSessions + limits.maxIdleAgents = ${cap})`);
    }
    return stopped;
  }

  /** The host guard's gate (server/hostHealth.ts): why a new agent process on this host must wait. */
  startGate?: () => string | undefined;

  /**
   * Send, enforcing the concurrent-agent ceiling and the host guard when this send would start a process.
   * `bypassGate`: the host guard's own messages (resume after recovery, checkpoint requests).
   */
  /**
   * `hold` (w496: a worker's first prompt, its brief): what would refuse it now (the host guard, a machine's daemon that
   * is outdated or offline) queues it instead, and it goes as soon as it can, before any later message to the session.
   */
  send(id: string, text: string, from: 'human' | 'orchestrator' | 'system' = 'human', images?: ImageInput[], opts: { bypassGate?: boolean; requestedBy?: Requester; attachments?: DeliveredAttachment[]; hold?: boolean } = {}): string {
    const s = this.get(id);
    const queue = (why: string) =>
      this.enqueue({ uuid: randomUUID(), id, text, from, ...(images?.length ? { images } : {}), ...(opts.requestedBy ? { requestedBy: opts.requestedBy } : {}), ...(opts.attachments?.length ? { attachments: opts.attachments } : {}), ...(opts.bypassGate ? { bypassGate: true } : {}), at: new Date().toISOString(), why });
    // ALL RUNNING SLOTS BUSY (w384): the message waits and goes when a turn ends, instead of being refused. So does any
    // later message to a session that already has one waiting, so its messages keep their order.
    const full = this.fullFor(s) ?? (this.queue.some((q) => q.id === id) && !isMidTurn(s.info) ? 'an earlier message to it is still waiting' : undefined);
    if (full) return queue(full);
    if (opts.hold) {
      try {
        this.checkStart(id, opts.bypassGate);
      } catch (e) {
        return queue((e as Error).message);
      }
    } else this.checkStart(id, opts.bypassGate);
    if (!s.live && s.info.kind !== 'orchestrator' && !s.info.machineId) this.makeRoom(s);
    if (!opts.hold) return s.send(text, from, undefined, images, opts.requestedBy, opts.attachments);
    try {
      return s.send(text, from, undefined, images, opts.requestedBy, opts.attachments);
    } catch (e) {
      return queue((e as Error).message);
    }
  }

  /**
   * Throws when a message to this session would start a process on this host that the host guard refuses now; returns
   * the session. For a caller that copies files before sending. The agent limits never refuse: send() queues instead.
   */
  checkStart(id: string, bypassGate?: boolean): SessionHandle {
    const s = this.get(id);
    const startsHere = !s.live && s.info.kind !== 'orchestrator' && !s.info.machineId;
    const gate = startsHere && !bypassGate ? this.startGate?.() : undefined;
    if (gate) throw new Error(`not started: ${gate}`);
    return s;
  }

  /**
   * Compact an orchestrator's conversation now (w518: a person's `/compact [focus]`, or the dispatcher's button): what
   * to tell the person; throws why it cannot (mid-turn, compacting already, nothing to compact yet).
   */
  compact(id: string, instructions = '', by?: Requester, auto?: AutoCompaction): string {
    const s = this.get(id);
    if (s.info.kind !== 'orchestrator') throw new Error('/compact is for the orchestrators\' chats');
    if (!s.compact) throw new Error('this session cannot be compacted from here');
    return s.compact(instructions, by, auto);
  }

  /** Rename a session: one line, at most 80 characters. Returns the stored title. */
  setTitle(id: string, title: string): string {
    const s = this.get(id);
    const t = title.replace(/\s+/g, ' ').trim();
    if (!t) throw new Error('title is empty');
    if (t.length > 80) throw new Error(`title is ${t.length} characters; keep it to 80`);
    s.info.title = t;
    this.store.putSession(s.info);
    return t;
  }

  remove(id: string) {
    const s = this.get(id);
    s.stop();
    s.dispose?.();
    this.sessions.delete(id);
    this.store.removeSession(id);
    this.store.deleteTranscript(id);
  }

  /**
   * The server is stopping: every process goes (all of them, or those `which` picks), but what each was doing is kept
   * for the next server.
   */
  stopAll(which: (s: SessionHandle) => boolean = () => true) {
    for (const s of this.sessions.values()) if (which(s)) s.stop(false);
  }
}
