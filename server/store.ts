import { redactValue } from './secrets.ts';
import { SnapshotFile, dataRecoveries, isObject, readJsonDurable, writeFileDurable, type Check } from './durable.ts';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import zlib from 'node:zlib';
import type { AppSettings, DelegationRequest, Machine, Sandbox, ServerEvent, SessionInfo, StandingAgent, TranscriptEvent, WorkItem } from '../shared/types.ts';

/** Everything the UI hears about goes through here and out the WebSocket. */
export const bus = new EventEmitter<{ event: [ServerEvent] }>();
bus.setMaxListeners(100);
export const emit = (e: ServerEvent) => bus.emit('event', e);

interface Persisted {
  sandboxes: Sandbox[];
  sessions: SessionInfo[];
  /** The dispatcher (docs/orchestrators.md); before per-person orchestrators, the one shared orchestrator. */
  orchestratorId?: string;
  standingAgents?: StandingAgent[];
  delegations?: DelegationRequest[];
  machines?: Machine[];
  settings?: AppSettings;
}

/** Why a parsed state.json is not a sane one (server/durable.ts falls back to an earlier version then). */
export const checkState: Check = (v) => {
  if (!isObject(v)) return 'not a JSON object';
  for (const k of ['sandboxes', 'sessions'] as const) if (!Array.isArray(v[k])) return `no ${k} list`;
  for (const k of ['standingAgents', 'delegations', 'machines'] as const) if (v[k] !== undefined && !Array.isArray(v[k])) return `${k} is not a list`;
  for (const k of ['sandboxes', 'sessions', 'standingAgents', 'delegations', 'machines'] as const) {
    if (((v[k] as unknown[] | undefined) ?? []).some((x) => !isObject(x) || typeof x.id !== 'string')) return `an entry of ${k} has no id`;
  }
  return undefined;
};

export const checkWork: Check = (v) => {
  if (!isObject(v)) return 'not a JSON object';
  if (v.items !== undefined && (!Array.isArray(v.items) || v.items.some((x) => !isObject(x) || typeof x.id !== 'string'))) return 'items is not a list of work items';
  if (v.seq !== undefined && typeof v.seq !== 'number') return 'seq is not a number';
  return undefined;
};

/** state.json: a write starts at most 200 ms after a change and at most once a second (4.5 MB at 7,000 sessions). */
const STATE_SAVE = { delayMs: 200, intervalMs: 1000 };
const WORK_SAVE = { delayMs: 300, intervalMs: 1000 };

/**
 * The durable record: sandboxes and session metadata in one JSON file (rewritten whole), transcripts as one
 * append-only JSONL per session. No database, so no native modules to build on the Windows host. The JSON files are
 * crash-safe (server/durable.ts): fsynced before they replace the old file, the last versions kept beside them, and a
 * damaged one replaced by the newest good version at load.
 */
export class Store {
  readonly sandboxes = new Map<string, Sandbox>();
  readonly sessions = new Map<string, SessionInfo>();
  readonly standing = new Map<string, StandingAgent>();
  readonly delegations = new Map<string, DelegationRequest>();
  readonly machines = new Map<string, Machine>();
  /** The work ledger (docs/orchestrators.md), kept in its own file, data/work.json. */
  readonly work = new Map<string, WorkItem>();
  /** The number of the last work item ("w12" is 12). */
  workSeq = 0;
  /** The dispatcher's session id (the key keeps its old name: it was the one shared orchestrator). */
  orchestratorId?: string;
  settings: AppSettings = { heartbeatMinutes: null };
  private readonly stateFile: SnapshotFile;
  private readonly workFile: SnapshotFile;
  private readonly transcriptDir: string;
  private readonly uploadDir: string;
  private readonly seqs = new Map<string, number>();
  /** Transcripts whose last line this process has checked is complete (see appendLine). */
  private readonly tailChecked = new Set<string>();

