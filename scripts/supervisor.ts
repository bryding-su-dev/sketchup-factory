// The update a supervisor runs between two server runs on macOS and Linux (scripts/supervise.ts): the counterpart of
// scripts/update-steps.ps1 on Windows, plus a health check of the new server and a rollback when the update breaks it.
// Node built-ins only: `npm ci` replaces node_modules while this runs. docs/restart.md, "Updating".
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** What the next server reads as data/update.result.json (server/restart.ts UpdateResult). */
export interface UpdateResult {
  ok: boolean;
  at: string;
  headBefore?: string;
  headAfter?: string;
  error?: string;
  /** Nothing was changed: the checkout could not be updated as it is (dirty, diverged, no upstream). */
  refused?: boolean;
  /** The update failed after it changed the checkout, which was put back to headBefore. */
  rolledBack?: boolean;
  /** Nothing new upstream. */
  upToDate?: boolean;
}

export interface Run {
  code: number;
  out: string;
}

/** The outside world, so the tests can run the logic without npm (and with or without git). */
export interface Sys {
  run(cmd: string, args: string[]): Run;
  log(line: string): void;
  now(): Date;
}

/** Spawn in `cwd`, output captured (the log gets it); git never prompts for a credential. */
export function realSys(cwd: string, log: (line: string) => void): Sys {
  return {
    run(cmd, args) {
      const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, maxBuffer: 64 * 1024 * 1024 });
      return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? String(r.error) : ''}` };
    },
    log,
    now: () => new Date(),
  };
}

const git = (sys: Sys, ...args: string[]) => sys.run('git', args);
const head = (sys: Sys) => git(sys, 'rev-parse', 'HEAD').out.trim();
const tail = (s: string, n = 400) => {
  const t = s.trim();
  return t.length > n ? `…${t.slice(-n)}` : t;
};

/** Tracked files installs may rewrite: put back before deciding the checkout is dirty, as update-steps.ps1 does. */
export const GENERATED = ['package.json', 'package-lock.json', 'web/package.json', 'web/package-lock.json'];

export type Plan = { kind: 'refuse'; reason: string } | { kind: 'up-to-date'; head: string } | { kind: 'update'; from: string; to: string };

/** Whether and how the checkout can be updated. Changes nothing but the fetched remote refs and the generated files. */
export function planUpdate(sys: Sys): Plan {
  for (const f of GENERATED) git(sys, 'checkout', '--', f); // one at a time: a missing path fails the whole call
  const dirty = git(sys, 'status', '--porcelain', '--untracked-files=no').out.split('\n').filter((l) => l.trim());
  if (dirty.length) return { kind: 'refuse', reason: `tracked files are modified in the app's checkout (${dirty.map((l) => l.slice(3)).slice(0, 8).join(', ')}); commit or discard them, then update again` };
  const upstream = git(sys, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}');
  if (upstream.code !== 0) return { kind: 'refuse', reason: "the app's branch has no upstream to pull from" };
  const fetched = git(sys, 'fetch', 'origin');
  if (fetched.code !== 0) return { kind: 'refuse', reason: `git fetch failed: ${tail(fetched.out, 300)}` };
  const from = head(sys);
  const to = git(sys, 'rev-parse', '@{u}').out.trim();
  if (from === to) return { kind: 'up-to-date', head: from };
  if (git(sys, 'merge-base', '--is-ancestor', 'HEAD', '@{u}').code !== 0) {
    const ahead = git(sys, 'rev-list', '--count', '@{u}..HEAD').out.trim();
    return { kind: 'refuse', reason: `${upstream.out.trim()} is not a fast-forward of this checkout (${ahead} local commit(s) not in it); push or drop them, then update again` };
  }
  return { kind: 'update', from, to };
}

/** Install exactly what the lock files say and rebuild the web UI; the reason for the first step that fails. */
export function installAndBuild(sys: Sys): string | undefined {
  for (const [what, args] of [
    ['npm ci', ['ci', '--no-audit', '--no-fund']],
    ['npm run build', ['run', 'build']],
  ] as const) {
    sys.log(`== ${what}`);
    const r = sys.run('npm', [...args]);
    if (r.code !== 0) return `${what} failed (exit ${r.code}): ${tail(r.out)}`;
  }
  return undefined;
}

/** Put the checkout back to `to` (ignored files such as config.json, data/ and node_modules stay) and rebuild it. */
export function rollback(sys: Sys, to: string): string | undefined {
  sys.log(`== rolling back to ${to.slice(0, 9)}`);
  const reset = git(sys, 'reset', '--hard', to);
  if (reset.code !== 0) return `git reset --hard ${to.slice(0, 9)} failed: ${tail(reset.out, 300)}`;
  return installAndBuild(sys);
}

