import fs from 'node:fs';
import path from 'node:path';
import type { DrainStatus, SessionInfo, SessionKind } from '../shared/types.ts';
import { writeJsonDurable } from './durable.ts';

/**
 * Restarts that do not lose work (docs/restart.md). Before the server stops it records which agent
 * sessions were mid-turn or had unanswered messages (data/resume.json); the next server resumes
 * exactly those and tells the orchestrator what happened. A drain first asks busy workers to commit,
 * push and end their turn, and waits (bounded) until no agent is mid-turn.
 */

export interface Unanswered {
  text: string;
  from: 'human' | 'orchestrator' | 'system';
}

/** What collectResume needs to know about one session at shutdown. */
export interface SessionSnapshot {
  id: string;
  kind: SessionKind;
  title: string;
  sandboxId?: string;
  /** Set for a session that runs on one of the user's Macs (server/machines.ts). */
  machineId?: string;
  status: SessionInfo['status'];
  /** Messages sent to it that no finished turn has answered yet (queued, or the one being worked on). */
  unanswered: Unanswered[];
  /** Who sent the message that started its current turn; decides whether the orchestrator hears when it ends. */
  lastFrom: 'human' | 'orchestrator' | 'system';
  /** Its turn was still open (SessionInfo.turnOpenSince), even if its process ended a moment before the server. */
  turnOpen?: boolean;
  /** Background tasks still open when it stopped (a background command, a watcher that would have woken it). */
  backgroundTasks?: number;
  /** A person or the orchestrator stopped or interrupted it since its last message: never resumed. */
  stoppedOnPurpose?: boolean;
}

export type ResumeWhy = 'mid-turn' | 'queued' | 'drained' | 'background';

export interface ResumeEntry {
  id: string;
  kind: SessionKind;
  title: string;
  sandboxId?: string;
  machineId?: string;
  why: ResumeWhy;
  unanswered: Unanswered[];
  lastFrom: SessionSnapshot['lastFrom'];
}

export interface ResumeFile {
  version: 1;
  /** Why the server stopped, in words ("restart", "update (request_app_update)"). */
  reason: string;
  update: boolean;
  at: string;
  /** This app's git HEAD at shutdown, to report what an update changed. */
  head?: string;
  /** This app's version (package.json) when it stopped; absent in files written before 0.1.0. */
  appVersion?: string;
  sessions: ResumeEntry[];
  /** The orchestrator was itself mid-turn or had messages waiting. */
  orchestratorBusy: boolean;
  /**
   * Set when the stop was NOT clean (a power cut, a crash, a kill): what happened, in words. The file is then
   * made by the next server from what the last one left (the cut-off sessions, the editors that were up).
   */
  cause?: string;
  /** Sandboxes whose editors were up and died with the stop: started again before their agents resume. */
  editors?: string[];
}

export const DRAIN_TAG = '[app restart pending]';

const BUSY: ReadonlySet<SessionInfo['status']> = new Set(['running', 'starting', 'waiting_permission']);

export const isBusy = (status: SessionInfo['status']) => BUSY.has(status);

/**
 * The sessions to resume after the restart: workers that were mid-turn, had unanswered messages, were
 * asked by a drain to pause, or had background tasks the restart ends. Idle sessions stay idle, and so
 * does a worker a person or the orchestrator stopped or interrupted. Standing agents are left to their
 * own scheduler (a cut-off run is recorded as interrupted and the schedule continues). The orchestrator
 * is not resumed here: the restart summary wakes it anyway.
 */