  constructor(dataDir: string) {
    const file = path.join(dataDir, 'state.json');
    const workFile = path.join(dataDir, 'work.json');
    this.transcriptDir = path.join(dataDir, 'transcripts');
    this.uploadDir = path.join(dataDir, 'uploads');
    fs.mkdirSync(this.transcriptDir, { recursive: true });
    this.stateFile = new SnapshotFile(file, () => JSON.stringify(this.persisted(), null, 2), { ...STATE_SAVE, label: 'state' });
    this.workFile = new SnapshotFile(workFile, () => JSON.stringify({ seq: this.workSeq, items: [...this.work.values()] }, null, 2), { ...WORK_SAVE, label: 'work ledger' });
    const p = readJsonDurable<Persisted>(file, { check: checkState });
    if (p) {
      for (const s of p.sandboxes) this.sandboxes.set(s.id, s);
      for (const s of p.sessions) this.sessions.set(s.id, s);
      this.orchestratorId = p.orchestratorId;
      for (const a of p.standingAgents ?? []) this.standing.set(a.id, a);
      for (const d of p.delegations ?? []) this.delegations.set(d.id, d);
      for (const m of p.machines ?? []) this.machines.set(m.id, { ...m, online: false });
      this.settings = { ...this.settings, ...p.settings };
    }
    const w = readJsonDurable<{ seq?: number; items?: WorkItem[] }>(workFile, { check: checkWork });
    if (w) {
      for (const item of w.items ?? []) this.work.set(item.id, item);
      // An older version restored after a crash may not know the last few numbers handed out: skip past them.
      const restored = dataRecoveries.some((r) => r.file === workFile && r.from);
      this.workSeq = (w.seq ?? 0) + (restored ? 100 : 0);
    }
  }

  putSandbox(s: Sandbox) {
    this.sandboxes.set(s.id, s);
    this.save();
    emit({ type: 'sandbox', sandbox: s });
  }

  removeSandbox(id: string) {
    this.sandboxes.delete(id);
    this.save();
    emit({ type: 'sandbox_removed', id });
  }

  putSession(s: SessionInfo) {
    // A permission prompt shows a tool call's arguments: never a Claude OAuth token in state.json or on screen.
    if (s.pendingPermissions.length) s.pendingPermissions = redactValue(s.pendingPermissions);
    this.sessions.set(s.id, s);
    this.save();
    emit({ type: 'session', session: s });
  }

  removeSession(id: string) {
    this.sessions.delete(id);
    this.save();
    emit({ type: 'session_removed', id });
  }

  putStanding(a: StandingAgent) {
    this.standing.set(a.id, a);
    this.save();
    emit({ type: 'standing', agent: a });
  }

  removeStanding(id: string) {
    this.standing.delete(id);
    this.save();
    emit({ type: 'standing_removed', id });
  }

  putDelegation(d: DelegationRequest) {
    this.delegations.set(d.id, d);
    this.save();
    emit({ type: 'delegation', request: d });
  }

  /** Save a work item (data/work.json, its own file: state.json is rewritten on every session update). */
  putWork(w: WorkItem) {
    this.work.set(w.id, w);
    this.saveWork();
    emit({ type: 'work', item: w });
  }

  /** Forget work items (pruning closed ones); no event: pages drop them at their next state. */
  dropWork(ids: string[]) {
    for (const id of ids) this.work.delete(id);
    if (ids.length) this.saveWork();
  }

  private saveWork() {
    this.workFile.changed();
  }

  putSettings(patch: Partial<AppSettings>) {
    this.settings = { ...this.settings, ...patch };
    this.save();
    emit({ type: 'settings', settings: this.settings });
    return this.settings;
  }

  putMachine(m: Machine) {
    this.machines.set(m.id, m);
    this.save();
    emit({ type: 'machine', machine: m });
  }

  removeMachine(id: string) {
    this.machines.delete(id);
    this.save();
    emit({ type: 'machine_removed', id });
  }

  /** Persist an event whose seq was assigned elsewhere (a machine daemon). A seq already on file is ignored. */
  appendFull(sessionId: string, e: TranscriptEvent) {
    const last = this.seqs.get(sessionId) ?? this.lastSeq(sessionId);
    if (e.seq <= last) return;
    e = redactValue(e); // never a Claude OAuth token on disk or on screen (server/secrets.ts)
    this.appendLine(sessionId, JSON.stringify(e));
    this.seqs.set(sessionId, e.seq);
    emit({ type: 'transcript', sessionId, event: e });
    this.noteActivity(sessionId, e);
    this.observe(sessionId, e);
  }

  /** Told of every event written to a transcript, whether the session runs here or on a machine (the spend record, w859). */
  onEvent?: (sessionId: string, e: TranscriptEvent) => void;
  private observe(sessionId: string, e: TranscriptEvent) {
    try {
      this.onEvent?.(sessionId, e);
    } catch (err) {
      console.warn(`transcript observer failed for ${sessionId}: ${(err as Error).message}`);
    }
  }

  /** How many result lines a session's transcript holds (a turn each): 1 right after a session's first turn ended. */
  countResults(sessionId: string): number {
    const text = this.transcriptText(sessionId);
    return text === undefined ? 0 : text.split('"kind":"result"').length - 1;
  }

