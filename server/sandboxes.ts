import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import type { Config } from './config.ts';
import type { Store } from './store.ts';
import type { CreateSandboxRequest, Sandbox, UnityBlocked, UnityDismissal } from '../shared/types.ts';
import { decide, describeDialog, findDialogs, isStalled, listWindows, pressButton, sceneFilesUnchanged, type Dialog } from './watchdog.ts';
import { bridgeInfo, bridgePing, crashLeftoversFor, crashReportersFor, editorVerdict, restartAllowed } from './unityHang.ts';
import { readStatusFiles, statusDirFor, syncStatusDir } from './unityMcp.ts';
import { listProcs } from './reaper.ts';
import { commandLine, copyTree, isAlive, killTree, launchDetached, lowerPriority, must, processStartTime, removeTree, run } from './proc.ts';

const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;
const GB = 1024 ** 3;

export function slugify(name: string) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

// ---- pure checks (exported for tests) ----

/** Branches a sandbox may never be on: its worktree's plain `git push` must not be able to reach them. */
const PROTECTED_BRANCHES = new Set(['master', 'main', 'develop', 'head']);

/**
 * Why `branch` cannot be a sandbox branch, or undefined if it can. Covers the rules git's own
 * check-ref-format does not know about; create() also runs `git check-ref-format --branch`.
 */
export function branchProblem(branch: string): string | undefined {
  if (!branch) return 'branch name is empty';
  if (branch.startsWith('-')) return `branch "${branch}" starts with "-"`;
  let n = branch.toLowerCase();
  // Strip every spelling that still names the same branch: refs/heads/x, heads/x, refs/remotes/origin/x, origin/x.
  for (let prev = ''; prev !== n; ) {
    prev = n;
    n = n.replace(/^refs\//, '').replace(/^(heads|remotes)\//, '').replace(/^origin\//, '');
  }
  if (PROTECTED_BRANCHES.has(n)) {
    return `branch "${branch}" is not allowed: a sandbox works on its own branch, never master, main or develop`;
  }
  return undefined;
}

/**
 * Sandbox ids that must not be used. The folder name becomes the Unity project name and so the MCP
 * instance name ("<id>@<hash>"); a sandbox named after the live checkout would collide with the live
 * game's editor instance.
 */
export function reservedSandboxIds(protectedPaths: string[], basePath: string): Set<string> {
  const out = new Set(['_base', '_seed']);
  for (const p of [...protectedPaths, basePath]) {
    const name = p.split(/[\\/]+/).filter(Boolean).pop();
    if (!name) continue;
    out.add(name.toLowerCase());
    out.add(slugify(name));
  }
  return out;
}

/**
 * Whether a process command line names `dir` as a whole path: "c:\ffsb\sb1" matches
 * `-projectPath "C:/ffsb/sb1"` and `C:\ffsb\sb1\Library`, but not `C:\ffsb\sb10`. Case-insensitive,
 * either slash style.
 */
export function commandLineHasPath(cmd: string, dir: string): boolean {
  const norm = (x: string) => x.replace(/\\/g, '/').toLowerCase();
  const hay = norm(cmd);
  const needle = norm(dir).replace(/\/+$/, '');
  if (!needle) return false;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) {
    const next = hay[i + needle.length];
    if (next === undefined || next === '/' || next === '"' || next === "'" || /\s/.test(next)) return true;
  }
  return false;
}

const PURPOSE_MAX = 200;

/** A purpose label as stored: one line, whitespace collapsed. Throws on an empty or over-long label. */
export function normalizePurpose(purpose: string): string {
  const one = purpose.replace(/\s+/g, ' ').trim();
  if (!one) throw new Error('purpose is empty');
  if (one.length > PURPOSE_MAX) throw new Error(`purpose is ${one.length} characters; keep it to one line of at most ${PURPOSE_MAX}`);
  return one;
}

// ---- base-repo lock ----

let baseRepoTail: Promise<unknown> = Promise.resolve();

/**
 * Run `fn` while holding the one lock for git operations on the shared base clone. Concurrent
 * fetch / worktree add / worktree remove race on the base repo's ref and worktree locks.
 */
export function withBaseRepoLock<T>(fn: () => Promise<T>): Promise<T> {
  const result = baseRepoTail.then(fn, fn);
  baseRepoTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

class Cancelled extends Error {
  constructor() {
    super('cancelled');
  }
}

interface EditorIdentity {
  pid: number;
  /** processStartTime() at launch; undefined if the OS would not say. */
  startTime?: string;
}

/**
 * A sandbox is a git worktree of the base clone at <sandboxRoot>/<id>, on its own branch, with its
 * own Library/ and at most one Unity editor. The folder name doubles as the Unity project name, so
 * the editor's MCP instance is "<id>@<hash>" — which is what the worker guard pins agents to.
 */
/**
 * The log file for an editor about to start, in `logsDir`. Normally Logs/sandbox-editor.log, with the
 * previous run's log kept as sandbox-editor-<time>.log. A process that outlived a crashed editor can still
 * hold the old log open without delete sharing (Unity's bug reporter, which the crashed editor starts, or
 * a compiler server it spawned: they inherit its handle), and then the old log can be neither deleted nor
 * renamed; this run then logs to a fresh sandbox-editor-<time>.log instead of failing. Callers take the
 * returned path everywhere (unity.logPath: watchdog, wait_for_unity, the Log button).
 */
export function pickEditorLog(logsDir: string, now = new Date()): string {
  fs.mkdirSync(logsDir, { recursive: true });
  const base = path.join(logsDir, 'sandbox-editor.log');
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z'); // 20260924T084437Z
  const stamped = path.join(logsDir, `sandbox-editor-${stamp}.log`);
  if (!fs.existsSync(base)) return base;
  try {
    fs.renameSync(base, stamped);
    return base;
  } catch (e) {
    console.warn(`unity log: ${base} is held by another process (${(e as NodeJS.ErrnoException).code}); this run logs to ${stamped}`);
    return stamped;
  }
}

/**
 * Remove old kept editor logs (sandbox-editor-*.log, a few hundred MB each after a long run), newest
 * `keep` first, never `current`. A log another process still holds is skipped and tried again next time.
 */
export function pruneEditorLogs(logsDir: string, current: string, keep = 3): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(logsDir).filter((n) => /^sandbox-editor-.+\.log$/.test(n));
  } catch {
    return [];
  }
  const old = names
    .map((n) => path.join(logsDir, n))
    .filter((p) => path.resolve(p) !== path.resolve(current))
    .map((p) => ({ p, t: fs.statSync(p).mtimeMs }))
    .sort((a, b) => b.t - a.t)
    .slice(keep);
  const removed: string[] = [];
  for (const { p } of old) {
    try {
      fs.rmSync(p);
      removed.push(p);
    } catch {
      // still held; next start tries again
    }
  }
  return removed;
}

