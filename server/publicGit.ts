import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Which GitHub repos are public, and the git settings that make agents commit to them with the public
 * identity automatically. Used by the guard's identity rule (any repo GitHub reports as public, not only
 * the configured ones) on the host and on the machines, and by the worker launch (docs/machines.md).
 */

type Run = (cmd: string, args: string[]) => string | undefined;

const runSync: Run = (cmd, args) => {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  } catch {
    return undefined;
  }
};

const HOUR = 3_600_000;
const visibility = new Map<string, { isPublic: boolean | undefined; at: number }>();

/**
 * Whether a repo ("github.com/owner/name") is public: `gh api repos/<owner>/<name>` (.private), else an
 * anonymous request to the GitHub API (200: anyone can see it). Cached: public for a day, private for an
 * hour, unknown for 5 minutes. undefined when neither could tell.
 */
export function repoIsPublic(key: string, now = Date.now(), run: Run = runSync): boolean | undefined {
  const m = /^github\.com\/([\w.-]+)\/([\w.-]+)$/i.exec(key);
  if (!m) return undefined;
  const hit = visibility.get(key.toLowerCase());
  if (hit && now - hit.at < (hit.isPublic ? 24 * HOUR : hit.isPublic === false ? HOUR : 5 * 60_000)) return hit.isPublic;
  let isPublic: boolean | undefined;
  const gh = run('gh', ['api', `repos/${m[1]}/${m[2]}`, '--jq', '.private'])?.trim();
  if (gh === 'false') isPublic = true;
  else if (gh === 'true') isPublic = false;
  else {
    const code = run('curl', ['-s', '-o', process.platform === 'win32' ? 'NUL' : '/dev/null', '-w', '%{http_code}', '--max-time', '8', `https://api.github.com/repos/${m[1]}/${m[2]}`])?.trim();
    if (code === '200') isPublic = true;
    else if (code === '404') isPublic = false;
  }
  visibility.set(key.toLowerCase(), { isPublic, at: now });
  return isPublic;
}

/** Forget cached answers (tests). */
export function clearVisibilityCache() {
  visibility.clear();
  owned.clear();
}

const owned = new Map<string, { repos: string[]; at: number; refreshing?: boolean }>();

/**
 * The public repos ("owner/name") of these GitHub owners, from `gh repo list --visibility public`. Returns
 * what is cached at once (empty the first time) and refreshes in the background every hour, so a launch
 * never waits on GitHub.
 */
export function publicReposOf(owners: string[], now = Date.now()): string[] {
  const out: string[] = [];
  for (const o of new Set(owners.map((x) => x.toLowerCase()))) {
    const hit = owned.get(o);
    if (hit) out.push(...hit.repos);
    if (hit?.refreshing || (hit && now - hit.at < HOUR)) continue;
    const entry = { repos: hit?.repos ?? [], at: hit?.at ?? 0, refreshing: true };
    owned.set(o, entry);
    execFile('gh', ['repo', 'list', o, '--visibility', 'public', '--limit', '500', '--json', 'nameWithOwner', '--jq', '.[].nameWithOwner'], { timeout: 30_000, windowsHide: true }, (err, stdout) => {
      entry.refreshing = false;
      if (err) return; // try again on the next launch
      entry.repos = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
      entry.at = Date.now();
      for (const r of entry.repos) visibility.set(`github.com/${r}`.toLowerCase(), { isPublic: true, at: entry.at });
    });
  }
  return [...new Set(out)];
}

/** "owner/name" of a GitHub URL or key, or undefined. */
export function githubSlug(url: string): string | undefined {
  const m = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : undefined;
}

/**
 * Environment that makes git use `identity` in any clone whose remote is one of `repos` ("owner/name"):
 * command-scope config (GIT_CONFIG_COUNT) holding an includeIf "hasconfig:remote.*.url:..." per URL form,
 * which outranks the clone's own user.name/user.email. Nobody's gitconfig changes; only the agent's
 * processes see it. Needs git 2.36+ (older git ignores the condition). `file` is written here.
 */
export function publicIdentityEnv(identity: { name: string; email: string }, repos: string[], file: string, baseEnv: NodeJS.ProcessEnv = {}): Record<string, string> {
  if (!repos.length) return {};
  const q = (s: string) => `"${s.replace(/["\\]/g, '')}"`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `# Written by SketchUp Factory: the identity agents commit with in public repos.\n[user]\n\tname = ${q(identity.name)}\n\temail = ${q(identity.email)}\n`);
  const start = Number(baseEnv.GIT_CONFIG_COUNT ?? 0) || 0;
  const env: Record<string, string> = {};
  let n = start;
  for (const r of [...new Set(repos)].sort()) {
    for (const url of [`https://github.com/${r}`, `git@github.com:${r}`, `ssh://git@github.com/${r}`]) {
      env[`GIT_CONFIG_KEY_${n}`] = `includeIf.hasconfig:remote.*.url:${url}**.path`;
      env[`GIT_CONFIG_VALUE_${n}`] = file.replace(/\\/g, '/');
      n++;
    }
  }
  env.GIT_CONFIG_COUNT = String(n);
  return env;
}

let me: { login: string; id: number; at: number } | undefined;
let meRefreshing = false;

/** The gh account's login and noreply email ("<id>+<login>@users.noreply.github.com"), cached; refreshed in the background. */
export function ghNoreply(now = Date.now()): { login: string; email: string } | undefined {
  if (!meRefreshing && (!me || now - me.at > 24 * HOUR)) {
    meRefreshing = true;
    execFile('gh', ['api', 'user', '--jq', '.id, .login'], { timeout: 30_000, windowsHide: true }, (err, stdout) => {
      meRefreshing = false;
      const m = /^(\d+)\s+(\S+)/.exec(stdout?.trim() ?? '');
      if (!err && m) me = { id: Number(m[1]), login: m[2], at: Date.now() };
    });
  }
  return me ? { login: me.login, email: `${me.id}+${me.login}@users.noreply.github.com` } : undefined;
}
