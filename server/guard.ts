import { execFileSync } from 'node:child_process';
import { repoIsPublic } from './publicGit.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';

/**
 * A PreToolUse hook that runs even in bypassPermissions mode (canUseTool does not).
 *
 * This is a SEATBELT, not a security boundary: it catches the mistakes a well-meaning agent makes
 * (pushing to master, killing the wrong Unity, editing the live checkout) by pattern-matching tool
 * input. A determined or prompt-injected agent can get around it (a script file, execute_code in
 * its own editor, a junction). The real boundaries are GitHub branch rules and, if ever needed, a
 * separate low-privilege Windows account for sandboxes. Keep the rules simple and legible.
 *
 * Rules:
 *   - git, every repo: no force pushes (--force-with-lease is allowed), no remote branch deletion,
 *     no --mirror/--all, no `gh` calls that rewrite refs/branches.
 *   - git, the game repo only (config repo.url / repo.basePath): no pushes to master/main and no PRs
 *     into master/main. The target is read from the push's remote (`git remote -v` in the command's
 *     directory, following `cd` and `git -C`) or gh's -R/--repo/GH_REPO; when it cannot be determined,
 *     it counts as the game repo. Other repos' master/main are fair game. Pushing and merging into
 *     develop is the normal, encouraged flow. (GitHub itself also refuses force pushes and deletion
 *     of master and develop: ruleset "Protect master and develop from rewrites".)
 *   - repository settings: `gh repo delete` never. `gh repo rename|create|edit|archive|unarchive` and
 *     writes to `.../private-vulnerability-reporting` only for repos other than the game repo (so an
 *     agent can publish or retire the app's own repos when the user asks); the target comes from
 *     -R/--repo/GH_REPO, the repository argument, or the directory's remotes, and when it cannot be
 *     determined it counts as the game repo.
 *   - processes: no killing Unity, node, claude or PowerShell by hand, no shutdown/restart.
 *   - files: no writes to, or shell commands naming, a protected path (the live co-op checkout, this
 *     server's own directory).
 *   - Unity MCP: refused until the session pins its own editor ("<id>@<hash>"), and never another.
 *   - public repos (config publicGitIdentity, default this app's own repo, and any other GitHub repo that
 *     GitHub reports as public, server/publicGit.ts): a push is refused when a commit it would publish has
 *     an author or committer email that is neither a GitHub noreply address nor the configured public
 *     email, so nobody's private address ends up in public history.
 *   - branch switches: while the sandbox's editor runs, no `git switch` / `git checkout <branch>` in the
 *     sandbox (Unity would stop on "The open scene(s) have been modified externally"); the worker's
 *     switch_branch tool does it safely. `git checkout -- <paths>` and `git restore` stay allowed.
 */