export class SandboxManager {
  private readonly cfg: Config;
  private readonly store: Store;
  /** Sandboxes with a create or delete in progress. */
  private readonly busy = new Set<string>();
  private readonly removing = new Set<string>();
  private readonly provisioning = new Map<string, { abort: AbortController; done: Promise<void> }>();
  /** Why a sandbox's Unity was last stopped on purpose, so the poller does not call it a crash. */
  private readonly expectedExit = new Set<string>();
  /** The editor we launched per sandbox, to tell it apart from a later process that reuses its pid. */
  private readonly editors = new Map<string, EditorIdentity>();
  private readonly startingUnity = new Set<string>();
  private readonly lastVerified = new Map<string, number>();
  private readonly verifying = new Set<string>();
  /** Per sandbox: the editor log's size and when it last grew (the stall check). */
  private readonly logGrowth = new Map<string, { size: number; at: number }>();
  /** Per sandbox: when its windows were last looked at, and an unknown dialog seen once (reported when seen twice). */
  private readonly lastProbe = new Map<string, number>();
  private readonly suspect = new Map<string, string>();
  /** The hang watch's observations per running editor (docs/unity-lifecycle.md). */
  private readonly hang = new Map<string, { pid: number; checkedAt: number; logSize: number; logGrewAt: number; bridgeUp: boolean; bridgeFailingSince?: number; reloading?: boolean; notRespondingSince?: number; dialogAt?: number; procsAt?: number; reporter?: boolean }>();
  private readonly restarting = new Set<string>();
  /** Until when (ms) the open scenes of a sandbox's editor are known to have no unsaved edits. */
  private readonly scenesClean = new Map<string, number>();
  private probing = false;
  /** Set when the server runs elevated: Unity is not started (it would stop on the administrator dialog). */
  private elevatedWhy?: string;
  /**
   * 'blocked' (sandbox, blocked) when an editor gets stuck on a dialog or goes silent while starting;
   * 'dismissed' (sandbox, dismissal) when the watchdog pressed a safe button. Notifications hook in here.
   */
  readonly events = new EventEmitter<{ blocked: [Sandbox, UnityBlocked]; dismissed: [Sandbox, UnityDismissal]; unityRestart: [Sandbox, { why: string; gaveUp: boolean; error?: string }] }>();

  constructor(cfg: Config, store: Store) {
    this.cfg = cfg;
    this.store = store;
  }

  list() {
    return [...this.store.sandboxes.values()];
  }

  get(idOrName: string): Sandbox | undefined {
    const direct = this.store.sandboxes.get(idOrName);
    if (direct) return direct;
    const slug = slugify(idOrName);
    return this.list().find((s) => s.id === slug || s.name.toLowerCase() === idOrName.toLowerCase());
  }

  require(idOrName: string): Sandbox {
    const s = this.get(idOrName);
    if (!s) throw new Error(`no sandbox "${idOrName}" (have: ${this.list().map((x) => x.id).join(', ') || 'none'})`);
    return s;
  }

  /** Relabel a sandbox (the purpose line shown in list_sandboxes and the dashboard). Folder, branch and Unity project are untouched. */
  setPurpose(idOrName: string, purpose: string): Sandbox {
    const s = this.require(idOrName);
    if (s.status === 'deleting') throw new Error(`sandbox ${s.id} is being deleted`);
    this.update(s, { purpose: normalizePurpose(purpose) });
    return s;
  }

  /** Apply and persist a patch — unless the sandbox has been removed, which must never be undone. */
  private update(s: Sandbox, patch: Partial<Sandbox>) {
    Object.assign(s, patch);
    if (this.store.sandboxes.get(s.id) !== s) return;
    this.store.putSandbox(s);
  }

  /** Validates and records the sandbox immediately; the slow work (fetch, checkout, Library copy) continues in the background. */
  create(req: CreateSandboxRequest): Sandbox {
    const id = slugify(req.name);
    if (!SLUG.test(id)) throw new Error(`"${req.name}" does not make a usable sandbox name`);
    if (reservedSandboxIds(this.cfg.protectedPaths, this.cfg.repo.basePath).has(id)) {
      throw new Error(`"${id}" is reserved: it would collide with the live checkout or the base clone as a Unity project name`);
    }
    if (this.store.sandboxes.has(id)) throw new Error(`sandbox "${id}" already exists`);
    if (this.store.sandboxes.size >= this.cfg.limits.maxSandboxes) {
      throw new Error(`already ${this.store.sandboxes.size} sandboxes (limits.maxSandboxes = ${this.cfg.limits.maxSandboxes}); delete one first`);
    }
    const dir = path.join(this.cfg.sandboxRoot, id);
    if (fs.existsSync(dir)) throw new Error(`${dir} already exists on disk; delete it or pick another name`);
    if (!fs.existsSync(path.join(this.cfg.repo.basePath, '.git'))) {
      throw new Error(`base clone ${this.cfg.repo.basePath} is missing; run "npm run setup" on the host`);
    }
    const branch = req.branch?.trim() || `sandbox/${id}`;
    const problem = branchProblem(branch) ?? gitBranchProblem(branch);
    if (problem) throw new Error(problem);
    const base = req.base?.trim() || this.cfg.defaultBase;
    if (base.startsWith('-') || /[\s\x00-\x1f\x7f]/.test(base)) throw new Error(`base "${base}" is not a usable ref`);
    const s: Sandbox = {
      id,
      name: req.name,
      branch,
      base,
      path: dir,
      purpose: req.purpose?.trim() || '',
      status: 'creating',
      statusDetail: 'queued',
      createdAt: new Date().toISOString(),
      unity: { state: 'stopped' },
      sessionIds: [],
    };
    this.store.putSandbox(s);
    // The busy lock is held for the whole of provisioning; remove() cancels it rather than racing it.
    this.busy.add(id);
    const abort = new AbortController();
    const done = this.provision(s, req.seedLibrary ?? true, req.startUnity ?? false, abort.signal).finally(() => {
      this.provisioning.delete(id);
      this.busy.delete(id);
    });
    this.provisioning.set(id, { abort, done });
    return s;
  }

