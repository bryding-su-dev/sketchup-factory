// The orchestrators' memory, versioned (docs/orchestrators.md, "Memory in a private repository"). When the memory root
// is itself a git repository, the app commits what changed there and pushes it, but only to a remote that GitHub
// reports as private: these files hold one person's preferences and may name people. General rules do not live here at
// all; they go to the harness repositories by pull request.
import fs from 'node:fs';
import path from 'node:path';
import { run, type RunResult } from './proc.ts';
import { secretIn } from './orchestratorMemory.ts';

export type MemoryGitState =
  /** The root is not the top of a git repository: nothing is done, as before this existed. */
  | 'not-a-repo'
  /** Nothing to commit and nothing waiting to be pushed. */
  | 'clean'
  /** Pushed to a private remote: this pass's commit, or earlier ones a failed push left behind. */
  | 'pushed'
  /** Committed here, not pushed: `detail` says why (no remote, a public one, one whose visibility is unknown, a failed push). */
  | 'committed'
  /** Nothing committed: every changed file was held back (`held`), or git refused. */
  | 'held';

export interface MemoryGitResult {
  state: MemoryGitState;
  /** The Markdown files committed in this pass, relative to the root, with "/" separators. */
  files: string[];
  /** Files left out of the commit because they hold what looks like a secret: "person-ben/notes.md (a GitHub token)". */
  held: string[];
  detail?: string;
}

export interface MemoryGitOptions {
  /** Runs git; tests pass their own. */
  git?: (args: string[], cwd: string) => Promise<RunResult>;
  /** Whether the remote is private: true, false, or undefined when nobody could tell. Default: GitHub, asked through `gh`. */
  isPrivate?: (remoteUrl: string) => boolean | undefined | Promise<boolean | undefined>;
  /** Who the commits are by, when the repository has no identity of its own. */
  identity?: { name: string; email: string };
}

/** "github.com/owner/name" for a GitHub remote in any of its spellings; undefined for anything else. */
export function githubKey(url: string): string | undefined {
  const m = /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(url.trim());
  return m ? `github.com/${m[1]}/${m[2]}` : undefined;
}

/**
 * Whether GitHub says the remote is private, asked with the machine's `gh` login (the same one the push needs), off
 * the main thread. Only a plain "true" counts: a repository that is missing, a remote that is not on GitHub and a `gh`
 * that is not logged in are all "could not tell", and what could not be told is not pushed.
 */
async function githubPrivate(url: string): Promise<boolean | undefined> {
  const key = githubKey(url);
  if (!key) return undefined;
  const [, owner, name] = key.split('/');
  const asked = await run('gh', ['api', `repos/${owner}/${name}`, '--jq', '.private'], { timeoutMs: 15_000 });
  const answer = asked.code === 0 ? asked.stdout.trim() : '';
  return answer === 'true' ? true : answer === 'false' ? false : undefined;
}

const defaultGit = (args: string[], cwd: string) => run('git', args, { cwd, timeoutMs: 60_000 });

const lastLine = (r: RunResult) => (r.stderr || r.stdout).trim().split('\n').pop() ?? '';

const sameDir = (a: string, b: string) => {
  const real = (p: string) => {
    try {
      return fs.realpathSync.native(p);
    } catch {
      return path.resolve(p);
    }
  };
  const [x, y] = [real(a), real(b)].map((p) => (process.platform === 'win32' ? p.toLowerCase() : p));
  return path.relative(x, y) === '';
};

/** Paths git reports as changed under the root (`status --porcelain -z`), renames as their new path. */
function changedPaths(porcelain: string): string[] {
  const out: string[] = [];
  const parts = porcelain.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (entry.length < 4) continue;
    out.push(entry.slice(3));
    if (entry[0] === 'R' || entry[0] === 'C') i++; // the next part is the old path
  }
  return out;
}

/**
 * Commit the Markdown files that changed under the memory root and push them to its private remote. Never commits
 * into a repository the root merely sits inside (the app's own checkout), never commits a file with a secret in it,
 * and never pushes to a remote that is public or whose visibility nobody could confirm. A commit a failed push left
 * behind goes out on a later pass.
 */