export function collectResume(sessions: SessionSnapshot[], drained: ReadonlySet<string> = new Set()): ResumeEntry[] {
  const out: ResumeEntry[] = [];
  for (const s of sessions) {
    if (s.kind !== 'worker' || s.stoppedOnPurpose) continue;
    // The drain's own request is not work to resume.
    const unanswered = s.unanswered.filter((u) => !u.text.startsWith(DRAIN_TAG));
    const why: ResumeWhy | undefined =
      isBusy(s.status) || s.turnOpen ? 'mid-turn' : unanswered.length ? 'queued' : drained.has(s.id) ? 'drained' : s.backgroundTasks ? 'background' : undefined;
    if (!why) continue;
    out.push({ id: s.id, kind: s.kind, title: s.title, sandboxId: s.sandboxId, machineId: s.machineId, why, unanswered: unanswered.slice(-5), lastFrom: s.lastFrom });
  }
  return out;
}

export function orchestratorWasBusy(sessions: SessionSnapshot[]): boolean {
  return sessions.some((s) => s.kind === 'orchestrator' && (isBusy(s.status) || !!s.turnOpen || s.unanswered.length > 0));
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/** The message a resumed worker gets. */
export function resumeMessage(e: ResumeEntry, f: Pick<ResumeFile, 'reason' | 'at' | 'cause' | 'editors'>): string {
  const when = new Date(f.at).toLocaleString();
  const editorRestarted = !!e.sandboxId && !!f.editors?.includes(e.sandboxId);
  // Sessions on a machine (one of the user's Macs) have a clone of their own and no managed Unity editor.
  const lines = [
    f.cause
      ? `${f.cause}. The app is back and resumes you now. Your process was stopped; ${e.machineId ? 'your working tree' : 'the worktree'} and your history are intact${editorRestarted ? ', and your Unity editor is being started again: wait for it (mcp__sandbox__wait_for_unity, until "ready") before any Unity call' : e.machineId ? '' : '; your Unity editor was not running'}.`
      : e.machineId
        ? `The app restarted (${f.reason} at ${when}). Your process was stopped; your working tree and your history are intact.`
        : `The app restarted (${f.reason} at ${when}). Your process was stopped; the worktree, the Unity editor and your history are intact.`,
    e.why === 'drained'
      ? 'You were asked to pause for the restart; pick the task up again.'
      : e.why === 'background'
        ? 'You had background tasks running (a background command, or a watcher meant to wake you); the restart ended them. Check what they were for, and run again or re-arm what still matters (wake_me to check back later).'
        : 'Your last turn was cut off mid-way, so a tool call may not have finished.',
    e.machineId
      ? 'Check git status for half-written edits and continue where you left off.'
      : 'Check git status for half-written edits, re-pin your Unity instance (read mcpforunity://instances, then set_active_instance), and continue where you left off.',
  ];
  const pending = e.unanswered.filter((u) => u.text.trim());
  if (pending.length) {
    lines.push('', 'Messages you had not answered yet, oldest first:');
    for (const u of pending) lines.push(`- (${u.from}) ${clip(u.text.replace(/\s+/g, ' ').trim(), 600)}`);
  }
  return lines.join('\n');
}

export interface ResumeOutcome {
  id: string;
  title: string;
  sandboxId?: string;
  machineId?: string;
  ok: boolean;
  error?: string;
}

export interface UpdateResult {
  ok: boolean;
  at: string;
  error?: string;
  headBefore?: string;
  headAfter?: string;
}

/** The running app after a restart: its git HEAD and package.json version. */
export interface AppNow {
  head?: string;
  version?: string;
}

/** "Version 0.1.0 → 0.2.0." / "Version 0.2.0 (unchanged)." / "Now version 0.2.0." ("" when unknown). */
export function versionLine(before: string | undefined, after: string | undefined): string {
  if (!after) return '';
  if (!before) return `Now version ${after}.`;
  return before === after ? `Version ${after} (unchanged).` : `Version ${before} → ${after}.`;
}

/** The one paragraph the orchestrator gets after a restart. */
export function restartSummary(f: ResumeFile, outcomes: ResumeOutcome[], update: UpdateResult | undefined, now: AppNow, notes: string[] = []): string {
  const head = now.head;
  const parts: string[] = f.cause
    ? [`[app restarted] SketchUp Factory restarted WITHOUT a clean stop: ${f.cause}.${f.update ? ` The update that was pending then (${f.reason}) was retried.` : ''}`]
    : [`[app restarted] SketchUp Factory restarted (${f.reason}; stopped at ${new Date(f.at).toLocaleTimeString()}).`];
  const version = versionLine(f.appVersion, now.version);
  if (version) parts.push(version);
  if (f.update) {
    if (!update) parts.push('Update result: unknown (no data/update.result.json; see data/supervisor.log).');
    else if (!update.ok) parts.push(`Update FAILED: ${clip(update.error ?? 'unknown error', 400)}; the server runs whatever code is on disk.`);
    else parts.push(`Update OK${update.headBefore && update.headAfter ? ` (${update.headBefore.slice(0, 9)} → ${update.headAfter.slice(0, 9)})` : ''}.`);
  } else if (f.head && head && f.head !== head) {
    parts.push(`Code changed ${f.head.slice(0, 9)} → ${head.slice(0, 9)}.`);
  }
  const ok = outcomes.filter((o) => o.ok);
  const bad = outcomes.filter((o) => !o.ok);
  const name = (o: ResumeOutcome) => `"${o.title}" (${o.id}${o.sandboxId ? ` in ${o.sandboxId}` : o.machineId ? ` on ${o.machineId}` : ''})`;
  if (ok.length) parts.push(`Resumed automatically: ${ok.map(name).join(', ')}.`);
  else parts.push('No worker sessions needed resuming.');
  if (bad.length) parts.push(`Could not resume: ${bad.map((o) => `${name(o)}: ${o.error}`).join('; ')}.`);
  if (f.editors?.length) parts.push(`Unity editors that were up: ${f.editors.join(', ')} (started again before their agents resumed).`);
  if (f.orchestratorBusy) parts.push('You were mid-turn yourself when it stopped; check what you were doing.');
  parts.push(...notes);
  parts.push('Tell the user in a line if anything needs them; otherwise carry on.');
  return parts.join(' ');
}

/**
 * The workers a restart did not resume because they were not working: idle, waiting on a wake_me the restart kept
 * (Waker.restore). Without this line a worker between turns looks stopped and forgotten (w311: f6b32781 on
 * lothdesktop/pr-fix ended its turn at 21:46:53 with a 21-minute wake, the restart came at 22:04:30, and the wake
 * fired on time at 22:07:36, but the report named it nowhere). `resumed`: ids the report already lists.
 */
export function waitingOnWakeLine(
  wakes: { sessionId: string; at: number }[],
  info: (id: string) => { title: string; kind: string; sandboxId?: string; machineId?: string; machineSandbox?: string } | undefined,
  resumed: Set<string>,
  nowMs: number,
): string | undefined {
  const items = wakes.flatMap((w) => {
    const i = info(w.sessionId);
    if (!i || i.kind !== 'worker' || resumed.has(w.sessionId)) return [];
    const where = i.sandboxId ? ` in ${i.sandboxId}` : i.machineId ? ` on ${i.machineId}${i.machineSandbox ? `/${i.machineSandbox}` : ''}` : '';
    const mins = Math.round((w.at - nowMs) / 60_000);
    const when = mins <= 0 ? 'now (it was due while FF Factory was down)' : `at ${new Date(w.at).toLocaleTimeString()} (in ${mins} min)`;
    return [`"${i.title}" (${w.sessionId}${where}) ${when}`];
  });
  return items.length ? `Between turns, waiting on their wake_me (kept across the restart; it wakes them, nothing to resume): ${items.join(', ')}.` : undefined;
}

// ---------------------------------------------------------------- files

/** PowerShell 5.1 writes UTF-8 with a byte order mark. */
const stripBom = (s: string) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

export const RESUME_FILE = 'resume.json';
export const UPDATE_RESULT_FILE = 'update.result.json';

export function writeResumeFile(dataDir: string, f: ResumeFile) {
  writeJsonDurable(path.join(dataDir, RESUME_FILE), f, { indent: 2, generations: 0 });
}

/** Read and retire the resume file (renamed first, so a crash while resuming cannot resume twice). */
export function takeResumeFile(dataDir: string): ResumeFile | undefined {
  const p = path.join(dataDir, RESUME_FILE);
  if (!fs.existsSync(p)) return undefined;
  const done = path.join(dataDir, 'resume.done.json');
  fs.rmSync(done, { force: true });
  fs.renameSync(p, done);
  try {
    const f = JSON.parse(fs.readFileSync(done, 'utf8')) as ResumeFile;
    return f.version === 1 && Array.isArray(f.sessions) ? f : undefined;
  } catch {
    return undefined;
  }
}

/** The supervisor's record of the last update, if it is newer than `since`. */
export function readUpdateResult(dataDir: string, since: string): UpdateResult | undefined {
  try {
    const r = JSON.parse(stripBom(fs.readFileSync(path.join(dataDir, UPDATE_RESULT_FILE), 'utf8'))) as UpdateResult;
    return Date.parse(r.at) >= Date.parse(since) ? r : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------- restart requests

/**
 * data/restart.request: empty means "stop now" (what older scripts write). JSON asks for a drain first:
 * { drain: true | false | "auto", drainMinutes, reason, update, hold }. With hold, the server does not exit
 * after draining: it writes data/drain.done and waits for a plain restart.request (scripts/restart.ps1
 * stops the supervisor in between); if none comes it gives up and carries on.
 */
export interface RestartRequest {
  drain: boolean | 'auto';
  drainMinutes: number;
  reason: string;
  update: boolean;
  hold: boolean;
}

export function parseRestartRequest(text: string): RestartRequest | 'now' {
  const t = stripBom(text).trim();
  if (!t) return 'now';
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(t);
  } catch {
    return 'now';
  }
  if (!j || typeof j !== 'object') return 'now';
  const drain = j.drain === 'auto' || j.drain === true || j.drain === false ? j.drain : 'auto';
  const mins = Number(j.drainMinutes);
  return {
    drain,
    drainMinutes: Number.isFinite(mins) && mins >= 0 ? Math.min(mins, 120) : 10,
    reason: typeof j.reason === 'string' && j.reason.trim() ? j.reason.trim().slice(0, 200) : 'restart',
    update: j.update === true,
    hold: j.hold === true,
  };
}

// ---------------------------------------------------------------- drain

export interface DrainDeps {
  /** Snapshot of every session now. */
  snapshot(): SessionSnapshot[];
  /** Send a system message to a session (may throw). */
  tell(id: string, text: string): void;
  /** Stop: write the resume file (with these drained ids) and exit. */
  stop(req: RestartRequest, drained: ReadonlySet<string>): void;
  /** Tell the UI the drain state changed. */
  changed(): void;
  log(line: string): void;
  /** Where the hold handshake file goes. */
  dataDir: string;
}

export function drainMessage(req: RestartRequest, deadline: Date): string {
  return (
    `${DRAIN_TAG} SketchUp Factory will restart for ${req.reason}${req.update ? ' (an update)' : ''}, at the latest ${deadline.toLocaleTimeString()}. ` +
    'Reach a safe point now: commit your work on your sandbox branch (a WIP commit is fine) and push it, then end your turn with a one-line status. ' +
    'Do not start anything long. You will be resumed automatically after the restart, with your history, worktree and Unity editor intact.'
  );
}

/** The workers a drain waits for: busy ones. The orchestrator and standing agents are not waited for. */
export function busyWorkers(sessions: SessionSnapshot[]): SessionSnapshot[] {
  return sessions.filter((s) => s.kind === 'worker' && isBusy(s.status));
}

const GRACE_MS = 5000;

export class Drainer {
  status?: DrainStatus;
  private req?: RestartRequest;
  private drained = new Set<string>();
  private timer?: NodeJS.Timeout;
  private holdUntil?: number;
  private readonly deps: DrainDeps;

  constructor(deps: DrainDeps) {
    this.deps = deps;
  }

  /** Start a restart. Returns a one-line note for whoever asked. */
  request(req: RestartRequest): string {
    if (this.req) return `a restart is already pending (${this.req.reason}); it proceeds once agents are idle or by ${this.status?.deadline ?? 'its deadline'}`;
    const busy = busyWorkers(this.deps.snapshot());
    if (req.drain === false || !busy.length || req.drainMinutes === 0) {
      this.req = req;
      this.deps.log(`restart (${req.reason}): ${busy.length ? `not draining; ${busy.length} busy agent(s) will be resumed after it` : 'no agent is busy'}`);
      // A few seconds' grace so a tool call's reply reaches its caller before the server stops.
      if (req.hold) this.finish();
      else setTimeout(() => this.finish(), GRACE_MS);
      return busy.length ? `restarting now; ${busy.length} busy agent(s) are resumed after the restart` : 'restarting now (no agent is busy)';
    }
    this.req = req;
    const deadline = new Date(Date.now() + req.drainMinutes * 60_000);
    for (const s of busy) {
      try {
        this.deps.tell(s.id, drainMessage(req, deadline));
        this.drained.add(s.id);
      } catch (e) {
        this.deps.log(`drain: could not message ${s.id}: ${(e as Error).message}`);
      }
    }
    this.status = { reason: req.reason, update: req.update, startedAt: new Date().toISOString(), deadline: deadline.toISOString(), waitingFor: busy.map((s) => s.id) };
    this.deps.log(`drain (${req.reason}): asked ${busy.length} busy agent(s) to wrap up; waiting until ${deadline.toISOString()}`);
    this.deps.changed();
    this.timer = setInterval(() => this.check(), 3000);
    return `draining: asked ${busy.length} busy agent(s) to commit, push and end their turn; the restart follows when they are idle, at the latest in ${req.drainMinutes} min`;
  }

  private check() {
    if (!this.req || !this.status) return;
    if (this.holdUntil !== undefined) {
      if (Date.now() > this.holdUntil) this.giveUp('nothing stopped the server after the drain');
      return;
    }
    const busy = busyWorkers(this.deps.snapshot()).map((s) => s.id);
    const late = Date.now() >= Date.parse(this.status.deadline);
    if (busy.join() !== this.status.waitingFor.join()) {
      this.status = { ...this.status, waitingFor: busy };
      this.deps.changed();
    }
    if (busy.length && !late) return;
    this.deps.log(busy.length ? `drain: deadline reached with ${busy.length} agent(s) still busy; they are resumed after the restart` : 'drain: all agents idle');
    this.finish();
  }

  private finish() {
    const req = this.req!;
    if (req.hold) {
      // scripts/restart.ps1 is waiting for this, then stops the supervisor and asks for the real stop.
      fs.writeFileSync(path.join(this.deps.dataDir, 'drain.done'), new Date().toISOString());
      this.holdUntil = Date.now() + 5 * 60_000;
      this.timer ??= setInterval(() => this.check(), 3000);
      this.deps.log('drain: done; holding for scripts/restart.ps1 to stop the server');
      return;
    }
    clearInterval(this.timer);
    this.deps.stop(req, this.drained);
  }

  /** A plain stop request arrived (restart.ps1 after the hold, or an old script): stop with what we drained. */
  stopNow(fallback: RestartRequest) {
    clearInterval(this.timer);
    this.deps.stop(this.req ?? fallback, this.drained);
  }

  private giveUp(why: string) {
    clearInterval(this.timer);
    this.timer = undefined;
    this.deps.log(`drain: cancelled (${why}); carrying on`);
    fs.rmSync(path.join(this.deps.dataDir, 'drain.done'), { force: true });
    for (const id of this.drained) {
      try {
        this.deps.tell(id, '[app restart cancelled] The restart did not happen. Carry on with your task.');
      } catch {
        // gone or at a limit
      }
    }
    this.req = undefined;
    this.status = undefined;
    this.holdUntil = undefined;
    this.drained = new Set();
    this.deps.changed();
  }

  get drainedIds(): ReadonlySet<string> {
    return this.drained;
  }
}

// ---------------------------------------------------------------- unclean stops (a power cut, a crash)

export const ALIVE_FILE = 'alive.json';
export const UNCLEAN_RECOVERY_FILE = 'unclean-recovery.last';

/**
 * Whether this unclean start may bring agents back: not when the last one did so within `withinMs` (a crash
 * loop must not keep restarting paid turns). Records this attempt when it may.
 */
export function mayRecoverUnclean(dataDir: string, now = Date.now(), withinMs = 30 * 60_000): boolean {
  const p = path.join(dataDir, UNCLEAN_RECOVERY_FILE);
  try {
    const last = Date.parse(fs.readFileSync(p, 'utf8').trim());
    if (Number.isFinite(last) && now - last < withinMs) return false;
  } catch {
    // never recovered before
  }
  try {
    fs.writeFileSync(p, new Date(now).toISOString());
  } catch {
    // best effort
  }
  return true;
}
export const PENDING_RESTART_FILE = 'restart.pending.json';

/** The server's heartbeat (every 30 s): after an unclean stop it says when the server was last alive. */
export function writeAlive(dataDir: string, now = Date.now()) {
  try {
    writeJsonDurable(path.join(dataDir, ALIVE_FILE), { at: new Date(now).toISOString(), pid: process.pid }, { generations: 0 });
  } catch {
    // next beat
  }
}

export function readAlive(dataDir: string): { at: number } | undefined {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dataDir, ALIVE_FILE), 'utf8')) as { at?: string };
    const at = Date.parse(j.at ?? '');
    return Number.isFinite(at) ? { at } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * An update asked for but not yet handed to the supervisor (it drains first): kept on disk, so a power cut
 * or a crash during the drain does not lose it. stopServer clears it once data/update.request is written.
 */