  /** Throws unless the sandbox volume has at least minFreeGB + extraGB free. Unknown free space is not an error. */
  private async requireFreeSpace(extraGB: number, what: string) {
    // The sandbox volume, plus any host volume it lives on (a dynamic Dev Drive VHDX grows on C:).
    for (const [target, extra] of [[this.cfg.sandboxRoot, extraGB], ...this.cfg.hostDiskPaths.map((p) => [p, extraGB] as const)] as const) {
      let freeBytes: number;
      try {
        const st = await fs.promises.statfs(target);
        freeBytes = st.bavail * st.bsize;
      } catch {
        continue; // statfs unsupported here; do not block on an unknown
      }
      const needGB = this.cfg.limits.minFreeGB + extra;
      if (freeBytes < needGB * GB) {
        throw new Error(
          `not enough disk for ${what}: ${(freeBytes / GB).toFixed(0)} GB free on ${target}, need ${needGB} GB ` +
            `(limits.minFreeGB ${this.cfg.limits.minFreeGB}${extra ? ` + ${extra} for it` : ''}); delete a sandbox first`,
        );
      }
    }
  }

  private async provision(s: Sandbox, seedLibrary: boolean, startUnity: boolean, signal: AbortSignal) {
    const base = this.cfg.repo.basePath;
    const step = (detail?: string) => {
      if (signal.aborted) throw new Cancelled();
      if (detail) this.update(s, { statusDetail: detail });
    };
    try {
      fs.mkdirSync(this.cfg.sandboxRoot, { recursive: true });
      step('checking disk space');
      await this.requireFreeSpace(0, 'a new worktree');

      step('waiting for the base repo');
      await withBaseRepoLock(async () => {
        step('fetching origin');
        await must('git', ['-C', base, 'fetch', '--prune', 'origin'], { timeoutMs: 15 * 60_000, signal });
        step(`creating worktree on ${s.branch}`);
        const local = await run('git', ['-C', base, 'rev-parse', '--verify', '--quiet', `refs/heads/${s.branch}`], { signal });
        const remote = await run('git', ['-C', base, 'rev-parse', '--verify', '--quiet', `refs/remotes/origin/${s.branch}`], { signal });
        step();
        // --no-checkout keeps the base-repo lock short; the (slow) checkout below touches only this worktree.
        if (local.code === 0) {
          await must('git', ['-C', base, 'worktree', 'add', '--no-checkout', s.path, s.branch], { timeoutMs: 10 * 60_000, signal });
        } else if (remote.code === 0) {
          // An existing remote branch: tracking it is fine, a plain push goes back to the same branch.
          await must('git', ['-C', base, 'worktree', 'add', '--no-checkout', '--track', '-b', s.branch, s.path, `origin/${s.branch}`], {
            timeoutMs: 10 * 60_000,
            signal,
          });
          s.base = `origin/${s.branch}`;
        } else {
          // --no-track: a plain `git push` has no upstream (so cannot reach s.base's branch) until the agent sets one.
          await must('git', ['-C', base, 'worktree', 'add', '--no-checkout', '--no-track', '-b', s.branch, s.path, s.base], {
            timeoutMs: 10 * 60_000,
            signal,
          });
        }
      });

      step(`checking out ${s.branch}`);
      await must('git', ['-C', s.path, 'reset', '--hard', '--quiet'], { timeoutMs: 60 * 60_000, signal });

      const skipped = seedLocalFiles(this.cfg.repo, s.path);
      if (skipped.length) console.warn(`sandbox ${s.id}: seed files not found in ${this.cfg.repo.referenceRepo}: ${skipped.join(', ')}`);

      const seed = this.cfg.librarySeed;
      if (seedLibrary && seed && fs.existsSync(seed) && !fs.existsSync(path.join(s.path, 'Library'))) {
        step('checking disk space for the Library copy');
        // A block clone costs almost nothing up front; its space grows as this sandbox's editor rewrites files.
        const needGB = this.cfg.librarySeedCopy === 'clone' ? 10 : this.cfg.librarySeedGB;
        await this.requireFreeSpace(needGB, `the Library copy (~${needGB} GB)`);
        step('copying warm Library (a few minutes)');
        await copyTree(seed, path.join(s.path, 'Library'), { signal, mode: this.cfg.librarySeedCopy });
      }
      step();
      this.update(s, { status: 'ready', statusDetail: undefined });
      if (startUnity) await this.startUnity(s.id);
    } catch (e) {
      // A cancelled provision belongs to remove(), which owns the record from here.
      if (signal.aborted || e instanceof Cancelled) return;
      this.update(s, { status: 'error', statusDetail: (e as Error).message });
    }
  }

  async remove(idOrName: string, opts: { deleteBranch?: boolean } = {}) {
    const s = this.require(idOrName);
    if (this.removing.has(s.id)) throw new Error(`sandbox ${s.id} is already being deleted`);
    const prov = this.provisioning.get(s.id);
    if (!prov && this.busy.has(s.id)) throw new Error(`sandbox ${s.id} is busy`);
    this.removing.add(s.id);
    try {
      // Set synchronously, before any await, so startUnity and the UI see it at once.
      this.update(s, { status: 'deleting', statusDetail: prov ? 'cancelling creation' : 'stopping' });
      if (prov) {
        prov.abort.abort();
        await prov.done;
        this.update(s, { status: 'deleting' });
      }
      this.busy.add(s.id);
      try {
        await this.removeNow(s, opts);
      } finally {
        this.busy.delete(s.id);
      }
    } finally {
      this.removing.delete(s.id);
    }
  }