export async function versionMemory(root: string, o: MemoryGitOptions = {}): Promise<MemoryGitResult> {
  const git = o.git ?? defaultGit;
  const isPrivate = o.isPrivate ?? githubPrivate;
  const none = (state: MemoryGitState, detail?: string): MemoryGitResult => ({ state, files: [], held: [], detail });
  if (!fs.existsSync(path.join(root, '.git'))) return none('not-a-repo');
  const top = await git(['rev-parse', '--show-toplevel'], root);
  if (top.code !== 0 || !sameDir(top.stdout.trim(), root)) return none('not-a-repo');

  /** Commits on this branch that origin does not have (1 when the branch was never pushed; 0 before the first commit). */
  const ahead = async (): Promise<number> => {
    if ((await git(['rev-parse', '-q', '--verify', 'HEAD'], root)).code !== 0) return 0;
    const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], root)).stdout.trim();
    if (!branch || branch === 'HEAD') return 0;
    if ((await git(['rev-parse', '-q', '--verify', `refs/remotes/origin/${branch}`], root)).code !== 0) return 1;
    const count = await git(['rev-list', '--count', `refs/remotes/origin/${branch}..HEAD`], root);
    return count.code === 0 ? Number(count.stdout.trim()) || 0 : 0;
  };

  /** Push what is committed, to a private origin only. */
  const push = async (files: string[], held: string[]): Promise<MemoryGitResult> => {
    const committed = (detail: string): MemoryGitResult => ({ state: 'committed', files, held, detail });
    const remote = await git(['remote', 'get-url', 'origin'], root);
    if (remote.code !== 0) return committed('no remote named origin: committed here only');
    const url = remote.stdout.trim();
    const priv = await isPrivate(url);
    if (priv === false) return committed(`origin (${url}) is public: memory is never pushed to a public repository. Point origin at a private one`);
    if (priv === undefined) return committed(`could not confirm that origin (${url}) is private: not pushed`);
    const pushed = await git(['push', '-q', 'origin', 'HEAD'], root);
    if (pushed.code !== 0) return committed(`git push failed: ${lastLine(pushed)}`);
    return { state: 'pushed', files, held };
  };

  const status = await git(['status', '--porcelain', '-z', '--untracked-files=all', '--', '.'], root);
  if (status.code !== 0) return none('held', `git status failed: ${lastLine(status)}`);
  const changed = changedPaths(status.stdout).filter((p) => /\.md$/i.test(p));
  if (!changed.length) return (await ahead()) > 0 ? push([], []) : none('clean');

  const files: string[] = [];
  const held: string[] = [];
  for (const rel of changed) {
    const file = path.join(root, rel);
    const secret = fs.existsSync(file) ? secretIn(fs.readFileSync(file, 'utf8')) : undefined;
    if (secret) held.push(`${rel} (${secret})`);
    else files.push(rel);
  }
  if (!files.length) return { state: 'held', files, held, detail: 'every changed file holds what looks like a secret' };

  const add = await git(['add', '-A', '--', ...files], root);
  if (add.code !== 0) return { state: 'held', files: [], held, detail: `git add failed: ${lastLine(add)}` };
  const folders = [...new Set(files.map((f) => f.split('/')[0]))].sort();
  const message = `memory: ${folders.join(', ')} (${files.length} file${files.length === 1 ? '' : 's'})`;
  // The repository's own identity when it has one; otherwise the app's, never whatever this machine's global one is.
  const own = await git(['config', '--local', 'user.email'], root);
  const who = own.code === 0 && own.stdout.trim() ? [] : o.identity ? ['-c', `user.name=${o.identity.name}`, '-c', `user.email=${o.identity.email}`] : [];
  const commit = await git([...who, 'commit', '-q', '-m', message, '--', ...files], root);
  if (commit.code !== 0) return { state: 'held', files: [], held, detail: `git commit failed: ${lastLine(commit)}` };
  return push(files, held);
}

/** One line for the log, or undefined when there is nothing to say. */
export function describeMemoryGit(r: MemoryGitResult): string | undefined {
  if (r.state === 'not-a-repo' || r.state === 'clean') return undefined;
  const held = r.held.length ? `; held back: ${r.held.join(', ')}` : '';
  const what = r.files.length ? `${r.files.length} file(s)` : 'earlier commits';
  if (r.state === 'pushed') return `orchestrator memory: committed and pushed ${what}${held}`;
  if (r.state === 'committed') return `orchestrator memory: ${what} committed, NOT pushed: ${r.detail}${held}`;
  return `orchestrator memory: nothing committed: ${r.detail}${held}`;
}