export function writePendingRestart(dataDir: string, req: RestartRequest) {
  if (!req.update) return;
  try {
    writeJsonDurable(path.join(dataDir, PENDING_RESTART_FILE), { ...req, at: new Date().toISOString() }, { generations: 0 });
  } catch {
    // best effort
  }
}

export function clearPendingRestart(dataDir: string) {
  fs.rmSync(path.join(dataDir, PENDING_RESTART_FILE), { force: true });
}

/** Read and remove the pending update, if any (older than a day: stale, dropped). */
export function takePendingRestart(dataDir: string, now = Date.now()): (RestartRequest & { at: string }) | undefined {
  const p = path.join(dataDir, PENDING_RESTART_FILE);
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8')) as RestartRequest & { at: string };
    fs.rmSync(p, { force: true });
    return j.update && now - Date.parse(j.at) < 24 * 3_600_000 ? j : undefined;
  } catch {
    return undefined;
  }
}

/**
 * What an unclean stop was, in words: the machine went down (it booted after the server's last heartbeat:
 * a power cut, a hard reset or a system crash) or only the server did (a crash or a kill).
 */
export function describeUncleanStop(o: { lastAliveAt?: number; bootAt: number; host: string }): string {
  const t = (ms: number) => new Date(ms).toLocaleString();
  if (o.lastAliveAt !== undefined && o.bootAt > o.lastAliveAt) {
    return `${o.host} went down unexpectedly (lost power, was hard-reset or crashed) after ${t(o.lastAliveAt)}, and booted again at ${t(o.bootAt)}`;
  }
  if (o.lastAliveAt !== undefined) return `the SketchUp Factory server stopped without a clean stop (a crash or a forced kill) after ${t(o.lastAliveAt)}; ${o.host} itself kept running`;
  return 'the SketchUp Factory server stopped without a clean stop (a crash, a forced kill or a power cut)';
}