  private async removeNow(s: Sandbox, opts: { deleteBranch?: boolean }) {
    const base = this.cfg.repo.basePath;
    // Never recursively delete anything but a direct child of sandboxRoot.
    const resolved = path.resolve(s.path);
    const inRoot = path.dirname(resolved) === path.resolve(this.cfg.sandboxRoot) && path.basename(resolved) === s.id;
    const hitsProtected = [...this.cfg.protectedPaths, base].some((p) => commandLineHasPath(resolved, p) || commandLineHasPath(p, resolved));
    if (!inRoot || hitsProtected) {
      this.update(s, { status: 'error', statusDetail: `delete refused: ${s.path} is not a sandbox folder under ${this.cfg.sandboxRoot}` });
      throw new Error(`refusing to delete ${s.path}`);
    }
    const problems: string[] = [];
    try {
      if (s.unity.pid && isAlive(s.unity.pid)) {
        this.update(s, { statusDetail: 'stopping Unity' });
        await this.stopUnity(s.id);
        if (s.unity.pid && s.unity.state !== 'stopped' && isAlive(s.unity.pid)) problems.push(`Unity pid ${s.unity.pid} did not stop`);
      }
      this.update(s, { statusDetail: 'removing Library' });
      // Delete Library/ ourselves first: git's recursive removal of 100k+ files is far slower than rd/rm.
      const lib = path.join(s.path, 'Library');
      if (fs.existsSync(lib)) {
        const r = await removeTree(lib);
        if (fs.existsSync(lib)) problems.push(`Library removal failed (${r.code}): ${tail(r.stderr || r.stdout)}`);
      }
      this.update(s, { statusDetail: 'removing worktree' });
      await withBaseRepoLock(async () => {
        // --force twice also removes a worktree git left locked (e.g. a creation killed mid-way).
        const r = await run('git', ['-C', base, 'worktree', 'remove', '--force', '--force', s.path], { timeoutMs: 30 * 60_000 });
        if (r.code !== 0 && fs.existsSync(s.path)) problems.push(`git worktree remove failed (${r.code}): ${tail(r.stderr)}`);
      });
      if (fs.existsSync(s.path)) {
        const r = await removeTree(s.path);
        if (fs.existsSync(s.path)) problems.push(`folder removal failed (${r.code}): ${tail(r.stderr || r.stdout)}`);
      }
      await withBaseRepoLock(async () => {
        const r = await run('git', ['-C', base, 'worktree', 'prune']);
        if (r.code !== 0) problems.push(`git worktree prune failed (${r.code}): ${tail(r.stderr)}`);
      });
    } catch (e) {
      problems.push((e as Error).message);
    }

    if (fs.existsSync(s.path)) {
      // Keep the record: dropping it would orphan a folder (possibly 70+ GB) that nothing tracks.
      const detail = `delete incomplete: ${s.path} still exists (a process may hold files in it; close it and delete again). ${problems.join('; ')}`;
      this.update(s, { status: 'error', statusDetail: detail.trim() });
      throw new Error(detail);
    }

    let branchError: string | undefined;
    // The branch is kept by default: it may hold unpushed commits, and recreating a sandbox on the
    // same branch picks the work back up.
    if (opts.deleteBranch) {
      const r = await withBaseRepoLock(() => run('git', ['-C', base, 'branch', '-D', s.branch]));
      if (r.code !== 0) branchError = `worktree removed, but deleting branch ${s.branch} failed (${r.code}): ${tail(r.stderr)}`;
    }
    this.editors.delete(s.id);
    this.expectedExit.delete(s.id);
    fs.rmSync(statusDirFor(this.cfg.dataDir, s.id), { recursive: true, force: true });
    this.store.removeSandbox(s.id);
    if (problems.length) console.warn(`sandbox ${s.id} removed with warnings: ${problems.join('; ')}`);
    if (branchError) throw new Error(branchError);
  }

  runningUnityCount() {
    return this.list().filter((s) => isActive(s.unity.state)).length;
  }

  /** The server runs elevated: refuse to start editors from now on, with this reason. */
  refuseUnityWhileElevated(why: string) {
    this.elevatedWhy = why;
  }

  /** The host guard's gate (server/hostHealth.ts): why a new editor must wait (disk, sandbox drive, RAM). */
  startGate?: () => string | undefined;

  private editorPath(s: Sandbox) {
    if (!this.cfg.unity.editorPath) throw new Error('no editor is configured on this host (config unity.editorPath is empty): sandboxes here are plain worktrees');
    let version = '';
    const pv = path.join(s.path, 'ProjectSettings', 'ProjectVersion.txt');
    if (fs.existsSync(pv)) version = /m_EditorVersion:\s*(\S+)/.exec(fs.readFileSync(pv, 'utf8'))?.[1] ?? '';
    const p = this.cfg.unity.editorPath.replace('{version}', version);
    if (!fs.existsSync(p)) throw new Error(`Unity editor not found at ${p} (project wants ${version || 'unknown version'})`);
    return p;
  }

  /**
   * Whether s.unity.pid is still the editor this sandbox launched: alive, and with the start time
   * recorded at launch — or, when that is unknown (e.g. after a server restart), with a command line
   * that names this sandbox's folder.
   */
  private async ownsEditor(s: Sandbox): Promise<boolean> {
    const pid = s.unity.pid;
    if (!pid || !isAlive(pid)) return false;
    const known = this.editors.get(s.id);
    if (known?.pid === pid && known.startTime) {
      const now = await processStartTime(pid);
      if (now) return now === known.startTime;
    }
    const cmd = await commandLine(pid);
    if (cmd) return commandLineHasPath(cmd, s.path);
    // No command line: that is how an editor running with administrator rights looks to a non-elevated
    // server (one started before the app was de-elevated). Its main window title names the project.
    try {
      return (await listWindows([pid])).some((w) => w.pid === pid && editorTitleNames(w.title, s.id));
    } catch {
      return false;
    }
  }

  async startUnity(idOrName: string) {
    const s = this.require(idOrName);
    if (s.status !== 'ready') throw new Error(`sandbox ${s.id} is ${s.status}, not ready`);
    if (this.elevatedWhy) {
      const msg = `not started: SketchUp Factory is running with administrator rights, and an editor started from it would stop on Unity's "running as administrator" dialog. ${this.elevatedWhy}`;
      if (!isActive(s.unity.state)) this.update(s, { unity: { ...s.unity, state: 'stopped', detail: msg, blocked: undefined } });
      throw new Error(msg);
    }
    const gate = isActive(s.unity.state) ? undefined : this.startGate?.();
    if (gate) throw new Error(`not started: ${gate}`);
    if (this.startingUnity.has(s.id)) return s;
    this.startingUnity.add(s.id);
    try {
      if (await this.ownsEditor(s)) return s;
      if (s.status !== 'ready') throw new Error(`sandbox ${s.id} is ${s.status}, not ready`);
      const countsSelf = isActive(s.unity.state);
      if (this.runningUnityCount() - (countsSelf ? 1 : 0) >= this.cfg.limits.maxUnity) {
        throw new Error(`already ${this.cfg.limits.maxUnity} Unity editors running (limits.maxUnity); stop one first`);
      }
      const lock = path.join(s.path, 'Temp', 'UnityLockfile');
      fs.rmSync(lock, { force: true });
      const logPath = pickEditorLog(path.join(s.path, 'Logs'));
      pruneEditorLogs(path.join(s.path, 'Logs'), logPath);
      const pid = launchDetached(this.editorPath(s), ['-projectPath', s.path, '-logFile', logPath, ...this.cfg.unity.extraArgs], s.path);
      // Below normal: this machine also runs the live game, which must win every contest for the CPU.
      lowerPriority(pid);
      this.expectedExit.delete(s.id);
      this.editors.set(s.id, { pid });
      this.lastVerified.set(s.id, Date.now());
      this.logGrowth.set(s.id, { size: 0, at: Date.now() });
      this.suspect.delete(s.id);
      this.update(s, { unity: { state: 'starting', pid, startedAt: new Date().toISOString(), logPath, detail: 'launching', dismissed: s.unity.dismissed, restarts: s.unity.restarts } });
      const startTime = await processStartTime(pid);
      if (this.editors.get(s.id)?.pid === pid) this.editors.set(s.id, { pid, startTime });
      return s;
    } finally {
      this.startingUnity.delete(s.id);
    }
  }