  private readonly pendingTools = new Map<string, { id: string; name: string; since: string }[]>();
  private readonly activitySaved = new Map<string, number>();

  /**
   * A session did something: an event (a tool call starting or ending, text, a result) or streamed output.
   * Moves lastActivityAt (saved at most every 15 s, at once when a tool call starts or ends) and keeps
   * activeTool: its oldest top-level tool call without a result yet, so a long foreground command reads
   * as "in a long command", not as silence. Works the same for sessions on a machine (their events land here).
   */
  noteActivity(sessionId: string, e?: TranscriptEvent) {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    const now = Date.now();
    let pending = this.pendingTools.get(sessionId) ?? [];
    const before = pending[0]?.id;
    if (e?.kind === 'tool_use' && !e.parentToolUseId) pending = [...pending, { id: e.toolUseId, name: e.name, since: e.t }];
    else if (e?.kind === 'tool_result') pending = pending.filter((p) => p.id !== e.toolUseId);
    else if (e?.kind === 'result' || e?.kind === 'error') pending = [];
    this.pendingTools.set(sessionId, pending);
    const toolChanged = pending[0]?.id !== before;
    if (!toolChanged && now - (this.activitySaved.get(sessionId) ?? 0) < 15_000) return;
    this.activitySaved.set(sessionId, now);
    s.lastActivityAt = new Date(now).toISOString();
    s.activeTool = pending[0];
    this.putSession(s);
  }

  lastSeq(sessionId: string): number {
    const n = this.seqs.get(sessionId);
    if (n !== undefined) return n;
    return this.readTranscript(sessionId, 1)[0]?.seq ?? 0;
  }

  append(sessionId: string, e: DistributiveOmit<TranscriptEvent, 'seq' | 't'>): TranscriptEvent {
    const seq = this.nextSeq(sessionId);
    const full = redactValue({ ...e, seq, t: new Date().toISOString() } as TranscriptEvent);
    this.appendLine(sessionId, JSON.stringify(full));
    emit({ type: 'transcript', sessionId, event: full });
    this.noteActivity(sessionId, full);
    this.observe(sessionId, full);
    return full;
  }

  /** Rewrite one already-persisted event (used to record a permission decision). */
  amend(sessionId: string, seq: number, patch: Partial<TranscriptEvent>) {
    this.unzip(sessionId);
    const all = this.readTranscript(sessionId);
    const i = all.findIndex((e) => e.seq === seq);
    if (i < 0) return;
    all[i] = redactValue({ ...all[i], ...patch } as TranscriptEvent);
    writeFileDurable(this.transcriptPath(sessionId), all.map((e) => JSON.stringify(e)).join('\n') + '\n', { generations: 0 });
    emit({ type: 'transcript', sessionId, event: all[i] });
  }

  readTranscript(sessionId: string, limit?: number): TranscriptEvent[] {
    const text = this.transcriptText(sessionId);
    if (text === undefined) return [];
    const lines = text.split('\n').filter(Boolean);
    const out: TranscriptEvent[] = [];
    for (const line of limit ? lines.slice(-limit) : lines) {
      try {
        // A crash can leave zero bytes where the last lines were; the next line then starts after them.
        out.push(JSON.parse(line.replace(/^\0+/, '')));
      } catch {
        // a torn last line after a crash; skip it
      }
    }
    return out;
  }