/**
 * The whole update: plan, pull, install, build, then `checkHealth` (write `provisional` for the new server, which reads
 * it at boot, start it and see it answer with the new commit). A refusal changes nothing; a failure after the pull rolls
 * back, and `stopNew` (stop what checkHealth started) runs before the rollback. The caller writes the final result.
 */
export async function runUpdate(sys: Sys, checkHealth: (provisional: UpdateResult) => Promise<string | undefined>, stopNew: () => Promise<void>): Promise<UpdateResult> {
  const at = sys.now().toISOString();
  const plan = planUpdate(sys);
  if (plan.kind === 'refuse') {
    sys.log(`update REFUSED: ${plan.reason}`);
    return { ok: false, at, refused: true, error: `update refused, nothing changed: ${plan.reason}`, headBefore: head(sys), headAfter: head(sys) };
  }
  if (plan.kind === 'up-to-date') {
    sys.log(`already up to date at ${plan.head.slice(0, 9)}`);
    return { ok: true, at, upToDate: true, headBefore: plan.head, headAfter: plan.head };
  }
  sys.log(`updating ${plan.from.slice(0, 9)} → ${plan.to.slice(0, 9)}`);
  const pull = git(sys, 'pull', '--ff-only');
  let failure = pull.code !== 0 ? `git pull --ff-only failed: ${tail(pull.out, 300)}` : installAndBuild(sys);
  let started = false;
  if (!failure) {
    started = true;
    failure = await checkHealth({ ok: true, at, headBefore: plan.from, headAfter: head(sys) });
  }
  if (!failure) {
    sys.log(`update OK: ${plan.from.slice(0, 9)} → ${head(sys).slice(0, 9)}, healthy`);
    return { ok: true, at, headBefore: plan.from, headAfter: head(sys) };
  }
  sys.log(`update FAILED: ${failure}`);
  if (started) await stopNew();
  const back = rollback(sys, plan.from);
  if (back) sys.log(`ROLLBACK FAILED too: ${back}; starting whatever is on disk`);
  return {
    ok: false,
    at,
    rolledBack: !back,
    error: back ? `${failure}; the rollback to ${plan.from.slice(0, 9)} failed as well (${back})` : `${failure}; rolled back to ${plan.from.slice(0, 9)}`,
    headBefore: plan.from,
    headAfter: head(sys),
  };
}

/** Poll the server's /api/health until it reports `sha` (a short or full commit), the process ends, or time runs out. */
export async function waitHealthy(url: string, sha: string, opts: { timeoutMs: number; everyMs?: number; alive?: () => boolean; fetchFn?: typeof fetch }): Promise<string | undefined> {
  const end = Date.now() + opts.timeoutMs;
  const fetchFn = opts.fetchFn ?? fetch;
  let last = 'no answer';
  while (Date.now() < end) {
    if (opts.alive && !opts.alive()) return `the new server exited before it was healthy (${last}; see data/server.err.log)`;
    try {
      const r = await fetchFn(url, { signal: AbortSignal.timeout(5000) });
      const j = (await r.json()) as { ok?: boolean; sha?: string };
      if (r.ok && j.ok && j.sha && (sha.startsWith(j.sha) || j.sha.startsWith(sha))) return undefined;
      last = `${r.status}, commit ${j.sha ?? 'unknown'}`;
    } catch (e) {
      last = (e as Error).message;
    }
    await new Promise((res) => setTimeout(res, opts.everyMs ?? 2000));
  }
  return `the new server did not report commit ${sha.slice(0, 9)} on ${url} within ${Math.round(opts.timeoutMs / 1000)} s (last: ${last})`;
}

/** The port and data folder from the app's config (FFSB_CONFIG or config.json), with server/config.ts's defaults. */
export function appPaths(root: string, env: NodeJS.ProcessEnv = process.env): { port: number; dataDir: string } {
  let raw: { port?: number; dataDir?: string } = {};
  try {
    const t = fs.readFileSync(env.FFSB_CONFIG ?? path.join(root, 'config.json'), 'utf8');
    raw = JSON.parse(t.charCodeAt(0) === 0xfeff ? t.slice(1) : t);
  } catch {
    // no or unreadable config: the server will say why; the defaults keep the supervisor going
  }
  return { port: Number(raw.port) || 8790, dataDir: path.resolve(root, raw.dataDir ?? './data') };
}