  /** Stop a sandbox's editor: politely, then by force after 15 s; `force` kills at once (a frozen editor). */
  async stopUnity(idOrName: string, opts: { force?: boolean } = {}) {
    const s = this.require(idOrName);
    const pid = s.unity.pid;
    if (!pid || !isAlive(pid)) {
      this.expectedExit.delete(s.id);
      this.update(s, { unity: { state: 'stopped', logPath: s.unity.logPath, restarts: s.unity.restarts } });
      return s;
    }
    // Never kill a pid we cannot prove is this sandbox's editor: pids are reused.
    if (!(await this.ownsEditor(s))) {
      this.expectedExit.delete(s.id);
      this.update(s, { unity: { state: 'stopped', logPath: s.unity.logPath, detail: `pid ${pid} is no longer this editor`, restarts: s.unity.restarts } });
      return s;
    }
    this.expectedExit.add(s.id);
    this.update(s, { unity: { ...s.unity, state: 'stopping', detail: undefined, blocked: undefined } });
    await killTree(pid, opts.force ? 0 : 15_000);
    if (isAlive(pid)) {
      // Leave expectedExit set: when it does go, that is the stop we asked for, not a crash.
      const detail = `could not stop pid ${pid}; if it runs with administrator rights (its window title starts with "Administrator:"), close it on the desktop`;
      this.update(s, { unity: { ...s.unity, state: 'running', detail } });
      return s;
    }
    // We saw the exit ourselves, so the poller never will; clear it so the next real crash reads as one.
    this.expectedExit.delete(s.id);
    this.editors.delete(s.id);
    this.hang.delete(s.id);
    await this.closeCrashReporters(s, pid);
    this.update(s, { unity: { state: 'stopped', logPath: s.unity.logPath, restarts: s.unity.restarts } });
    return s;
  }

  unityLog(idOrName: string, lines = 200): string[] {
    const s = this.require(idOrName);
    const n = Math.min(5000, Math.max(1, Math.floor(Number.isFinite(lines) ? lines : 200)));
    const p = s.unity.logPath;
    if (!p || !fs.existsSync(p)) return [];
    // Editor logs grow to gigabytes; read only the tail.
    const fd = fs.openSync(p, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const want = Math.min(size, Math.max(64 * 1024, n * 400));
      const buf = Buffer.alloc(want);
      fs.readSync(fd, buf, 0, want, size - want);
      return buf.toString('utf8').split(/\r?\n/).slice(-n);
    } finally {
      fs.closeSync(fd);
    }
  }

  private editorGone(s: Sandbox) {
    const expected = this.expectedExit.delete(s.id);
    this.editors.delete(s.id);
    this.logGrowth.delete(s.id);
    this.suspect.delete(s.id);
    this.hang.delete(s.id);
    this.update(s, {
      unity: { state: expected ? 'stopped' : 'crashed', logPath: s.unity.logPath, detail: expected ? undefined : 'editor exited; see the log', dismissed: s.unity.dismissed, restarts: s.unity.restarts },
    });
    if (!expected && !this.restarting.has(s.id)) void this.autoRestart(s, 'crashed: the editor process exited unexpectedly');
  }

  // ---------------------------------------------------------------- hangs and crashes (docs/unity-lifecycle.md)

  /** The window probe's word on the main window: Windows' "not responding" (IsHungAppWindow). */
  private noteResponding(s: Sandbox, pid: number, hung: boolean | undefined, dialogs: number) {
    const h = this.hang.get(s.id);
    if (!h || h.pid !== pid) return;
    if (hung) h.notRespondingSince ??= Date.now();
    else h.notRespondingSince = undefined;
    if (dialogs > 0) h.dialogAt = Date.now();
  }

  /**
   * A running editor, every unity.hang.checkSeconds: log growth, a main-thread ping through the MCP bridge,
   * crash reporters; editorVerdict decides, autoRestart acts. A silent bridge counts only once it answered for
   * this editor (an idle editor logs almost nothing, so a bridge that was never reachable must not kill it).
   */
  private async checkHang(s: Sandbox) {
    const u = s.unity;
    if (u.state !== 'running' || !u.pid || this.restarting.has(s.id)) return;
    const now = Date.now();
    let h = this.hang.get(s.id);
    if (!h || h.pid !== u.pid) {
      h = { pid: u.pid, checkedAt: 0, logSize: -1, logGrewAt: now, bridgeUp: false };
      this.hang.set(s.id, h);
    }
    if (now - h.checkedAt < this.cfg.unity.hang.checkSeconds * 1000) return;
    h.checkedAt = now;
    try {
      const size = u.logPath ? fs.statSync(u.logPath).size : -1;
      if (size !== h.logSize) {
        h.logSize = size;
        h.logGrewAt = now;
      }
    } catch {
      // no log: its growth cannot tell anything
    }
    const b = bridgeInfo(s.path);
    // A quick ping, then one long one (60 s) before a once-reachable bridge counts as silent: a throttled or
    // idle editor gets to it eventually, a frozen one never does.
    const ok = b.port ? (await bridgePing(b.port)) || (h.bridgeUp && (await bridgePing(b.port, 60_000))) : false;
    h.reloading = b.reloading;
    if (ok) {
      h.bridgeUp = true;
      h.bridgeFailingSince = undefined;
    } else if (h.bridgeUp) h.bridgeFailingSince ??= now;
    // Listing processes costs seconds of PowerShell: every 5 min, or at once when something already looks wrong.
    const suspicious = h.notRespondingSince !== undefined || h.bridgeFailingSince !== undefined;
    if (suspicious || now - (h.procsAt ?? 0) >= 5 * 60_000) {
      h.procsAt = now;
      h.reporter = crashReportersFor(await listProcs().catch(() => []), s.path).length > 0;
    }
    if (s.unity.pid !== h.pid || s.unity.state !== 'running') return; // it changed while we looked
    const v = editorVerdict(
      {
        alive: isAlive(h.pid),
        crashReporter: h.reporter,
        phase: 'running',
        dialog: h.dialogAt !== undefined && now - h.dialogAt < 3 * 60_000,
        notRespondingSince: h.notRespondingSince,
        bridgeFailingSince: h.bridgeFailingSince,
        reloading: h.reloading,
        logGrewAt: h.logGrewAt,
      },
      now,
      this.cfg.unity.hang,
    );
    if (v.kind !== 'ok') void this.autoRestart(s, `${v.kind}: ${v.why}`);
  }