export function sandboxGuard(opts: {
  sandboxId: string;
  sandboxPath: string;
  protectedPaths: string[];
  /** URLs or paths that name the game repo, whose master/main is off-limits. Empty: every repo counts. */
  gameRepos?: string[];
  remotes?: RemoteResolver;
  /**
   * The agent works in the user's own clone (a machine, docs/machines.md), not a disposable worktree:
   * discarding, stashing or a dirty-tree switch only after a fresh backup (checkOwnCheckout), explicit
   * paths only when staging. `isClean` defaults to `git status --porcelain`; `backupRoot` to
   * ff-local-backups beside the clone; `hasBackup` to a folder there from the last 2 hours.
   */
  ownCheckout?: { isClean?: (dir: string) => boolean; backupRoot?: string; hasBackup?: () => boolean };
  /** Tool name prefixes to refuse, e.g. "mcp__ffsb__" (the portal's own MCP, which would let an agent launch agents). */
  denyToolPrefixes?: string[];
  /** Whether the sandbox's Unity editor is up right now: raw branch switches are refused then (checkEditorSwitch). */
  editorRunning?: () => boolean;
  /** Public repos whose pushes must carry only public commit identities (checkShell's identity rule). */
  publicIdentity?: PublicIdentity;
}): HookCallback {
  // Drive-letter paths are normalised textually so the guard behaves the same on any host OS.
  const norm = (p: string) => (/^[a-zA-Z]:[\\/]/.test(p) ? p : path.resolve(p)).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const own = norm(opts.sandboxPath);
  const protectedPaths = opts.protectedPaths.map(norm).filter((p) => !own.startsWith(p + '/') && own !== p);
  const home = norm(os.homedir());
  // Every way a shell command might spell a protected path.
  const spellings = protectedPaths.flatMap((p) => {
    const out = [p];
    if (/^[a-z]:\//.test(p)) out.push(`/${p[0]}${p.slice(2)}`); // Git Bash: C:/x -> /c/x
    if (p.startsWith(home + '/')) {
      const rest = p.slice(home.length); // "/games/mygame"
      out.push(`~${rest}`, `$home${rest}`, `\${home}${rest}`, `%userprofile%${rest}`, `$env:userprofile${rest}`);
    }
    return out;
  });
  const unityPrefix = `${opts.sandboxId.toLowerCase()}@`;
  let pinned = false;

  const deny = (reason: string) => ({
    hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision: 'deny' as const, permissionDecisionReason: reason },
  });

  return async (input) => {
    if (input.hook_event_name !== 'PreToolUse') return {};
    const tool = input.tool_name;
    const args = (input.tool_input ?? {}) as Record<string, unknown>;

    const banned = opts.denyToolPrefixes?.find((p) => tool.toLowerCase().startsWith(p.toLowerCase()));
    if (banned) return deny(`${tool} is not available to this agent (${banned}* is the portal's own control channel).`);

    if (tool === 'Bash' || tool === 'PowerShell') {
      const cmd = String(args.command ?? '');
      const reason =
        checkShell(cmd, { cwd: input.cwd || opts.sandboxPath, gameRepos: opts.gameRepos ?? [], remotes: opts.remotes ?? gitRemotes, publicIdentity: opts.publicIdentity, ownMachine: !!opts.ownCheckout }) ??
        (opts.ownCheckout ? checkOwnCheckout(cmd, input.cwd || opts.sandboxPath, opts.ownCheckout.isClean ?? gitIsClean, ownBackup(opts.sandboxPath, opts.ownCheckout)) : undefined) ??
        (opts.editorRunning?.() ? checkEditorSwitch(cmd, input.cwd || opts.sandboxPath, opts.sandboxPath) : undefined);
      if (reason) return deny(reason);
      const flat = cmd.replace(/\\/g, '/').toLowerCase();
      for (const s of spellings) {
        if (flat.includes(s)) return deny(`${s} is a protected path (the live co-op checkout or this server). Work only inside ${opts.sandboxPath}.`);
      }
    }

    if (tool === 'Write' || tool === 'Edit' || tool === 'MultiEdit' || tool === 'NotebookEdit') {
      const target = String(args.file_path ?? args.notebook_path ?? '');
      if (target) {
        const t = norm(target);
        for (const p of protectedPaths) {
          if (t === p || t.startsWith(p + '/')) return deny(`${target} is inside protected path ${p}.`);
        }
      }
    }

    if (tool.toLowerCase().startsWith('mcp__unitymcp__')) {
      const explain =
        `This sandbox's Unity editor is the instance named "${opts.sandboxId}@<hash>" (project path ${opts.sandboxPath}). ` +
        `Other editors on this machine belong to other sandboxes or to the live co-op game — never target them. ` +
        `Read mcpforunity://instances, then call set_active_instance with the full "Name@hash" whose name starts with "${opts.sandboxId}@".`;
      const isPin = tool.endsWith('__set_active_instance');
      const target = isPin ? args.instance : args.unity_instance;
      if (typeof target === 'string' && target) {
        // Name@hash only: a bare hash prefix or port number cannot be checked against the sandbox.
        if (!target.toLowerCase().startsWith(unityPrefix)) return deny(explain);
        if (isPin) pinned = true;
      } else if (!pinned) {
        // Unpinned, the bridge routes to whichever editor happens to be the only one connected —
        // possibly the co-op game's. Refuse until this session has pinned its own editor.
        return deny(`Pin your editor first. ${explain}`);
      }
    }
    return {};
  };
}

