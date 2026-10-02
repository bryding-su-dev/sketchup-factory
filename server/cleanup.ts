import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import type { CleanupPolicy } from './config.ts';
import type { CleanupSummary } from '../shared/types.ts';

export { DEFAULT_CLEANUP, type CleanupPolicy } from './config.ts';

/**
 * The continuous disk clean-up (docs/self-recovery.md "Continuous clean-up"), shared by the host guard
 * (server/hostHealth.ts) and every machine daemon (machine/daemon.ts). Three layers:
 *
 * - rules (cleanupRules): per platform, an allowlist of folders whose entries are scratch, caches or logs, each
 *   with an age: an entry goes only when nothing inside it changed for that long;
 * - the never-delete guard (neverDelete): repos, sandboxes, this app, secrets, backups, installs, virtual
 *   disks and anything a running agent uses are refused whatever a rule says, checked again right before
 *   each removal;
 * - the runner (CleanupRunner): a pass every `everyMinutes`, and sooner while free space is below the soft
 *   threshold; every pass is logged, and only a pass that cannot get back above the soft threshold tells
 *   anyone (with the biggest remaining consumers).
 */

export type CleanupPlatform = 'win32' | 'darwin' | 'linux';

/** Where a computer keeps its scratch: the inputs of cleanupRules. */
export interface CleanupEnv {
  platform: CleanupPlatform;
  home: string;
  /** The system temp folder (os.tmpdir()). */
  tmp: string;
  /** Windows: %LOCALAPPDATA%. */
  localAppData?: string;
  /** The agents' own temp root when it is not `tmp` (a machine's temp_dir). */
  agentTemp?: string;
  /** Folders of sandboxes (the host's sandbox root): their Builds folders' old entries go, though sandboxes are kept. */
  sandboxRoots?: string[];
}