  /** End every crash reporter left open for this sandbox's project (they can hold its log). */
  private async closeCrashReporters(s: Sandbox, editorPid?: number): Promise<number> {
    const reporters = crashLeftoversFor(await listProcs().catch(() => []), s.path, editorPid);
    for (const r of reporters) await killTree(r.pid, 0);
    return reporters.length;
  }

  /**
   * Restart a hung or crashed editor (the hang watch, a crash, a stalled start): force-kill it and what it
   * started, close its crash reporters, and start it again (a locked log gets a fresh name, a stale lock file
   * goes). At most unity.autoRestart.max per windowMinutes; then the editor is marked blocked and reported.
   */
  async autoRestart(s: Sandbox, why: string) {
    const a = this.cfg.unity.autoRestart;
    if (!a.enabled || this.restarting.has(s.id) || s.status !== 'ready') return;
    const now = Date.now();
    const restarts = s.unity.restarts ?? [];
    if (!restartAllowed(restarts, now, a.max, a.windowMinutes)) {
      const title = `automatic restarts stopped (${a.max} in ${a.windowMinutes} min)`;
      if (s.unity.pid && isAlive(s.unity.pid)) {
        // Hung: blocked until someone restarts it (stopUnity clears the block); the hang watch stays off meanwhile.
        if (s.unity.state === 'blocked' && s.unity.blocked?.reason === 'restart-limit') return;
        this.block(s, {
          reason: 'restart-limit',
          title,
          text: why,
          advice: 'the editor keeps hanging or crashing. Look at its log (and the desktop), then restart it with the unity tool.',
          since: new Date(now).toISOString(),
          resumeState: 'running',
        });
      } else {
        // Gone: it stays crashed (a blocked state on a dead pid would read as a new crash every poll).
        if (s.unity.detail?.startsWith(title)) return;
        this.update(s, { unity: { ...s.unity, state: 'crashed', detail: `${title}: ${why}` } });
      }
      this.events.emit('unityRestart', s, { why, gaveUp: true });
      return;
    }
    this.restarting.add(s.id);
    try {
      const entry = { at: new Date(now).toISOString(), reason: why, auto: true };
      this.update(s, { unity: { ...s.unity, restarts: [...restarts, entry].slice(-10), detail: `restarting after ${why}` } });
      console.warn(`unity ${s.id}: automatic restart (${why})`);
      const pid = s.unity.pid;
      if (pid && isAlive(pid) && (await this.ownsEditor(s))) {
        this.expectedExit.add(s.id);
        await killTree(pid, 0);
        this.expectedExit.delete(s.id);
      }
      await this.closeCrashReporters(s, pid);
      this.editors.delete(s.id);
      this.hang.delete(s.id);
      this.update(s, { unity: { state: 'stopped', logPath: s.unity.logPath, dismissed: s.unity.dismissed, restarts: s.unity.restarts, detail: `restarting after ${why}` } });
      await this.startUnity(s.id);
      this.events.emit('unityRestart', s, { why, gaveUp: false });
    } catch (e) {
      const error = (e as Error).message;
      this.update(s, { unity: { ...s.unity, detail: `automatic restart failed: ${error}` } });
      this.events.emit('unityRestart', s, { why, gaveUp: true, error });
    } finally {
      this.restarting.delete(s.id);
    }
  }

  /**
   * Every ~30 s, prove a live pid is still our editor (the start-time check spawns a process, too
   * costly for every 3 s poll). Catches an editor that exited and had its pid reused between polls.
   */
  private verifySoon(s: Sandbox) {
    const now = Date.now();
    if (this.verifying.has(s.id) || now - (this.lastVerified.get(s.id) ?? 0) < 30_000) return;
    this.verifying.add(s.id);
    this.lastVerified.set(s.id, now);
    const pid = s.unity.pid;
    void this.ownsEditor(s)
      .then((ours) => {
        const u = s.unity;
        if (!ours && u.pid === pid && isActive(u.state)) this.editorGone(s);
      })
      .catch(() => undefined)
      .finally(() => this.verifying.delete(s.id));
  }

  /** Called every few seconds: notices editors that finished booting, crashed, were closed by hand, or got stuck. */
  /**
   * The app checked this editor's open scenes over the MCP bridge and none had unsaved edits: for the
   * next `forMs`, the watchdog may answer "the open scene(s) have been modified externally" with Reload.
   * `forMs` 0 withdraws it.
   */
  markScenesClean(id: string, forMs: number) {
    if (forMs > 0) this.scenesClean.set(id, Date.now() + forMs);
    else this.scenesClean.delete(id);
  }

  /** Look at this editor's windows on the next poll instead of waiting out the interval. */
  probeSoon(id: string) {
    this.lastProbe.delete(id);
  }

  poll() {
    const statusFiles = this.cfg.unity.mcpServer ? readStatusFiles() : [];
    for (const s of this.list()) {
      const u = s.unity;
      if (this.cfg.unity.mcpServer) {
        // Its workers' Unity MCP server sees only this editor, and only while it is alive (server/unityMcp.ts).
        const alive = isActive(u.state) && !!u.pid && isAlive(u.pid);
        try {
          syncStatusDir(statusDirFor(this.cfg.dataDir, s.id), s.path, alive ? { since: u.startedAt ? Date.parse(u.startedAt) : undefined } : undefined, statusFiles);
        } catch (e) {
          console.warn(`unity ${s.id}: status folder:`, (e as Error).message);
        }
      }
      if (isActive(u.state) && u.pid && !isAlive(u.pid)) {
        this.editorGone(s);
        continue;
      }
      if (isActive(u.state) && u.pid) this.verifySoon(s);
      if (u.state === 'running' && u.pid) void this.checkHang(s).catch((e) => console.warn(`unity ${s.id}: hang check:`, (e as Error).message));
      const booting = u.state === 'starting' || (u.state === 'blocked' && u.blocked?.resumeState === 'starting');
      if (booting && u.logPath) this.checkStartupLog(s);
    }
    void this.probeWindows().catch((e) => console.warn('unity watchdog:', (e as Error).message));
  }