  /** The transcript's text, from its file or, once the data guard compressed it (server/dataGuard.ts), its .gz; undefined: none. */
  transcriptText(sessionId: string): string | undefined {
    const f = this.transcriptPath(sessionId);
    try {
      return fs.readFileSync(f, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    try {
      return zlib.gunzipSync(fs.readFileSync(`${f}.gz`)).toString('utf8');
    } catch {
      return undefined;
    }
  }

  /** Whether the session has a transcript on disk, plain or compressed. */
  hasTranscript(sessionId: string): boolean {
    const f = this.transcriptPath(sessionId);
    return fs.existsSync(f) || fs.existsSync(`${f}.gz`);
  }

  /** Transcripts the data guard compressed in this process: the next append to one restores its plain file. */
  private readonly compressed = new Set<string>();
  noteCompressed(sessionId: string) {
    this.compressed.add(sessionId);
  }

  /** A compressed transcript is written to again (the session was resumed): the plain file comes back first. */
  private unzip(sessionId: string) {
    const f = this.transcriptPath(sessionId);
    if (fs.existsSync(f) || !fs.existsSync(`${f}.gz`)) return;
    fs.writeFileSync(f, zlib.gunzipSync(fs.readFileSync(`${f}.gz`)));
    fs.rmSync(`${f}.gz`, { force: true });
  }

  /**
   * Append one event line. The first append to a transcript in this process makes sure the file ends with a newline:
   * after a crash its last line can be torn, and the next event would otherwise be glued to it and lost.
   */
  private appendLine(sessionId: string, line: string) {
    const f = this.transcriptPath(sessionId);
    // A compressed transcript (server/dataGuard.ts) gets its plain file back before an append: on the first append of this process,
    // and again whenever the guard compressed it since (noteCompressed), so a stat per event is not needed.
    if (!this.tailChecked.has(sessionId) || this.compressed.delete(sessionId)) this.unzip(sessionId);
    let prefix = '';
    if (!this.tailChecked.has(sessionId)) {
      this.tailChecked.add(sessionId);
      const last = lastByte(f);
      prefix = last === undefined || last === 0x0a ? '' : '\n';
    }
    fs.appendFileSync(f, prefix + line + '\n');
  }

  deleteTranscript(sessionId: string) {
    fs.rmSync(this.transcriptPath(sessionId), { force: true });
    fs.rmSync(`${this.transcriptPath(sessionId)}.gz`, { force: true });
    this.deleteUploads(sessionId);
  }

  /** The images a session's transcript shows (they go with the transcript). */
  deleteUploads(sessionId: string) {
    fs.rmSync(path.join(this.uploadDir, safeId(sessionId)), { recursive: true, force: true });
  }

  /** Keep an image with a session (sent by the user, or returned by a tool); returns its id. */
  saveImage(sessionId: string, mediaType: string, data: string, id: string = randomUUID()): string {
    const ext = IMAGE_EXT[mediaType];
    if (!ext) throw new Error(`unsupported image type ${mediaType}`);
    const dir = path.join(this.uploadDir, safeId(sessionId));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${safeId(id)}.${ext}`), Buffer.from(data, 'base64'));
    return id;
  }

  /** The file behind an ImageRef, or undefined. */
  imagePath(sessionId: string, id: string): string | undefined {
    const dir = path.join(this.uploadDir, safeId(sessionId));
    for (const ext of Object.values(IMAGE_EXT)) {
      const f = path.join(dir, `${safeId(id)}.${ext}`);
      if (fs.existsSync(f)) return f;
    }
    return undefined;
  }

  /** Where the transcripts are (for search). */
  get transcriptsDir() {
    return this.transcriptDir;
  }

  /** Events from `seq` on (to show an older search hit in context). */
  readTranscriptFrom(sessionId: string, seq: number): TranscriptEvent[] {
    return this.readTranscript(sessionId).filter((e) => e.seq >= seq);
  }

  private transcriptPath(id: string) {
    return path.join(this.transcriptDir, `${id}.jsonl`);
  }

  private nextSeq(sessionId: string) {
    let n = this.seqs.get(sessionId);
    if (n === undefined) {
      const last = this.readTranscript(sessionId, 1)[0];
      n = last ? last.seq : 0;
    }
    this.seqs.set(sessionId, n + 1);
    return n + 1;
  }

  /** Save state.json soon, in the background (STATE_SAVE). */
  save() {
    this.stateFile.changed();
  }

  /** Save now, on the main thread (shutdown, tests): state.json, and the work ledger when it has changes. */
  flush() {
    if (this.workFile.pending) this.workFile.flushSync();
    this.stateFile.flushSync();
  }

  /** Resolves once no background save is running or due (tests). */
  async saved() {
    await Promise.all([this.stateFile.idle(), this.workFile.idle()]);
  }

  private persisted(): Persisted {
    return {
      sandboxes: [...this.sandboxes.values()],
      sessions: [...this.sessions.values()],
      orchestratorId: this.orchestratorId,
      standingAgents: [...this.standing.values()],
      delegations: [...this.delegations.values()],
      machines: [...this.machines.values()],
      settings: this.settings,
    };
  }
}

/** A file's last byte, or undefined when it is missing or empty. */
function lastByte(f: string): number | undefined {
  let fd: number | undefined;
  try {
    fd = fs.openSync(f, 'r');
    const size = fs.fstatSync(fd).size;
    if (!size) return undefined;
    const b = Buffer.alloc(1);
    fs.readSync(fd, b, 0, 1, size - 1);
    return b[0];
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export const IMAGE_EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg' };

/** Ids become file names: keep them to [\w-]. */
const safeId = (id: string) => id.replace(/[^\w-]/g, '_');

export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
