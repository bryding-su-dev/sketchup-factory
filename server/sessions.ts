import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { query, type Options, type PermissionResult, type Query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { Config } from './config.ts';
import type { Store } from './store.ts';
import type { DeliveredAttachment, EffortLevel, ImageInput, ImageRef, OrchestratorRole, PendingPermission, PermissionMode, Requester, SessionInfo, SessionKind } from '../shared/types.ts';
import { attachmentBlock } from '../shared/attachments.ts';
import { emit } from './store.ts';
import { accountKeyOf } from './usage.ts';
import type { SessionSnapshot, Unanswered } from './restart.ts';

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
 * What the model reads for a message: the orchestrator's briefs are marked as such, and in the orchestrator's
 * chat, which several people share, each person's message starts with who wrote it.
 */
export function promptText(kind: SessionKind, text: string, from: 'human' | 'orchestrator' | 'system', requestedBy?: Requester): string {
  if (from === 'orchestrator') return `[from the orchestrator${requestedBy ? `, for ${requestedBy.displayName}` : ''}]\n${text}`;
  if (from === 'human' && kind === 'orchestrator' && requestedBy) return `[from ${requestedBy.displayName}]\n${text}`;
  return text;
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + `\n… (${s.length - n} more chars)` : s);

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
    this.outstanding.set(uuid, { text, from });
    // Images arrive stored already (with an id) or are kept here, so the transcript can show them.
    const refs = images.map((i) => ({ id: i.id ?? this.store.saveImage(this.info.id, i.mediaType, i.data), mediaType: i.mediaType }));
    this.store.append(this.info.id, { kind: 'user', text, from, uuid, ...(refs.length ? { images: refs } : {}), ...(attachments.length ? { attachments } : {}), ...(requestedBy ? { requestedBy } : {}) });
    // The files come after the text, as a block the agent reads as data (shared/attachments.ts).
    const files = attachmentBlock(attachments, this.info.kind === 'orchestrator' ? 'orchestrator' : 'worker');
    this.input!.push(promptText(this.info.kind, files ? (text ? `${text}\n\n${files}` : files) : text, from, requestedBy), uuid, images);
    const opens = !this.info.turnOpenSince;
    this.update({ status: 'running', statusDetail: undefined, ...(opens ? { turnOpenSince: new Date().toISOString() } : {}) });
    if (opens) this.store.flush?.();
    return uuid;
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
            this.events.emit('turnEnd', this, this.lastTurnText);
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
        const text = m.subtype === 'success' ? m.result : `stopped: ${m.subtype}`;
        for (const u of m.user_message_uuids ?? (m.user_message_uuid ? [m.user_message_uuid] : [])) this.outstanding.delete(u);
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
        this.update({ turns: this.info.turns + 1, costUsd: this.costBase + total, lastResult: clip(text, 1200) });
        this.events.emit('result', this, m.subtype);
        if (!this.stateEvents) {
          // Older CLI without state events: best effort from the result itself.
          const queued = (m as { queued_turn_count?: number }).queued_turn_count ?? 0;
          if (!queued) this.outstanding.clear();
          this.update({ status: queued > 0 ? 'running' : this.pending.size ? 'waiting_permission' : 'idle', ...(queued > 0 ? {} : { turnOpenSince: undefined }) });
          this.events.emit('turnEnd', this, text);
        }
        return;
      }
      default:
        return;
    }
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
   * 'turnEnd' (session, text) and 'permission' (session, pending) — the orchestrator listens;
   * 'result' (session, subtype) after every turn result and 'ended' (session) when the process
   * goes away — standing agents track their runs with these.
   */
  readonly events = new EventEmitter();
  private readonly cfg: Config;
  private readonly store: Store;
  private readonly factories = new Map<string, OptionsFactory>();

  constructor(cfg: Config, store: Store) {
    this.cfg = cfg;
    this.store = store;
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
   * Live agent processes on THIS host that count toward limits.maxSessions: workers and running
   * standing agents. Sessions on a machine count toward that machine's own limit instead.
   */
  liveAgents() {
    return [...this.sessions.values()].filter((s) => s.info.kind !== 'orchestrator' && !s.info.machineId && s.live).length;
  }

  /** The host guard's gate (server/hostHealth.ts): why a new agent process on this host must wait. */
  startGate?: () => string | undefined;

  /**
   * Send, enforcing the concurrent-agent ceiling and the host guard when this send would start a process.
   * `bypassGate`: the host guard's own messages (resume after recovery, checkpoint requests).
   */
  send(id: string, text: string, from: 'human' | 'orchestrator' | 'system' = 'human', images?: ImageInput[], opts: { bypassGate?: boolean; requestedBy?: Requester; attachments?: DeliveredAttachment[] } = {}): string {
    const s = this.checkStart(id, opts.bypassGate);
    return s.send(text, from, undefined, images, opts.requestedBy, opts.attachments);
  }

  /**
   * Throws when a message to this session would start a process on this host that the concurrent-agent ceiling or the
   * host guard refuses now (what send() checks); returns the session. For a caller that copies files before sending.
   */
  checkStart(id: string, bypassGate?: boolean): SessionHandle {
    const s = this.get(id);
    const startsHere = !s.live && s.info.kind !== 'orchestrator' && !s.info.machineId;
    if (startsHere && this.liveAgents() >= this.cfg.limits.maxSessions) {
      throw new Error(`already ${this.cfg.limits.maxSessions} agents running (limits.maxSessions); stop one first`);
    }
    const gate = startsHere && !bypassGate ? this.startGate?.() : undefined;
    if (gate) throw new Error(`not started: ${gate}`);
    return s;
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