  private checkStartupLog(s: Sandbox) {
    const u = s.unity;
    const now = Date.now();
    // Log growth is the stall check's notion of progress.
    let size = 0;
    try {
      size = fs.statSync(u.logPath!).size;
    } catch {
      // not written yet
    }
    const prev = this.logGrowth.get(s.id);
    const grew = !!prev && size !== prev.size;
    // After a server restart there is no record: count from now, not from an old launch time.
    if (!prev || grew) this.logGrowth.set(s.id, { size, at: now });

    const tail = this.unityLog(s.id, 400).join('\n');
    const port = /StdioBridgeHost started on port (\d+)/.exec(tail)?.[1];
    if (port || tail.includes('AssetDatabase Initial Refresh End')) {
      const detail = port ? `MCP bridge on port ${port}` : 'editor up';
      // Up, but a dialog may still be in front of it: stay blocked, and return to running once it closes.
      if (u.state === 'blocked' && u.blocked?.reason === 'dialog') this.update(s, { unity: { ...u, blocked: { ...u.blocked, resumeState: 'running' } } });
      else this.update(s, { unity: { ...u, state: 'running', detail, blocked: undefined } });
      this.logGrowth.delete(s.id);
      return;
    }
    if (u.state === 'blocked') {
      // A stall ends as soon as the log moves again.
      if (u.blocked?.reason === 'stalled' && grew) this.update(s, { unity: { ...u, state: 'starting', blocked: undefined, detail: 'log moving again' } });
      return;
    }
    const stallMinutes = this.cfg.unity.watchdog.stallMinutes;
    if (isStalled(this.logGrowth.get(s.id)!.at, now, stallMinutes)) {
      const last = tail.trim().split('\n').filter(Boolean).pop()?.trim().slice(0, 300) ?? '(log is empty)';
      const a = this.cfg.unity.autoRestart;
      if (a.enabled && restartAllowed(u.restarts ?? [], now, a.max, a.windowMinutes)) {
        this.logGrowth.delete(s.id);
        void this.autoRestart(s, `hung: no startup progress for ${stallMinutes} min (last line: ${last.slice(0, 120)})`);
        return;
      }
      this.block(s, {
        reason: 'stalled',
        title: `no editor log output for ${stallMinutes} min`,
        text: `last line: ${last}`,
        advice:
          'the editor may be stuck on something the watchdog cannot see (look at the desktop), or on a very long import step. It returns to "starting" as soon as the log moves.',
        since: new Date().toISOString(),
        resumeState: 'starting',
      });
    } else if (/error CS\d+/.test(tail)) {
      if (u.detail !== 'compile errors — see the log') this.update(s, { unity: { ...u, detail: 'compile errors — see the log' } });
    } else if (tail.includes('Importing') || tail.includes('Refresh')) {
      if (u.detail !== 'importing assets') this.update(s, { unity: { ...u, detail: 'importing assets' } });
    }
  }

  private block(s: Sandbox, b: UnityBlocked) {
    const u = s.unity;
    if (u.state === 'blocked' && u.blocked?.reason === b.reason && u.blocked?.title === b.title && u.blocked?.text === b.text) return;
    const blocked: UnityBlocked = { ...b, resumeState: u.state === 'blocked' ? (u.blocked?.resumeState ?? b.resumeState) : b.resumeState };
    const detail = `blocked: ${b.title}${b.text ? `: ${b.text.replace(/\s+/g, ' ')}` : ''}`;
    this.update(s, { unity: { ...u, state: 'blocked', blocked, detail: detail.length > 400 ? detail.slice(0, 399) + '…' : detail } });
    console.warn(`unity ${s.id} ${detail.slice(0, 500)}`);
    this.events.emit('blocked', s, blocked);
  }

  private unblock(s: Sandbox, detail: string) {
    const u = s.unity;
    if (u.state !== 'blocked') return;
    // The stall clock restarts: the time spent on the dialog was not the editor's fault.
    this.logGrowth.delete(s.id);
    this.update(s, { unity: { ...u, state: u.blocked?.resumeState ?? 'starting', blocked: undefined, detail } });
  }

  /**
   * Look at the windows of editors that are due: starting or blocked ones often, running ones rarely.
   * One probe at a time; each is a PowerShell run of scripts/unity-windows.ps1 (about half a second).
   */
  private async probeWindows() {
    if (this.probing) return;
    const w = this.cfg.unity.watchdog;
    const now = Date.now();
    const due = this.list().filter((s) => {
      const st = s.unity.state;
      if (!s.unity.pid || !isActive(st)) return false;
      const every = st === 'running' ? w.runningPollSeconds : w.startingPollSeconds;
      return every > 0 && now - (this.lastProbe.get(s.id) ?? 0) >= every * 1000;
    });
    if (!due.length) return;
    this.probing = true;
    try {
      for (const s of due) {
        const pid = s.unity.pid!;
        this.lastProbe.set(s.id, Date.now());
        let windows;
        try {
          windows = await listWindows([pid]);
        } catch (e) {
          console.warn(`unity watchdog: could not list the windows of ${s.id} (pid ${pid}): ${(e as Error).message}`);
          continue;
        }
        // The editor may have been stopped or replaced while we looked.
        if (s.unity.pid !== pid || !isActive(s.unity.state) || this.store.sandboxes.get(s.id) !== s) continue;
        const main = windows.find((x) => x.pid === pid && x.class === 'UnityContainerWndClass');
        const dialogs = findDialogs(windows);
        this.noteResponding(s, pid, main?.hung, dialogs.length);
        await this.handleDialogs(s, dialogs, main?.title);
        // Unity prefixes its main window title with "Administrator:" when it runs elevated.
        if (main && /^Administrator:/i.test(main.title) && s.unity.state === 'running' && !/administrator/i.test(s.unity.detail ?? '')) {
          const detail = `${s.unity.detail ? `${s.unity.detail}; ` : ''}running with administrator rights (stop and start it to drop them)`;
          this.update(s, { unity: { ...s.unity, detail } });
        }
      }
    } finally {
      this.probing = false;
    }
  }