export function hostCleanupEnv(agentTemp?: string): CleanupEnv {
  const platform: CleanupPlatform = process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux';
  const home = os.homedir();
  return { platform, home, tmp: os.tmpdir(), localAppData: platform === 'win32' ? process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local') : undefined, agentTemp };
}

/** One allowlisted folder: its entries (files or folders) that match `names` go once untouched for `olderThanHours`. */
export interface CleanupRule {
  id: string;
  /** The folder; `*` in a segment matches any folder there, as in C:/actions-runner-star/_work (expandDir). */
  dir: string;
  /** Entry name globs (* and ?); absent: every entry. */
  names?: string[];
  /** Entry name globs never taken by this rule (another rule handles them). */
  except?: string[];
  olderThanHours: number;
  /** 'low': only in a pass while free space is below the soft threshold (whole caches that are re-downloaded). */
  when?: 'always' | 'low';
  /** What it is, for the log. */
  what: string;
  /**
   * An entry that is or holds a git repo: skipped (default), removed only when nothing in it is unpushed, or
   * 'any' for this app's own test scratch (its fixture repos have local commits by design).
   */
  repos?: 'skip' | 'pushed' | 'any';
  /** Keep the newest version of each `<name>-<number>` family (Playwright's browsers) whatever its age. */
  supersededOnly?: boolean;
  /** The folder is inside a kept path (a sandbox's Builds): that keep does not cover its entries. */
  insideKept?: boolean;
}

/** What never goes: known paths (and whatever holds them), paths agents use now, and the home folder itself. */
export interface CleanupGuard {
  keep: string[];
  inUse: string[];
  home: string;
}

export interface CleanupItem {
  path: string;
  why: string;
  rule: string;
  /** Set for an insideKept rule: its folder, whose enclosing keeps do not apply. */
  base?: string;
}

export interface CleanupRun {
  removed: { path: string; bytes: number; rule: string }[];
  failed: { path: string; why: string }[];
  bytes: number;
}

// Windows paths ("C:/x", "\\\\server\\x") are judged as Windows paths and "/x" as POSIX paths on any OS (CI runs
// on Linux and Windows).
const P = (p: string) => (/^[a-zA-Z]:[\\/]|^\\\\/.test(p) ? path.win32 : p.startsWith('/') ? path.posix : path);
const norm = (p: string) => P(p).resolve(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
const within = (p: string, root: string) => norm(p) === norm(root) || norm(p).startsWith(norm(root) + '/');
const glob = (pattern: string) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');

/** Folder names that mark what is never removed, wherever they are. */
const PROTECTED_SEGMENTS: [RegExp, string][] = [
  [/^\.claude$/, "Claude Code's settings and transcripts"],
  [/^\.(ssh|gnupg|aws|azure|kube|docker|password-store|config)$|^keychains$/, 'credentials or settings'],
  [/^ff-local-backups$/, 'a backup of local work'],
  [/audit|^labs?$|^ff-?lab/, 'lab or audit artifacts'],
  [/^(steam|steamapps|steamlibrary)$/, 'a Steam install'],
  [/^(unity ?hub(\.app)?|unity\.app)$|^\d{4}\.\d+\.\d+[abfp]\d+$/, 'a Unity install'],
];
const SECRET_NAME = /secret|credential|password|\.pem$|\.key$|\.p12$|\.pfx$|^id_(rsa|dsa|ecdsa|ed25519)|^\.env(\.|$)|\.keychain/;
const SYSTEM_TOP_WIN = new Set(['windows', 'program files', 'program files (x86)', 'programdata', 'recovery', 'system volume information', '$recycle.bin']);
const SYSTEM_TOP_POSIX = new Set(['applications', 'system', 'library', 'usr', 'bin', 'sbin', 'etc', 'opt', 'cores', 'volumes']);

function protectedSegment(parts: string[]): string | undefined {
  for (const s of parts) for (const [re, why] of PROTECTED_SEGMENTS) if (re.test(s)) return why;
  return undefined;
}

/**
 * Whether a rule may look into `dir` at all: not inside anything kept or in use, nor under a protected name.
 * (Unlike neverDelete, a folder that merely holds such paths is fine: the temp folder holds agents' own.)
 */
export function ruleDirAllowed(dir: string, g: CleanupGuard): boolean {
  if ([...g.keep, ...g.inUse].some((k) => k && within(dir, k))) return false;
  return !protectedSegment(norm(dir).split('/').filter(Boolean)) && !within(dir, `${g.home}/torque`);
}

/**
 * Why `p` must never be removed, or undefined. Pure (paths only), so it is the same on every computer and
 * testable with Windows paths anywhere; the file-system checks (a Unity install inside, a repo inside) are
 * in planCleanup.
 */
export function neverDelete(p: string, g: CleanupGuard): string | undefined {
  const Pp = P(p);
  const n = norm(p);
  const parts = n.split('/').filter(Boolean);
  const win = Pp === path.win32 || (Pp === path && process.platform === 'win32');
  if (parts.length <= (win ? 1 : 0)) return 'a drive root';
  const home = norm(g.home);
  if (n === home || home.startsWith(n + '/')) return 'the home folder or a folder holding it';
  if (norm(Pp.dirname(Pp.resolve(p))) === home) return 'a top-level folder of the home folder';
  if ((win ? SYSTEM_TOP_WIN : SYSTEM_TOP_POSIX).has(parts[win ? 1 : 0])) return 'a system folder';
  for (const k of g.keep) if (k && (within(p, k) || within(k, p))) return `kept (${k})`;
  for (const k of g.inUse) if (k && (within(p, k) || within(k, p))) return `in use by a running agent (${k})`;
  if (within(p, `${g.home}/torque`)) return 'torque';
  const seg = protectedSegment(parts);
  if (seg) return seg;
  const base = parts[parts.length - 1];
  if (/\.(vhdx?|avhdx)$/.test(base)) return 'a virtual disk';
  if (SECRET_NAME.test(base)) return 'looks like a secret';
  return undefined;
}

// ---------------------------------------------------------------- the rules

const H = 1;
const D = 24;

/**
 * The built-in rules for a platform plus the policy's own (temp scratch, agent clones, age rules). Folders that
 * do not exist are fine: they are skipped. Ages are from the last change anywhere inside an entry.
 */
export function cleanupRules(env: CleanupEnv, policy: CleanupPolicy): CleanupRule[] {
  if (policy.enabled === false) return [];
  const skip = new Set(policy.skipRules ?? []);
  return allCleanupRules(env, policy).filter((r) => !skip.has(r.id));
}

function allCleanupRules(env: CleanupEnv, policy: CleanupPolicy): CleanupRule[] {
  const j = (...a: string[]) => P(a[0]).join(...a);
  const temps = [...new Set([env.tmp, env.agentTemp].filter((x): x is string => !!x))];
  const rules: CleanupRule[] = [];
  for (const t of temps) {
    rules.push(
      { id: 'temp-scratch', dir: t, names: policy.tempPatterns, olderThanHours: policy.tempOlderThanHours, repos: 'any', what: 'headless-browser profiles and test scratch' },
      { id: 'agent-temp', dir: t, names: ['ffa-*'], olderThanHours: policy.sessionTempHours, what: "a finished agent session's own temp folder" },
      ...(policy.cloneOlderThanDays > 0 ? [{ id: 'temp-clones', dir: t, names: policy.clonePatterns, olderThanHours: policy.cloneOlderThanDays * D, repos: 'pushed' as const, what: 'an agent temp clone with nothing unpushed' }] : []),
      // Anything else in temp nobody touched for a week, clones included when fully pushed.
      { id: 'temp-old', dir: t, except: ['claude', 'claude-*'], olderThanHours: policy.tempAnyOlderThanDays * D, repos: 'pushed', what: 'temp entry untouched for a long time' },
    );
  }
  // Claude Code's task files (background task and subagent output) per project and session: the transcripts
  // themselves are in ~/.claude, which is never touched.
  for (const t of [...temps, ...(env.platform === 'win32' ? [] : ['/tmp'])]) {
    rules.push(
      // Snapshots Claude Code takes to diff a Bash command's edits: about 0.75 GB each, useless once the command is over.
      { id: 'claude-edit-diff', dir: j(t, 'claude*', 'bash-edit-diff'), olderThanHours: 12 * H, what: "Claude Code's snapshot for diffing a finished command's edits" },
      { id: 'claude-temp', dir: j(t, 'claude*', '*'), except: ['bash-edit-diff'], olderThanHours: policy.claudeTempDays * D, what: 'Claude Code task output of a session idle for days' },
    );
  }
  // Build outputs: a sandbox's Builds folder (sandboxes themselves are kept) and build archives in ff-worker.
  for (const r of env.sandboxRoots ?? []) {
    rules.push({ id: 'sandbox-builds', dir: j(r, '*', 'Builds'), olderThanHours: policy.buildsOlderThanDays * D, insideKept: true, repos: 'skip', what: 'a build in a sandbox untouched for days' });
  }
  rules.push({ id: 'worker-archives', dir: j(env.home, 'ff-worker'), names: ['*.tar', '*.tgz', '*.tar.gz', '*.zip', '*.bundle'], olderThanHours: policy.buildsOlderThanDays * D, what: 'a build or bundle archive' });
  // A GitHub Actions runner's job folders: checkouts and scratch it recreates for the next job.
  for (const base of [env.home, ...(env.platform === 'win32' ? [P(env.home).parse(env.home).root] : [])]) {
    rules.push({ id: 'actions-work', dir: j(base, 'actions-runner*', '_work'), except: ['_tool', '_actions'], olderThanHours: policy.runnerWorkDays * D, repos: 'any', what: 'an Actions runner job folder' });
  }
  if (env.platform === 'win32') {
    const la = env.localAppData ?? j(env.home, 'AppData', 'Local');
    const low = j(env.home, 'AppData', 'LocalLow');
    rules.push(
      { id: 'unity-crashes', dir: j(env.tmp, 'Unity', 'Editor', 'Crashes'), olderThanHours: 2 * D, what: 'Unity crash report' },
      { id: 'crash-dumps', dir: j(la, 'CrashDumps'), olderThanHours: 2 * D, what: 'Windows crash dump' },
      { id: 'unity-logs', dir: j(la, 'Unity', 'Editor'), names: ['*.log', 'upm*.log'], olderThanHours: 7 * D, what: 'old Unity editor log' },
      { id: 'unity-gi-cache', dir: j(low, 'Unity', 'Caches', 'GiCache'), olderThanHours: 7 * D, what: 'Unity GI cache' },
      { id: 'unity-cache', dir: j(la, 'Unity', 'cache', 'packages'), olderThanHours: 30 * D, what: 'Unity package cache' },
      { id: 'unity-cache-low', dir: j(la, 'Unity', 'cache'), names: ['npm', 'packages'], olderThanHours: 1 * D, when: 'low', what: 'Unity package cache (re-downloaded)' },
      { id: 'npx', dir: j(la, 'npm-cache', '_npx'), olderThanHours: 7 * D, what: 'npx package cache' },
      { id: 'npm-cache', dir: j(la, 'npm-cache'), names: ['_cacache', '_logs'], olderThanHours: 1 * D, when: 'low', what: 'npm cache (re-downloaded)' },
      { id: 'nuget-http', dir: j(la, 'NuGet'), names: ['v3-cache', 'http-cache', 'plugins-cache'], olderThanHours: 1 * D, when: 'low', what: 'NuGet HTTP cache' },
      { id: 'pip-cache', dir: j(la, 'pip'), names: ['cache'], olderThanHours: 1 * D, when: 'low', what: 'pip cache' },
      { id: 'uv-cache', dir: j(la, 'uv'), names: ['cache'], olderThanHours: 1 * D, when: 'low', what: 'uv cache' },
      { id: 'playtest-sessions', dir: j(env.home, 'AppData', 'LocalLow', 'Never Games', 'finalfactory*', 'PlaytestSessions'), olderThanHours: policy.playtestDays * D, what: 'playtest screenshots and recordings' },
      { id: 'playwright', dir: j(la, 'ms-playwright'), olderThanHours: 7 * D, supersededOnly: true, what: 'an older Playwright browser' },
      { id: 'edge-webview', dir: la, names: ['*.WebView2'], olderThanHours: 30 * D, what: 'a WebView2 cache' },
    );
  } else if (env.platform === 'darwin') {
    const lib = j(env.home, 'Library');
    rules.push(
      { id: 'xcode-derived', dir: j(lib, 'Developer', 'Xcode', 'DerivedData'), olderThanHours: 3 * D, what: 'Xcode DerivedData' },
      { id: 'xcode-derived-low', dir: j(lib, 'Developer', 'Xcode', 'DerivedData'), olderThanHours: 6 * H, when: 'low', what: 'Xcode DerivedData' },
      { id: 'unity-crashes', dir: j(lib, 'Logs', 'Unity'), names: ['Crash*', '*.dmp'], olderThanHours: 2 * D, what: 'Unity crash report' },
      { id: 'unity-logs', dir: j(lib, 'Logs', 'Unity'), names: ['*.log'], olderThanHours: 7 * D, what: 'old Unity editor log' },
      { id: 'diagnostic-reports', dir: j(lib, 'Logs', 'DiagnosticReports'), olderThanHours: 14 * D, what: 'macOS crash report' },
      { id: 'unity-gi-cache', dir: j(lib, 'Caches', 'com.unity3d.UnityEditor', 'GiCache'), olderThanHours: 7 * D, what: 'Unity GI cache' },
      { id: 'unity-gi-cache2', dir: j(lib, 'Unity', 'Caches', 'GiCache'), olderThanHours: 7 * D, what: 'Unity GI cache' },
      { id: 'unity-cache', dir: j(lib, 'Unity', 'cache', 'packages'), olderThanHours: 30 * D, what: 'Unity package cache' },
      { id: 'unity-cache-low', dir: j(lib, 'Unity', 'cache'), names: ['npm', 'packages'], olderThanHours: 1 * D, when: 'low', what: 'Unity package cache (re-downloaded)' },
      { id: 'npx', dir: j(env.home, '.npm', '_npx'), olderThanHours: 7 * D, what: 'npx package cache' },
      { id: 'npm-cache', dir: j(env.home, '.npm'), names: ['_cacache', '_logs'], olderThanHours: 1 * D, when: 'low', what: 'npm cache (re-downloaded)' },
      { id: 'pip-cache', dir: j(lib, 'Caches'), names: ['pip', 'pip-tools'], olderThanHours: 1 * D, when: 'low', what: 'pip cache' },
      { id: 'uv-cache', dir: j(env.home, '.cache'), names: ['uv', 'pip'], olderThanHours: 1 * D, when: 'low', what: 'uv or pip cache' },
      { id: 'go-build-cache', dir: j(lib, 'Caches'), names: ['go-build'], olderThanHours: 1 * D, when: 'low', what: 'Go build cache' },
      { id: 'playtest-sessions', dir: j(lib, 'Application Support', 'Never Games', 'finalfactory*', 'PlaytestSessions'), olderThanHours: policy.playtestDays * D, what: 'playtest screenshots and recordings' },
      { id: 'homebrew-cache', dir: j(lib, 'Caches', 'Homebrew'), olderThanHours: 14 * D, what: 'Homebrew download cache' },
      { id: 'playwright', dir: j(lib, 'Caches', 'ms-playwright'), olderThanHours: 7 * D, supersededOnly: true, what: 'an older Playwright browser' },
    );
  }
  for (const r of policy.ageRules) rules.push({ id: 'age-rule', dir: r.path, olderThanHours: r.olderThanDays * D, what: `older than ${r.olderThanDays} days (age rule)` });
  return rules;
}

// ---------------------------------------------------------------- planning

/** Whether a clone has work that exists nowhere else: uncommitted changes or commits no remote has. Unknown counts as yes. */
export async function hasLocalWork(dir: string): Promise<boolean> {
  const git = (...a: string[]) =>
    new Promise<string>((resolve, reject) =>
      // --no-optional-locks: status must not rewrite .git/index, or the clone looks touched and never ages out.
      execFile('git', ['--no-optional-locks', '-C', dir, ...a], { encoding: 'utf8', timeout: 15_000, windowsHide: true }, (e, out) => (e ? reject(e) : resolve(String(out).trim()))),
    );
  try {
    if (await git('status', '--porcelain')) return true;
    return Number(await git('rev-list', '--count', 'HEAD', '--not', '--remotes')) > 0;
  } catch {
    return true;
  }
}

/** The git repos (or worktrees: .git may be a file) at `dir` or one level below. */
async function reposIn(dir: string): Promise<string[]> {
  const out: string[] = [];
  if (fs.existsSync(path.join(dir, '.git'))) out.push(dir);
  try {
    for (const e of await fs.promises.readdir(dir, { withFileTypes: true })) {
      if (e.isDirectory() && fs.existsSync(path.join(dir, e.name, '.git'))) out.push(path.join(dir, e.name));
    }
  } catch {
    // a file, or unreadable
  }
  return out;
}

/**
 * Whether anything at or under `p` changed after `cutoffMs`: the "in use" test for ages. Symlinks are not
 * followed. Past `budget` entries it answers yes (unknown: keep).
 */
export async function touchedSince(p: string, cutoffMs: number, budget = 200_000): Promise<boolean> {
  const stack = [p];
  let seen = 0;
  while (stack.length) {
    const cur = stack.pop()!;
    let st: fs.Stats;
    try {
      st = await fs.promises.lstat(cur);
    } catch {
      continue;
    }
    if (st.mtimeMs > cutoffMs || ++seen > budget) return true;
    if (!st.isDirectory()) continue;
    try {
      for (const n of await fs.promises.readdir(cur)) stack.push(path.join(cur, n));
    } catch {
      return true; // unreadable inside: not ours to judge
    }
  }
  return false;
}

/** Bytes at or under `p` (symlinks not followed), up to `budget` entries. */
export async function sizeOf(p: string, budget = 2_000_000): Promise<number> {
  const stack = [p];
  let bytes = 0;
  let seen = 0;
  while (stack.length && seen++ < budget) {
    const cur = stack.pop()!;
    try {
      const st = await fs.promises.lstat(cur);
      if (st.isDirectory()) for (const n of await fs.promises.readdir(cur)) stack.push(path.join(cur, n));
      else bytes += st.size;
    } catch {
      // gone or unreadable
    }
  }
  return bytes;
}

/** Entries of a `<family>-<number>` folder (Playwright: chromium-1181, chromium_headless_shell-1181) that a newer one replaced. */
export function superseded(names: string[]): string[] {
  const newest = new Map<string, number>();
  const parse = (n: string) => /^(.+)-(\d+)$/.exec(n);
  for (const n of names) {
    const m = parse(n);
    if (m) newest.set(m[1], Math.max(newest.get(m[1]) ?? -1, Number(m[2])));
  }
  return names.filter((n) => {
    const m = parse(n);
    return !!m && Number(m[2]) < newest.get(m[1])!;
  });
}

/** The guard for a rule inside a kept folder: the keeps holding `dir` (the sandbox root) do not cover its entries. */
function relaxFor(dir: string, g: CleanupGuard): CleanupGuard {
  return { ...g, keep: g.keep.filter((k) => !within(dir, k)) };
}

/** `dir` with each `*` segment matched against the folders there (every actions-runner-N for "actions-runner-star"). */
export async function expandDir(dir: string): Promise<string[]> {
  if (!dir.includes('*')) return [dir];
  const Pp = P(dir);
  const abs = Pp.resolve(dir);
  const root = Pp.parse(abs).root;
  let out = [root];
  for (const seg of abs.slice(root.length).split(/[\\/]+/).filter(Boolean)) {
    const next: string[] = [];
    for (const base of out) {
      if (!seg.includes('*')) {
        next.push(Pp.join(base, seg));
        continue;
      }
      const re = glob(seg);
      try {
        for (const e of await fs.promises.readdir(base, { withFileTypes: true })) if (e.isDirectory() && re.test(e.name)) next.push(Pp.join(base, e.name));
      } catch {
        // not there
      }
    }
    out = next;
  }
  return out;
}

/**
 * Unity projects (ProjectSettings/ProjectVersion.txt beside a real Library folder) up to `depth` folders below
 * each root, with how many days since the project was last opened: the newest change to Library's own
 * entries, Temp, Logs or UserSettings. An editor has it open while Temp/UnityLockfile exists: never listed.
 * A Library that is a link (a ParrelSync clone sharing another's) is never listed either.
 */
export async function staleUnityLibraries(roots: string[], minDays: number, now = Date.now(), depth = 3): Promise<{ path: string; days: number }[]> {
  const out: { path: string; days: number }[] = [];
  const skip = /^(\.|node_modules$|appdata$|library$|temp$|logs$|packages$|assets$)/i;
  const mtime = async (p: string) => (await fs.promises.lstat(p).catch(() => undefined))?.mtimeMs ?? 0;
  const visit = async (dir: string, left: number) => {
    const lib = path.join(dir, 'Library');
    if (fs.existsSync(path.join(dir, 'ProjectSettings', 'ProjectVersion.txt'))) {
      const st = await fs.promises.lstat(lib).catch(() => undefined);
      if (!st?.isDirectory() || fs.existsSync(path.join(dir, 'Temp', 'UnityLockfile'))) return;
      let newest = Math.max(st.mtimeMs, await mtime(path.join(dir, 'Temp')), await mtime(path.join(dir, 'Logs')), await mtime(path.join(dir, 'UserSettings')));
      for (const n of await fs.promises.readdir(lib).catch(() => [] as string[])) newest = Math.max(newest, await mtime(path.join(lib, n)));
      const days = Math.floor((now - newest) / 86_400_000);
      if (days >= minDays) out.push({ path: lib, days });
      return;
    }
    if (left <= 0) return;
    for (const e of await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => [] as fs.Dirent[])) {
      if (e.isDirectory() && !skip.test(e.name)) await visit(path.join(dir, e.name), left - 1);
    }
  };
  for (const r of [...new Set(roots)]) await visit(r, depth);
  return out;
}

/** Left behind by a removal that failed halfway (runCleanup renames first): always removed. */
const LEFTOVER = /\.ffclean-\d+$/;

/**
 * What a pass would remove now. Reads only, so it can be shown before anything goes. `low`: free space is
 * below the soft threshold, so the 'low' rules count too.
 */
export async function planCleanup(opts: {
  rules: CleanupRule[];
  guard: CleanupGuard;
  low?: boolean;
  now?: number;
  /** Unity projects under `roots` whose Library goes once the project was not opened for `deleteDays`. */
  libraries?: { roots: string[]; deleteDays: number };
}): Promise<CleanupItem[]> {
  const now = opts.now ?? Date.now();
  const items = new Map<string, CleanupItem>();
  for (const r0 of opts.rules) {
   for (const dir of await expandDir(r0.dir)) {
    const rule = { ...r0, dir };
    if (rule.when === 'low' && !opts.low) continue;
    const guard = rule.insideKept ? relaxFor(dir, opts.guard) : opts.guard;
    if (!ruleDirAllowed(rule.dir, guard)) continue;
    let names: string[];
    try {
      names = await fs.promises.readdir(rule.dir);
    } catch {
      continue;
    }
    const match = rule.names?.map(glob);
    const except = rule.except?.map(glob);
    const old = rule.supersededOnly ? new Set(superseded(names)) : undefined;
    const cutoff = now - rule.olderThanHours * 3_600_000;
    for (const n of names) {
      const p = path.join(rule.dir, n);
      if (items.has(p)) continue;
      if (LEFTOVER.test(n)) {
        if (!neverDelete(p, guard)) items.set(p, { path: p, why: 'left over from an interrupted removal', rule: 'leftover', ...(rule.insideKept ? { base: dir } : {}) });
        continue;
      }
      if (match && !match.some((r) => r.test(n))) continue;
      if (except?.some((r) => r.test(n))) continue;
      if (old && !old.has(n)) continue;
      if (neverDelete(p, guard)) continue;
      if (fs.existsSync(path.join(p, 'Editor', 'Unity.exe')) || fs.existsSync(path.join(p, 'Unity.app'))) continue;
      if (await touchedSince(p, cutoff)) continue;
      const repos = await reposIn(p);
      if (repos.length && rule.repos !== 'any') {
        if (rule.repos !== 'pushed') continue;
        let dirty = false;
        for (const r of repos) if ((dirty = await hasLocalWork(r))) break;
        if (dirty) continue;
      }
      const hours = rule.olderThanHours;
      items.set(p, { path: p, rule: rule.id, why: `${rule.what}, untouched for over ${hours >= 48 ? `${Math.round(hours / 24)} days` : `${hours} h`}`, ...(rule.insideKept ? { base: dir } : {}) });
    }
   }
  }
  for (const lib of opts.libraries ? await staleUnityLibraries(opts.libraries.roots, opts.libraries.deleteDays, now) : []) {
    if (!neverDelete(lib.path, opts.guard)) items.set(lib.path, { path: lib.path, rule: 'stale-library', why: `Unity Library of a project not opened for ${lib.days} days (Unity rebuilds it on open)` });
  }
  return [...items.values()];
}

/**
 * Remove what planCleanup chose. Each entry is checked against the guard again, measured, then renamed
 * before it is deleted: on Windows a folder with a file open inside cannot be renamed, so an entry in use is
 * skipped whole instead of half deleted. A removal that fails after the rename leaves `<name>.ffclean-<n>`,
 * which the next pass removes.
 */
export async function runCleanup(items: CleanupItem[], guard: CleanupGuard): Promise<CleanupRun> {
  const out: CleanupRun = { removed: [], failed: [], bytes: 0 };
  for (const it of items) {
    const no = it.rule === 'leftover' ? undefined : neverDelete(it.path, it.base ? relaxFor(it.base, guard) : guard);
    if (no) {
      out.failed.push({ path: it.path, why: `refused: ${no}` });
      continue;
    }
    const bytes = await sizeOf(it.path);
    const doomed = it.rule === 'leftover' ? it.path : `${it.path}.ffclean-${Date.now()}`;
    try {
      if (doomed !== it.path) await fs.promises.rename(it.path, doomed);
    } catch (e) {
      out.failed.push({ path: it.path, why: `in use (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})` });
      continue;
    }
    try {
      await fs.promises.rm(doomed, { recursive: true, force: true, maxRetries: 2 });
      out.removed.push({ path: it.path, bytes, rule: it.rule });
      out.bytes += bytes;
    } catch (e) {
      out.failed.push({ path: it.path, why: `partly removed (${(e as NodeJS.ErrnoException).code ?? (e as Error).message}); the rest next pass` });
    }
  }
  return out;
}

/**
 * The biggest folders and files where scratch collects (the home folder's and LocalAppData's children, the
 * temp folders, files at the drive roots such as a VHDX), for a notice that clean-up could not free enough.
 * Stops measuring after `budgetMs`; unmeasured entries are left out.
 */
export async function biggestConsumers(env: CleanupEnv, extra: string[] = [], opts: { top?: number; budgetMs?: number } = {}): Promise<{ path: string; bytes: number }[]> {
  const deadline = Date.now() + (opts.budgetMs ?? 120_000);
  const j = (...a: string[]) => P(a[0]).join(...a);
  const roots = [env.home, env.tmp, env.agentTemp, env.localAppData, env.platform === 'darwin' ? j(env.home, 'Library') : undefined, env.platform === 'darwin' ? j(env.home, 'Library', 'Caches') : undefined].filter((x): x is string => !!x);
  const rootFiles = [...new Set([env.home, ...extra].map((p) => P(p).parse(P(p).resolve(p)).root))];
  const seen = new Set(roots.map(norm));
  const out: { path: string; bytes: number }[] = [];
  for (const r of rootFiles) {
    try {
      for (const e of await fs.promises.readdir(r, { withFileTypes: true })) if (e.isFile()) out.push({ path: path.join(r, e.name), bytes: (await fs.promises.stat(path.join(r, e.name))).size });
    } catch {
      // unreadable root
    }
  }
  for (const x of extra) out.push({ path: x, bytes: await sizeOf(x) });
  for (const r of [...new Set(roots)]) {
    let names: string[] = [];
    try {
      names = await fs.promises.readdir(r);
    } catch {
      continue;
    }
    for (const n of names) {
      if (Date.now() > deadline) break;
      const p = path.join(r, n);
      // A root measured on its own is not counted again inside its parent.
      if (seen.has(norm(p))) continue;
      out.push({ path: p, bytes: await sizeOf(p, 500_000) });
    }
  }
  return out.sort((a, b) => b.bytes - a.bytes).slice(0, opts.top ?? 8);
}

// ---------------------------------------------------------------- the log

/** Append one pass to `<dir>/cleanup-log.jsonl` (kept under ~5 MB: the older half moves to .1). */
export function appendCleanupLog(dir: string, entry: object) {
  try {
    const file = path.join(dir, 'cleanup-log.jsonl');
    fs.mkdirSync(dir, { recursive: true });
    if ((fs.statSync(file, { throwIfNoEntry: false })?.size ?? 0) > 5 * 1024 * 1024) fs.renameSync(file, `${file}.1`);
    fs.appendFileSync(file, JSON.stringify(entry) + '\n');
  } catch {
    // the log is best-effort; the summary still reaches system_status
  }
}

// ---------------------------------------------------------------- the runner

const GB = 1024 ** 3;
/** While below the soft threshold, a pass at most this often (a pass that cannot help should not hammer the disk). */
export const LOW_PASS_MINUTES = 15;
/** A notice that clean-up cannot get above the soft threshold repeats at most this often while it stays so. */
export const NOTICE_REPEAT_HOURS = 24;

export interface CleanupSettings {
  /** A pass this often (0: only when free space is low). */
  everyMinutes: number;
  /** Below this much free space on any watched volume: a pass every LOW_PASS_MINUTES, and the 'low' rules. */
  softFreeGB: number;
}

export interface CleanupRunnerDeps {
  settings(): CleanupSettings;
  /** The volumes clean-up can help (home, temp, and whatever else is watched). */
  diskPaths(): string[];
  statfs(p: string): Promise<{ free: number; total: number } | undefined>;
  /** One pass: plan and remove (`low`: below the soft threshold). */
  pass(low: boolean): Promise<CleanupRun>;
  consumers(): Promise<{ path: string; bytes: number }[]>;
  /** Unity Libraries worth reporting (staleUnityLibraries past the report age). */
  stale?(): Promise<{ path: string; days: number }[]>;
  /** The pass's full record, for the log file. */
  log(entry: object): void;
  /** The summary after every pass; `notice` only when clean-up could not get back above the soft threshold. */
  done(summary: CleanupSummary, notice?: string): void;
  now?(): number;
}

/** When to run a pass, and what to say about it. Shared by the host guard and the machine daemons. */
export class CleanupRunner {
  private lastPassAt = 0;
  private noticeAt = 0;
  private running = false;
  last?: CleanupSummary;

  private readonly d: CleanupRunnerDeps;

  constructor(deps: CleanupRunnerDeps) {
    this.d = deps;
  }

  private now() {
    return this.d.now ? this.d.now() : Date.now();
  }

  private async minFree(): Promise<number | undefined> {
    const frees: number[] = [];
    for (const p of [...new Set(this.d.diskPaths())]) {
      const s = await this.d.statfs(p).catch(() => undefined);
      if (s) frees.push(s.free);
    }
    return frees.length ? Math.min(...frees) : undefined;
  }

  /** Whether a pass is due now: `everyMinutes` since the last one, or LOW_PASS_MINUTES while below the soft threshold. */
  due(freeBytes: number | undefined, s = this.d.settings()): 'hourly' | 'low-space' | undefined {
    const since = (this.now() - this.lastPassAt) / 60_000;
    if (freeBytes !== undefined && freeBytes < s.softFreeGB * GB && since >= LOW_PASS_MINUTES) return 'low-space';
    if (s.everyMinutes > 0 && since >= s.everyMinutes) return 'hourly';
    return undefined;
  }

  /** The periodic look (the host guard's tick, the daemon's timer). */
  async tick(): Promise<CleanupSummary | undefined> {
    if (this.running) return undefined;
    const trigger = this.due(await this.minFree());
    return trigger ? this.run(trigger) : undefined;
  }

  /** A pass now, whatever the timers say (critical disk, asked for). */
  async run(trigger: CleanupSummary['trigger']): Promise<CleanupSummary | undefined> {
    if (this.running) return undefined;
    this.running = true;
    try {
      const s = this.d.settings();
      const before = await this.minFree();
      const low = trigger === 'critical' || trigger === 'asked' || (before !== undefined && before < s.softFreeGB * GB);
      this.lastPassAt = this.now();
      const r = await this.d.pass(low);
      const after = await this.minFree();
      const belowSoft = after !== undefined && after < s.softFreeGB * GB;
      const summary: CleanupSummary = {
        at: new Date(this.now()).toISOString(),
        trigger,
        removed: r.removed.length,
        freedBytes: r.bytes,
        failed: r.failed.length,
        freeBytes: after,
        softFreeGB: s.softFreeGB,
        belowSoft,
        top: [...r.removed].sort((a, b) => b.bytes - a.bytes).slice(0, 5),
      };
      const stale = await this.d.stale?.().catch(() => []);
      if (stale?.length) summary.staleLibraries = stale.sort((a, b) => b.days - a.days).slice(0, 10);
      let notice: string | undefined;
      if (!belowSoft) this.noticeAt = 0;
      else if (!this.noticeAt || this.now() - this.noticeAt > NOTICE_REPEAT_HOURS * 3_600_000) {
        this.noticeAt = this.now();
        summary.consumers = await this.d.consumers().catch(() => []);
        notice = describeShortfall(summary);
      }
      this.d.log({ ...summary, freeBeforeBytes: before, removedAll: r.removed, failedAll: r.failed.slice(0, 50) });
      this.last = summary;
      this.d.done(summary, notice);
      return summary;
    } finally {
      this.running = false;
    }
  }
}

const gb = (b: number) => `${(b / GB).toFixed(1)} GB`;

/** The notice text: what the pass freed, how far below the soft threshold it still is, and what holds the space. */
export function describeShortfall(s: CleanupSummary): string {
  const free = s.freeBytes === undefined ? '?' : gb(s.freeBytes);
  const biggest = s.consumers?.length ? ` Biggest remaining: ${s.consumers.map((c) => `${c.path} ${gb(c.bytes)}`).join(', ')}.` : '';
  return `Clean-up freed ${gb(s.freedBytes ?? 0)} (${s.removed} item(s)) but only ${free} is free, below the soft threshold of ${s.softFreeGB} GB. What is left is not known-safe to remove automatically.${biggest}${staleLine(s)}`;
}

/** The stale Unity Libraries, as a sentence (empty without any). */
function staleLine(s: CleanupSummary): string {
  if (!s.staleLibraries?.length) return '';
  return ` Unity Libraries of projects not opened for a long time (Unity rebuilds them on open; removed automatically only past the delete age): ${s.staleLibraries.map((l) => `${l.path} (${l.days} days)`).join(', ')}.`;
}

/** One line about a summary, for system_status and the dashboard. */
export function describeCleanup(s: CleanupSummary): string {
  const free = s.freeBytes === undefined ? '' : `, ${gb(s.freeBytes)} free${s.belowSoft ? ` (below the soft ${s.softFreeGB} GB)` : ''}`;
  return `${s.at.slice(0, 16).replace('T', ' ')} (${s.trigger}): ${s.removed} item(s), ${gb(s.freedBytes ?? 0)}${s.failed ? `, ${s.failed} skipped` : ''}${free}.${staleLine(s)}`;
}

/** The per-session temp folder: TMP, TEMP and TMPDIR of one agent's process, removed after its session ends. */
export const sessionTempDir = (root: string, sessionId: string) => path.join(root, `ffa-${sessionId.replace(/[^\w-]/g, '').slice(0, 40)}`);

/** The per-session temp folder as TMP, TEMP and TMPDIR, made if missing (called as the process starts). */
export function sessionTempEnv(root: string, sessionId: string): Record<string, string> {
  const d = sessionTempDir(root, sessionId);
  try {
    fs.mkdirSync(d, { recursive: true });
  } catch {
    return {}; // the system temp folder then
  }
  return { TMP: d, TEMP: d, TMPDIR: d };
}
