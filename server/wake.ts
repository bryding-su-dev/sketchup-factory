import fs from 'node:fs';
import type { SessionManager } from './sessions.ts';
import type { Store } from './store.ts';
import type { Sandbox, SessionInfo } from '../shared/types.ts';
import { checkObject, readJsonDurable, writeJsonDurable } from './durable.ts';

const BUSY: SessionInfo['status'][] = ['running', 'starting', 'waiting_permission'];

/** A pending wake as kept in data/wakes.json. */
interface WakeRecord {
  at: number;
  note: string;
}

/** Tries to deliver a wake whose session could not be started (the agent limit, the host guard): once a minute. */
const RETRIES = 10;

/**
 * Timed wake-ups (docs: the wake_me tools). An agent that wants to check back later ends its turn;
 * after N minutes it gets a message with its own note. Plus the orchestrator's optional heartbeat:
 * while any worker is mid-turn, a short "who is busy" message every N minutes.
 * Pending wakes are kept in `file` (data/wakes.json): restore() re-arms them after a restart or a crash,
 * and one that came due while the server was down fires at once.
 */
export class Waker {
  private readonly sessions: SessionManager;
  private readonly store: Store;
  private readonly file?: string;
  private readonly timers = new Map<string, { timer: NodeJS.Timeout } & WakeRecord>();
  /** Per orchestrator woken by the heartbeat: when it last was, and since when its person's workers are busy. */
  private readonly lastBeat = new Map<string, number>();
  private readonly busySince = new Map<string, number>();
  now: () => number = Date.now;

  constructor(sessions: SessionManager, store: Store, file?: string) {
    this.sessions = sessions;
    this.store = store;
    this.file = file;
  }

  /** Message `sessionId` with `note` after `minutes` (one pending wake per session: a new one replaces it). */
  schedule(sessionId: string, minutes: number, note: string): string {
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > 24 * 60) throw new Error('minutes must be between 1 and 1440');
    this.sessions.get(sessionId);
    const at = this.now() + minutes * 60_000;
    this.arm(sessionId, { at, note: note.trim().slice(0, 2000) });
    this.save();
    return `I will message you at ${new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} (${minutes} min) with your note. End your turn now; that message resumes you.`;
  }

  cancel(sessionId: string) {
    const t = this.timers.get(sessionId);
    if (!t) return false;
    clearTimeout(t.timer);
    this.timers.delete(sessionId);
    this.save();
    return true;
  }

  pending(sessionId: string) {
    const t = this.timers.get(sessionId);
    return t ? { at: new Date(t.at).toISOString(), note: t.note } : undefined;
  }

  /**
   * After a restart: arm the wakes the last server left in the file. One whose time passed while the server
   * was down fires at once, saying how late it is; one for a session that no longer exists is dropped.
   * Returns how many were re-armed.
   */
  restore(): number {
    if (!this.file) return 0;
    let saved: Record<string, WakeRecord> = {};
    try {
      saved = readJsonDurable<Record<string, WakeRecord>>(this.file, { check: checkObject }) ?? {};
    } catch {
      return 0; // none, or unreadable
    }
    let n = 0;
    for (const [id, w] of Object.entries(saved)) {
      if (!this.sessions.sessions.has(id) || !Number.isFinite(w?.at) || this.timers.has(id)) continue;
      this.arm(id, { at: w.at, note: String(w.note ?? '') });
      n++;
    }
    this.save();
    return n;
  }

  private arm(sessionId: string, w: WakeRecord, tries = 0, delay = Math.max(0, w.at - this.now())) {
    const old = this.timers.get(sessionId);
    if (old) clearTimeout(old.timer);
    const timer = setTimeout(() => this.fire(sessionId, tries), delay);
    timer.unref?.();
    this.timers.set(sessionId, { timer, ...w });
  }

  private save() {
    if (!this.file) return;
    const out: Record<string, WakeRecord> = {};
    for (const [id, t] of this.timers) out[id] = { at: t.at, note: t.note };
    try {
      writeJsonDurable(this.file, out, { indent: 2 });
    } catch (e) {
      console.warn('wake_me: could not save the pending wakes:', (e as Error).message);
    }
  }

  private fire(sessionId: string, tries: number) {
    const t = this.timers.get(sessionId);
    this.timers.delete(sessionId);
    if (!t || !this.sessions.sessions.has(sessionId)) return void this.save();
    const late = Math.round((this.now() - t.at) / 60_000);
    const when = late >= 2 ? ` (${late} min late: SketchUp Factory was restarting)` : '';
    try {
      this.sessions.send(sessionId, `[wake_me] Time is up${when}. Your note: ${t.note || '(none)'}`, 'system');
    } catch (e) {
      // At the agent limit, the host guard says wait, or its machine is offline: try again in a minute, a few times.
      if (tries < RETRIES) return this.arm(sessionId, { at: t.at, note: t.note }, tries + 1, 60_000);
      this.store.append(sessionId, { kind: 'system', text: `wake_me could not wake this session: ${(e as Error).message}` });
    }
    this.save();
  }

  // ---------------------------------------------------------------- the heartbeat

  /**
   * Called every minute for each orchestrator whose person turned the heartbeat on (docs/orchestrators.md): wakes it
   * with the busy list when a beat is due. `mine` picks that person's workers (default: every worker); `extra` adds a
   * line (the intake's: Discord and FFBox requests waiting for approval or for this person, docs/intake.md).
   */
  heartbeat(orchestratorId: string | undefined, minutes: number | null | undefined, describe: (s: SessionInfo) => string, mine: (s: SessionInfo) => boolean = () => true, extra: () => string = () => '') {
    if (!orchestratorId) return;
    const busy = [...this.store.sessions.values()].filter((s) => s.kind === 'worker' && BUSY.includes(s.status) && mine(s));
    const now = this.now();
    if (!busy.length) {
      this.busySince.delete(orchestratorId);
      return;
    }
    if (!this.busySince.has(orchestratorId)) this.busySince.set(orchestratorId, now);
    if (!minutes) return;
    const since = Math.max(this.lastBeat.get(orchestratorId) ?? 0, this.busySince.get(orchestratorId)!);
    if (now - since < minutes * 60_000) return;
    const orch = this.store.sessions.get(orchestratorId);
    if (!orch || BUSY.includes(orch.status)) return; // it is working already; next minute
    this.lastBeat.set(orchestratorId, now);
    const lines = busy.map((s) => `- ${describe(s)}`);
    const more = extra();
    if (more) lines.push(more);
    try {
      this.sessions.send(orchestratorId, `[heartbeat] ${busy.length} worker(s) busy:\n${lines.join('\n')}\nPost the user a one-line status (what each is doing, anything stuck or waiting on them). No tool calls needed unless something looks wrong.`, 'system');
    } catch {
      // the orchestrator could not be started; try at the next beat
    }
  }
}