const PROTECTED_BRANCH = /^(?:refs\/heads\/)?(?:master|main)$/i;

/** Whether `dir`'s work tree has no changes. Unknown (not a repo, git missing) counts as not clean. */
export const gitIsClean = (dir: string): boolean => {
  try {
    const out = execFileSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    return out.trim() === '';
  } catch {
    return false;
  }
};

/** Where agents back up the user's local changes before discarding them: beside the clone, outside the repo. */
export const backupRootFor = (clone: string) => path.posix.join(path.posix.dirname(clone.replace(/\\/g, '/').replace(/\/+$/, '')), 'ff-local-backups');

/** A backup folder made (or written to) within the last `withinMs` under `root`. */
export function hasRecentBackup(root: string, withinMs = 2 * 3_600_000, now = Date.now()): boolean {
  try {
    return fs.readdirSync(root).some((n) => now - fs.statSync(path.join(root, n)).mtimeMs < withinMs);
  } catch {
    return false;
  }
}

/**
 * The shell lines that back up everything a discard could lose (the recipe the refusals and the brief give). A
 * Bash line on both platforms: on Windows, Claude Code's Bash is Git Bash, which has no rsync, so the changed and
 * untracked files are copied with tar there (a deleted file in the list is skipped, not fatal).
 */
export const backupRecipe = (root: string, platform: NodeJS.Platform = process.platform) =>
  `b="${root}/$(date +%Y%m%d-%H%M%S)"; mkdir -p "$b"; git diff > "$b/unstaged.patch"; git diff --cached > "$b/staged.patch"; ` +
  (platform === 'win32'
    ? `mkdir -p "$b/files"; git ls-files -z -m -o --exclude-standard | tar --null --ignore-failed-read -T - -cf - | tar -xf - -C "$b/files"; `
    : `git ls-files -z -m -o --exclude-standard | rsync -a --from0 --files-from=- ./ "$b/files/"; `) +
  `git stash list > "$b/stash-list.txt"; ls -R "$b" | head -50`;

/**
 * Why a git command is refused in the user's own clone (a machine, docs/machines.md), or undefined.
 *
 * Standing permission from the user (Ben, 2026-09-25: "you always have my permission to do that"): to update
 * the clone, an agent MAY discard or set aside local changes (git stash, git restore / checkout -- <paths>,
 * git reset of files or --hard, git clean, a forced branch switch), as long as it FIRST copied them to a fresh
 * timestamped backup folder outside the repo (`backupRoot`, e.g. ~/nevergames/ff-local-backups/<time>/) and
 * then reports what it moved. So those are refused only while there is no backup from the last 2 hours
 * (`hasBackup`), with the recipe. Staging or committing everything stays refused (the user's work must not
 * end up in an agent's commit); force pushes and pushes to the game repo's master/main are checkShell's.
 */