  private async handleDialogs(s: Sandbox, dialogs: Dialog[], editorTitle?: string) {
    const autoDismiss = this.cfg.unity.watchdog.autoDismiss;
    // Clean scenes: the app's own bridge check before its switch, or else (a worker's raw git switch) no
    // *.unity file with uncommitted changes. Only looked up when the reload question is actually up.
    // The git check (no *.unity file with uncommitted changes) runs only when a dialog that needs it is up.
    const needsGit = dialogs.some((d) => d.known?.action.kind === 'dismiss' && d.known.action.onlyIf);
    const sceneFilesClean = needsGit ? await sceneFilesUnchanged(s.path) : false;
    const scenesClean = (this.scenesClean.get(s.id) ?? 0) > Date.now() || sceneFilesClean;
    let report: { d: Dialog; repeated?: boolean; why?: string } | undefined;
    for (const d of dialogs) {
      const verdict = decide(d, { autoDismiss, recent: s.unity.dismissed, scenesClean, sceneFilesClean, editorTitle });
      if ('restart' in verdict) {
        // A fresh editor (and its fresh licensing client) instead of pressing on; within the restart budget.
        void this.autoRestart(s, `hung: ${verdict.why}`);
        return;
      }
      if ('click' in verdict) {
        let closed = false;
        try {
          closed = await pressButton(d.pid, d.hwnd, verdict.click);
        } catch (e) {
          console.warn(`unity watchdog: ${s.id}: ${(e as Error).message}`);
        }
        const dismissal: UnityDismissal = { at: new Date().toISOString(), title: d.title || describeDialog(d, 80), button: verdict.click };
        const dismissed = [...(s.unity.dismissed ?? []), dismissal].slice(-40);
        console.log(`unity ${s.id}: dismissed "${dismissal.title}" with "${verdict.click}"${closed ? '' : ' (the window is still open)'}`);
        this.update(s, { unity: { ...s.unity, dismissed, detail: `dismissed "${dismissal.title}" with "${verdict.click}"` } });
        this.events.emit('dismissed', s, dismissal);
        if (!closed) report ??= { d };
        continue;
      }
      report ??= { d, repeated: verdict.repeated, why: verdict.why };
    }
    if (!report) {
      this.suspect.delete(s.id);
      if (s.unity.state === 'blocked' && s.unity.blocked?.reason === 'dialog') this.unblock(s, 'dialog closed');
      return;
    }
    const { d, repeated, why } = report;
    // An unknown dialog must still be there on the next look: a short-lived one is not worth an alarm.
    const key = `${d.hwnd}:${d.title}`;
    if (!d.known && this.suspect.get(s.id) !== key) {
      this.suspect.set(s.id, key);
      return;
    }
    const advice = d.known?.advice ?? 'an unknown dialog: someone has to look at it on the desktop, or stop and start the editor.';
    this.block(s, {
      reason: 'dialog',
      title: d.title || '(untitled dialog)',
      text: d.text.slice(0, 1500),
      buttons: d.buttons,
      dialogId: d.known?.id,
      advice: repeated ? `${why ?? 'it came back after being dismissed several times'}, so it is no longer pressed automatically; ${advice}` : advice,
      since: new Date().toISOString(),
      resumeState: s.unity.state === 'running' ? 'running' : 'starting',
    });
  }

  /** On boot, reconcile editors that were running when the server went down. */
  /** Sandboxes whose editors were up when the last server stopped and are gone now (a power cut, a crash): set by reconcile. */
  lostEditors: string[] = [];

  reconcile() {
    for (const s of this.list()) {
      if (s.status === 'creating' || s.status === 'deleting') {
        this.update(s, { status: 'error', statusDetail: `interrupted while ${s.status}; delete and recreate` });
      }
      if (s.unity.state === 'stopped') continue;
      // A blocked state is re-derived by the watchdog; start from what the editor was doing.
      if (s.unity.state === 'blocked') this.update(s, { unity: { ...s.unity, state: s.unity.blocked?.resumeState ?? 'starting', blocked: undefined } });
      if (!s.unity.pid || !isAlive(s.unity.pid)) {
        if (s.status === 'ready' && isActive(s.unity.state)) this.lostEditors.push(s.id);
        this.update(s, { unity: { state: 'stopped', logPath: s.unity.logPath, restarts: s.unity.restarts } });
        continue;
      }
      // Alive, but after a restart the pid may belong to another program now: check its command line.
      const pid = s.unity.pid;
      void this.ownsEditor(s)
        .then((ours) => {
          if (!ours && s.unity.pid === pid) {
            this.update(s, { unity: { state: 'stopped', logPath: s.unity.logPath, detail: `pid ${pid} is no longer this editor`, restarts: s.unity.restarts } });
          }
        })
        .catch(() => undefined);
    }
  }
}

/** Whether a Unity main window title ("[Administrator: ]<project> - <scene> - ... - Unity 6.3 ...") is this project's. */
export function editorTitleNames(title: string, projectName: string): boolean {
  const t = title.replace(/^Administrator:\s*/i, '');
  return t.toLowerCase().startsWith(`${projectName.toLowerCase()} - `) && /\bUnity\b/.test(t);
}

/** An editor process we are tracking: starting, up, or up but stuck. */
function isActive(state: Sandbox['unity']['state']) {
  return state === 'starting' || state === 'running' || state === 'blocked';
}

/** Whether git accepts `branch` as a branch name, checked synchronously so create() can stay synchronous. */
function gitBranchProblem(branch: string): string | undefined {
  if (branch.includes('@{')) return `branch "${branch}" is not a valid branch name`;
  try {
    const out = execFileSync('git', ['check-ref-format', '--branch', branch], { encoding: 'utf8', windowsHide: true, timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return out === branch ? undefined : `branch "${branch}" is not a valid branch name (git reads it as "${out}")`;
  } catch {
    return `branch "${branch}" is not a valid branch name`;
  }
}

function tail(text: string) {
  return text.trim().split('\n').slice(-3).join(' | ');
}

/**
 * Copy config repo.seedFiles (the gitignored local files a checkout needs: .env, certificates) from the reference
 * clone into a new sandbox. Returns the ones the reference clone does not have. Existing files in the sandbox are
 * left alone; a path that escapes either folder is refused.
 */
export function seedLocalFiles(repo: { referenceRepo?: string; seedFiles?: string[] }, sandboxPath: string): string[] {
  const skipped: string[] = [];
  if (!repo.seedFiles?.length || !repo.referenceRepo) return repo.seedFiles ?? [];
  for (const rel of repo.seedFiles) {
    const src = path.resolve(repo.referenceRepo, rel);
    const dst = path.resolve(sandboxPath, rel);
    const inside = (root: string, p: string) => !path.relative(root, p).startsWith('..') && !path.isAbsolute(path.relative(root, p));
    if (!inside(repo.referenceRepo, src) || !inside(sandboxPath, dst)) throw new Error(`repo.seedFiles entry "${rel}" leaves its folder`);
    if (!fs.existsSync(src)) {
      skipped.push(rel);
      continue;
    }
    if (fs.existsSync(dst)) continue;
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
  return skipped;
}