/** One line per busy worker for the heartbeat: where, what, for how long, last word. */
export function describeBusy(s: SessionInfo, where: { sandbox?: Sandbox; machine?: string }, now = Date.now()): string {
  const place = where.sandbox ? `in ${where.sandbox.id}` : where.machine ? `on ${where.machine}` : '';
  const state = s.status === 'waiting_permission' ? 'WAITING FOR A PERMISSION' : `${s.status}${s.statusDetail ? ` (${s.statusDetail})` : ''}`;
  return `${s.id} "${s.title}" ${place}: ${state}, ${activityLine(s, now)}, ${s.turns} turns, $${s.costUsd.toFixed(2)}`;
}

/**
 * "last activity N min ago", or "in a long command: Bash (N min)" while one of its tool calls runs longer
 * than a minute (a foreground build or wait loop is work, not silence).
 */
export function activityLine(s: Pick<SessionInfo, 'lastActivityAt' | 'activeTool' | 'status'>, now = Date.now()): string {
  const mins = (t: string) => Math.max(0, Math.round((now - Date.parse(t)) / 60_000));
  const busy = s.status === 'running' || s.status === 'starting' || s.status === 'waiting_permission';
  if (busy && s.activeTool && now - Date.parse(s.activeTool.since) >= 60_000) return `in a long command: ${s.activeTool.name} (${mins(s.activeTool.since)} min)`;
  return `last activity ${mins(s.lastActivityAt)} min ago`;
}

/**
 * Unity log markers for wait_for_unity. Unity 6 prints one of the "done" lines after every script
 * compile and domain reload, and the "failed" ones when the compile has errors.
 */
export const COMPILE_DONE = /Reloading assemblies after (?:successful|finishing) script compilation|Domain Reload Profiling|\*\*\* Tundra build success/;
export const COMPILE_FAILED = /error CS\d{4}|Scripts have compiler errors|\*\*\* Tundra build failed/;

/** Log text appended to `file` since byte `offset` (bounded to the last 2 MB). */
export function readSince(file: string, offset: number): { text: string; size: number } {
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    return { text: '', size: 0 };
  }
  if (size < offset) offset = 0; // the log was rotated (editor restarted)
  const start = Math.max(offset, size - 2 * 1024 * 1024);
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    return { text: buf.toString('utf8'), size };
  } finally {
    fs.closeSync(fd);
  }
}