export function checkOwnCheckout(cmd: string, cwd: string | undefined, isClean: (dir: string) => boolean, backup?: { root: string; has: () => boolean }): string | undefined {
  let dir = cwd;
  const why = "The user's uncommitted work lives in this clone";
  const needBackup = (what: string) =>
    backup?.has()
      ? undefined
      : `${what} discards or sets aside the user's local changes. You may do it (the user's standing permission) once they are backed up: FIRST copy them to a fresh timestamped folder outside the repo, run from the clone: ${backupRecipe(backup?.root ?? '~/nevergames/ff-local-backups')} . Then run this again, and report what you moved and where.`;
  for (const seg of cmd.split(/&&|\|\||[;|\n]/)) {
    const raw = seg
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => w.replace(/^["']|["']$/g, ''));
    const lower = raw.map((w) => w.toLowerCase());
    if (['cd', 'pushd', 'chdir', 'set-location', 'sl'].includes(lower[0] ?? '')) dir = resolveDir(dir, raw[1]);
    const g = lower.findIndex((w) => w === 'git' || w.endsWith('/git') || w.endsWith('git.exe'));
    if (g < 0) continue;
    let gitDir = dir;
    let i = g + 1;
    while (i < raw.length && raw[i].startsWith('-')) {
      if (raw[i] === '-C') gitDir = resolveDir(gitDir, raw[i + 1]);
      i += raw[i] === '-C' || raw[i] === '-c' ? 2 : 1;
    }
    const sub = lower[i];
    const rest = lower.slice(i + 1);
    const has = (...f: string[]) => rest.some((w) => f.includes(w));
    const shortFlag = (c: string) => rest.some((w) => /^-[a-z]+$/.test(w) && w.includes(c));
    let refusal: string | undefined;
    if (sub === 'stash' && !['list', 'show'].includes(rest[0] ?? '')) refusal = needBackup('git stash');
    else if (sub === 'reset' && has('--hard', '--merge', '--keep')) refusal = needBackup(`git reset ${rest.find((w) => w.startsWith('--'))}`);
    else if (sub === 'clean' && !has('-n', '--dry-run')) refusal = needBackup('git clean');
    else if (sub === 'restore' && !(has('--staged', '-s') && !has('--worktree', '-w'))) refusal = needBackup('git restore of the work tree');
    else if (sub === 'add' && (has('-a', '--all', '.', '-u', '--update', ':/', '*') || shortFlag('a'))) {
      refusal = `Stage explicit paths (git add <file>…), never everything: ${why}, and it must not end up in your commit.`;
    } else if (sub === 'commit' && (has('--all') || shortFlag('a'))) refusal = `git commit -a is blocked: ${why}. Stage your own files by path, then commit.`;
    else if (sub === 'checkout' || sub === 'switch') {
      if (has('--', '.', '-f', '--force', '--discard-changes', '-p', '--patch') || rest.some((w) => w.startsWith('--ours') || w.startsWith('--theirs'))) {
        refusal = needBackup(`git ${sub} of paths (or --force)`);
      } else if (!isClean(gitDir ?? '.')) {
        refusal = needBackup(`Switching branches with uncommitted changes (the user's work in progress)`);
      }
    }
    if (refusal) return refusal;
  }
  return undefined;
}

/**
 * Why a shell command is refused while the sandbox's editor runs, or undefined. Exported for tests. A branch
 * switch under a running editor rewrites open scene files and Unity stops on its "modified externally"
 * question; mcp__sandbox__switch_branch parks the scenes first. Only commands aimed at the sandbox (or at a
 * directory that cannot be told) count.
 */
export function checkEditorSwitch(cmd: string, cwd: string | undefined, sandboxPath: string): string | undefined {
  const inside = (d: string | undefined) => {
    if (!d) return true;
    const n = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    return n(d) === n(sandboxPath) || n(d).startsWith(n(sandboxPath) + '/');
  };
  let dir = cwd;
  for (const seg of cmd.split(/&&|\|\||[;|\n]/)) {
    const raw = seg
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => w.replace(/^["']|["']$/g, ''));
    const lower = raw.map((w) => w.toLowerCase());
    if (['cd', 'pushd', 'chdir', 'set-location', 'sl'].includes(lower[0] ?? '')) dir = resolveDir(dir, raw[1]);
    const g = lower.findIndex((w) => w === 'git' || w.endsWith('/git') || w.endsWith('git.exe'));
    if (g < 0) continue;
    let gitDir = dir;
    let i = g + 1;
    while (i < raw.length && raw[i].startsWith('-')) {
      if (raw[i] === '-C') gitDir = resolveDir(gitDir, raw[i + 1]);
      i += raw[i] === '-C' || raw[i] === '-c' ? 2 : 1;
    }
    const sub = lower[i];
    const rest = lower.slice(i + 1);
    if (sub !== 'switch' && sub !== 'checkout') continue;
    if (rest.some((w) => w === '-h' || w === '--help')) continue;
    if (sub === 'checkout' && rest.some((w) => w === '--' || w === '-p' || w === '--patch')) continue; // paths, not a branch
    if (!inside(gitDir)) continue;
    return `git ${sub} to another branch is blocked while this sandbox's Unity editor is running: Unity would stop on "The open scene(s) have been modified externally". Use mcp__sandbox__switch_branch instead (it closes the open scenes across the switch, refreshes and reopens them). To restore files, use git restore <path> or git checkout -- <path>.`;
  }
  return undefined;
}

/** A repo's remotes (name -> push URL), or undefined when `dir` is not a readable git repo. */
export type RemoteResolver = (dir: string) => Map<string, string> | undefined;

export const gitRemotes: RemoteResolver = (dir) => {
  try {
    const out = execFileSync('git', ['-C', dir, 'remote', '-v'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    const m = new Map<string, string>();
    for (const line of out.split('\n')) {
      const [name, url, kind] = line.trim().split(/\s+/);
      if (name && url && kind === '(push)') m.set(name, url);
    }
    return m;
  } catch {
    return undefined;
  }
};

/** One spelling per repo: "github.com/owner/name" for every GitHub URL form and gh's OWNER/REPO, else the normalised URL or path. */
export function repoKey(url: string): string {
  const u = url.trim().toLowerCase().replace(/\\/g, '/').replace(/\/+$/, '').replace(/\.git$/, '');
  const gh = /^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?github\.com[:/](.+)$/.exec(u);
  if (gh) return `github.com/${gh[1]}`;
  if (/^[\w.-]+\/[\w.-]+$/.test(u)) return `github.com/${u}`;
  return u;
}

export interface ShellContext {
  cwd?: string;
  /** The agent works on one of the user's own machines (a Mac), not in a sandbox on the shared host. */
  ownMachine?: boolean;
  gameRepos: string[];
  remotes: RemoteResolver;
  publicIdentity?: PublicIdentity;
}

/** Repos whose history is public, and the identity commits to them should carry (config publicGitIdentity). */
export interface PublicIdentity {
  repos: string[];
  name?: string;
  email?: string;
  /** Author and committer emails of the commits a push from `dir` to `remote` would publish. Default: git log. */
  pushedEmails?: (dir: string, remote: string, srcs: string[]) => string[] | undefined;
  /** Whether GitHub reports a repo ("github.com/owner/name") as public. Default: repoIsPublic (gh, cached). */
  isPublic?: (key: string) => boolean | undefined;
}

export const isNoreplyEmail = (email: string) => /@users\.noreply\.github\.com$/i.test(email.trim());

/** The emails on commits reachable from `srcs` that `remote` does not have yet (by its tracking refs). */
export const gitPushedEmails = (dir: string, remote: string, srcs: string[]): string[] | undefined => {
  try {
    const not = /[/:\\]/.test(remote) ? '--remotes' : `--remotes=${remote}`;
    const out = execFileSync('git', ['-C', dir, 'log', '--format=%ae%n%ce', ...srcs, '--not', not, '--'], { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    return [...new Set(out.split('\n').map((l) => l.trim()).filter(Boolean))];
  } catch {
    return undefined;
  }
};

/** Why a push to a public repo is refused (a commit with a private email), or undefined. */
function checkPublicIdentity(ctx: ShellContext | undefined, remote: string, srcs: string[], dir: string | undefined): string | undefined {
  const pub = ctx?.publicIdentity;
  if (!pub || !dir) return undefined;
  const url = ctx!.remotes(dir)?.get(remote) ?? (/[/:\\]/.test(remote) ? remote : undefined);
  if (!url) return undefined;
  const target = repoKey(url);
  const listed = pub.repos.some((r) => repoKey(r) === target);
  if (!listed && !/^github\.com\/[\w.-]+\/[\w.-]+$/i.test(target)) return undefined;
  const emails = (pub.pushedEmails ?? gitPushedEmails)(dir, remote, srcs);
  const bad = (emails ?? []).filter((e) => !isNoreplyEmail(e) && e.toLowerCase() !== pub.email?.trim().toLowerCase());
  if (!bad.length) return undefined;
  // Only now ask GitHub (cached): most pushes carry no private email at all.
  if (!listed && (pub.isPublic ?? repoIsPublic)(target) !== true) return undefined;
  const name = pub.name ?? '<your name>';
  const email = pub.email ?? '<id>+<login>@users.noreply.github.com';
  return `This push publishes commits with the email(s) ${bad.join(', ')} to ${target}, whose history is public. Commit as the public identity instead: in this clone run git config user.name "${name}" and git config user.email "${email}", then rewrite your unpushed commits with git rebase -r @{u} --exec "git commit --amend --no-edit --reset-author" and push again.`;
}

/** Where a `cd` / `git -C` argument lands, or undefined when that cannot be known from the text. */
function resolveDir(base: string | undefined, p: string | undefined): string | undefined {
  if (!p || p.startsWith('-') || /[$~%`]/.test(p)) return undefined;
  const q = /^\/[a-zA-Z]\//.test(p) ? `${p[1]}:${p.slice(2)}` : p; // Git Bash /c/x -> c:/x
  if (/^[a-zA-Z]:[\\/]/.test(q) || q.startsWith('/')) return q;
  return base ? path.join(base, q) : undefined;
}

/** Whether a push to `target` (a remote name in `dir`, or a URL) goes to the game repo. Unknown counts as yes. */
function pushIsGameRepo(ctx: ShellContext | undefined, target: string | undefined, dir: string | undefined): boolean {
  if (!ctx?.gameRepos.length || !target) return true;
  const game = new Set(ctx.gameRepos.map(repoKey));
  const url = (dir ? ctx.remotes(dir)?.get(target) : undefined) ?? (/[/:\\]/.test(target) ? target : undefined);
  return url === undefined || game.has(repoKey(url));
}

/** Whether a gh command run in `dir` (or aimed at `repo` by -R/GH_REPO) is about the game repo. Unknown counts as yes. */
function ghIsGameRepo(ctx: ShellContext | undefined, repo: string | undefined, dir: string | undefined): boolean {
  if (!ctx?.gameRepos.length) return true;
  const game = new Set(ctx.gameRepos.map(repoKey));
  if (repo) return game.has(repoKey(repo));
  const remotes = dir ? ctx.remotes(dir) : undefined;
  if (!remotes?.size) return true;
  return [...remotes.values()].some((u) => game.has(repoKey(u)));
}

/** gh repo flags that take a value, so the word after them is not the repository argument. */
const GH_REPO_VALUE_FLAGS = new Set(['-r', '--repo', '-d', '--description', '-h', '--homepage', '--visibility', '--default-branch', '--add-topic', '--remove-topic', '-t', '--team', '-p', '--template', '-g', '--gitignore', '-l', '--license', '-s', '--source', '--remote']);

/** The repository argument of `gh repo <sub> [<repository>] ...` (words after the subcommand), if any. */
function ghRepoArgument(raw: string[]): string | undefined {
  for (let i = 3; i < raw.length; i++) {
    const w = raw[i];
    if (w.startsWith('-')) {
      if (!w.includes('=') && GH_REPO_VALUE_FLAGS.has(w.toLowerCase())) i++;
      continue;
    }
    return w;
  }
  return undefined;
}

/**
 * Why a shell command is refused, or undefined. Exported for tests. Without a context, or with no
 * game repo configured, every master/main push or PR counts as the game repo's.
 */
export function checkShell(cmd: string, ctx?: ShellContext): string | undefined {
  let dir = ctx?.cwd;
  // Judge each simple command separately: `cd x && git push -f` must not hide behind the `cd`.
  for (const seg of cmd.split(/&&|\|\||[;|\n]/)) {
    const words = seg.trim().split(/\s+/).filter(Boolean);
    const raw = words.map((w) => w.replace(/^["']|["']$/g, ''));
    const lower = raw.map((w) => w.toLowerCase());
    if (['cd', 'pushd', 'chdir', 'set-location', 'sl'].includes(lower[0] ?? '')) dir = resolveDir(dir, raw[1]);

    const pushAt = lower.findIndex((w, i) => w === 'push' && lower.slice(0, i).some((x) => x === 'git' || x.endsWith('/git') || x.endsWith('git.exe')));
    if (pushAt >= 0) {
      // The repo this push goes to: `git -C <dir>` or the tracked cwd, and the remote when a refspec follows it.
      let pushDir = dir;
      for (let i = 0; i < pushAt; i++) {
        if (raw[i] === '-C') pushDir = resolveDir(pushDir, raw[i + 1]);
        if (lower[i].startsWith('--git-dir') || lower[i].startsWith('--work-tree')) pushDir = undefined;
      }
      const positionals = raw.slice(pushAt + 1).filter((w) => !w.startsWith('-'));
      const remote = positionals.length >= 2 ? positionals[0] : undefined;
      const srcs = positionals.slice(1).map((r) => (r.includes(':') ? r.slice(0, r.indexOf(':')) : r).replace(/^\+/, '')).filter(Boolean);
      const identity = checkPublicIdentity(ctx, positionals[0] ?? 'origin', srcs.length ? srcs : ['HEAD'], pushDir);
      if (identity) return identity;
      for (const w of lower.slice(pushAt + 1)) {
        if (w === '--force' || w.startsWith('--force=') || (/^-[a-z]+$/.test(w) && w.includes('f'))) {
          return 'Force pushes are blocked in sandboxes. Use --force-with-lease on your own branch if you must rewrite it.';
        }
        if (w === '--delete' || (/^-[a-z]+$/.test(w) && w.includes('d')) || w.startsWith(':')) {
          return 'Deleting remote branches is blocked in sandboxes.';
        }
        if (w === '--mirror' || w === '--all' || w === '--prune') return `git push ${w} is blocked in sandboxes; push your own branch.`;
        if (w.startsWith('+')) return 'Force pushes (+refspec) are blocked in sandboxes.';
        if (!w.startsWith('-')) {
          const dst = w.includes(':') ? w.slice(w.indexOf(':') + 1) : w;
          if (PROTECTED_BRANCH.test(dst) && pushIsGameRepo(ctx, remote, pushDir)) {
            return "Pushing to the Final Factory game repo's master/main is blocked (or this push's target repo could not be determined). Push your own branch and integrate into develop.";
          }
        }
      }
    }

    // `GH_REPO=x gh ...`: look past leading environment assignments.
    const envEnd = lower.findIndex((w) => !/^\w+=/.test(w));
    const ghRepoEnv = raw.slice(0, Math.max(envEnd, 0)).find((w) => /^gh_repo=/i.test(w))?.slice('GH_REPO='.length);
    if (envEnd > 0) {
      raw.splice(0, envEnd);
      lower.splice(0, envEnd);
    }
    if (lower[0] === 'gh' || lower[0]?.endsWith('/gh') || lower[0] === 'gh.exe') {
      const sub = lower.slice(1, 3).join(' ');
      const rAt = lower.findIndex((w) => w === '-r' || w === '--repo');
      const repoFlag = rAt >= 0 ? raw[rAt + 1] : (raw.find((w) => w.toLowerCase().startsWith('--repo='))?.slice('--repo='.length) ?? ghRepoEnv);
      if (sub === 'repo delete') return "gh repo delete is blocked: deleting a repository is the user's call, done by hand.";
      if (['repo rename', 'repo create', 'repo edit', 'repo archive', 'repo unarchive'].includes(sub)) {
        // rename's argument is the NEW name: its target is -R or the directory's repo. create's is the repo it makes.
        const arg = sub === 'repo rename' ? undefined : ghRepoArgument(raw);
        if (sub === 'repo create' && !arg) return 'gh repo create without a repository name is blocked: name the repo (owner/name) so it is clearly not the game repo.';
        if (ghIsGameRepo(ctx, repoFlag ?? arg, dir)) return `gh ${sub} on the Final Factory game repo (or a repo that could not be determined) is the user's call, not an agent's.`;
      }
      // PRs and merges into develop are the normal flow; anything aimed at master is the user's release call.
      if ((sub === 'pr create' || sub === 'pr edit') && lower.some((w, i) => w === '--base=master' || w === '--base=main' || ((w === '--base' || w === '-b') && /^(master|main)$/.test(lower[i + 1] ?? '')))) {
        if (ghIsGameRepo(ctx, repoFlag, dir)) return "PRs into the Final Factory game repo's master/main are the user's release call. Target develop.";
      }
      if (lower[1] === 'api') {
        const method = lower.find((w, i) => (lower[i - 1] === '-x' || lower[i - 1] === '--method') && !!w)?.toUpperCase();
        const writes = (method && method !== 'GET') || lower.some((w) => w === '-f' || w === '--field' || w === '--raw-field' || w === '--input');
        if (writes && lower.some((w) => /\/git\/refs|\/branches|\/protection|\/merges|\/rulesets/.test(w))) {
          return 'Rewriting branches or refs through the GitHub API is blocked in sandboxes.';
        }
        const pvr = lower.map((w) => /(?:^|\/)repos\/([^/\s]+\/[^/\s]+)\/private-vulnerability-reporting/.exec(w)?.[1]).find(Boolean);
        if (pvr && method && method !== 'GET' && ghIsGameRepo(ctx, pvr, dir)) return "Changing the game repo's security settings is the user's call, not an agent's.";
      }
    }

    if (lower.some((w) => ['shutdown', 'shutdown.exe', 'restart-computer', 'stop-computer'].includes(w))) {
      return 'Shutting down or restarting the machine is blocked.';
    }
  }
  // Process kills are judged on the whole command: `Get-Process Unity | Stop-Process` splits the
  // target and the kill across a pipe.
  const all = cmd.toLowerCase().split(/[\s|;&]+/);
  const killer = all.some((w) => ['taskkill', 'taskkill.exe', 'stop-process', 'kill', 'pkill', 'killall', 'spps'].includes(w));
  // The SketchUp Factory daemon's LaunchAgent and scheduled task, for every agent: on a machine, and in the sandboxes of the
  // portal's own host, whose daemon runs beside the portal (docs/beast-machine.md).
  const lc = cmd.toLowerCase();
  if (/launchctl\s+(bootout|unload|remove|kill|disable)\b[^;&|]*com\.fffactory/.test(lc)) return "Unloading the SketchUp Factory daemon's LaunchAgent is blocked.";
  if (/schtasks(\.exe)?\s+[^;&|]*\/(end|delete|change)\b[^;&|]*fffactory|schtasks(\.exe)?\s+[^;&|]*fffactory[^;&|]*\/(end|delete|change)\b/.test(lc)) return "Ending, changing or deleting the SketchUp Factory daemon's scheduled task is blocked.";
  if (/(stop|disable|unregister|set)-scheduledtask\b[^;&]*fffactory|fffactory[^;&]*\|\s*(stop|disable|unregister|set)-scheduledtask\b/.test(lc)) return "Ending, changing or deleting the SketchUp Factory daemon's scheduled task is blocked.";
  if (ctx?.ownMachine) {
    // A machine (one of the user's Macs or Windows PCs, docs/machines.md): its agents manage Unity like the user's
    // own sessions there do, killing and relaunching editors, Hub and crash handlers freely. Only the SketchUp Factory
    // daemon (node, the .ff-factory folder) and Claude itself are off limits, as is unloading the daemon's
    // LaunchAgent (Mac) or ending, disabling or deleting its scheduled task (Windows).
    if (killer && all.some((w) => /^(node|claude)(\.exe)?$|claude|ff-?factory|daemon\.ts|com\.fffactory|run-daemon/.test(w.replace(/^["']|["']$/g, '')))) {
      return "Killing node or claude processes is blocked on a machine: that would take down the SketchUp Factory daemon or this agent. Unity, Unity Hub and crash handlers are fine to kill.";
    }
    return undefined;
  }
  if (killer && all.some((w) => /unity|node|claude|powershell|pwsh|tailscale|supervise/.test(w))) {
    return 'Killing Unity, node, claude or PowerShell processes by hand is blocked: other sandboxes and the live co-op game share this machine. Use mcp__sandbox__unity (action restart; force: true for a frozen editor) to stop or restart your own editor.';
  }
  return undefined;
}

/** The backup rule's folder and check for the user's clone at `clone` (overridable for tests). */
function ownBackup(clone: string, o: { backupRoot?: string; hasBackup?: () => boolean }) {
  const root = o.backupRoot ?? backupRootFor(clone);
  return { root, has: o.hasBackup ?? (() => hasRecentBackup(root)) };
}
