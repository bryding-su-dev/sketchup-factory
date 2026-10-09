// Keeps the SketchUp Factory server running on macOS and Linux: the counterpart of scripts/supervise.ps1. launchd
// (scripts/mac/install-autostart.sh) keeps THIS process alive; this process starts node server/index.ts and restarts it
// whenever it exits, so launchd and the supervisor never both restart the server. Between two runs it applies an update
// when the server left data/update.request (request_app_update, scripts/mac/restart.sh --update): see scripts/supervisor.ts.
// Node built-ins only: npm ci replaces node_modules while this runs. docs/restart.md.
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { appPaths, realSys, runUpdate, waitHealthy } from './supervisor.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const { port, dataDir } = appPaths(ROOT);
fs.mkdirSync(dataDir, { recursive: true });
const logFile = path.join(dataDir, 'supervisor.log');
const log = (line: string) => fs.appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`);
const sys = realSys(ROOT, (line) => log(line));
const updateFlag = path.join(dataDir, 'update.request');
const resumeFile = path.join(dataDir, 'resume.json');
const HEALTH_TIMEOUT_MS = Number(process.env.FFSB_HEALTH_TIMEOUT_MS) || 180_000;

fs.writeFileSync(path.join(dataDir, 'supervisor.pid'), String(process.pid));
log(`supervisor started (pid ${process.pid}, ${ROOT}, port ${port})`);

let child: ChildProcess | undefined;
let stopping = false;

/** Start the server; the previous run's output is kept as *.prev (and the first crash of a streak for good). */
function startServer(crashing: boolean): ChildProcess {
  for (const f of ['server.out.log', 'server.err.log']) {
    const p = path.join(dataDir, f);
    if (!fs.existsSync(p)) continue;
    if (crashing && !fs.existsSync(`${p}.firstcrash`)) fs.copyFileSync(p, `${p}.firstcrash`);
    fs.renameSync(p, `${p}.prev`);
  }
  const out = fs.openSync(path.join(dataDir, 'server.out.log'), 'a');
  const err = fs.openSync(path.join(dataDir, 'server.err.log'), 'a');
  const c = spawn(process.execPath, ['server/index.ts'], { cwd: ROOT, stdio: ['ignore', out, err], env: process.env });
  fs.closeSync(out);
  fs.closeSync(err);
  fs.writeFileSync(path.join(dataDir, 'server.pid'), String(c.pid ?? ''));
  log(`started server pid ${c.pid}`);
  return c;
}

const exited = (c: ChildProcess) => new Promise<number | null>((res) => (c.exitCode !== null || c.signalCode !== null ? res(c.exitCode) : c.once('exit', (code) => res(code))));

/** SIGTERM (the server's clean stop: it records what to resume), then SIGKILL after a minute. */
async function stopServer(c: ChildProcess) {
  if (c.exitCode !== null || c.signalCode !== null) return;
  c.kill('SIGTERM');
  const killer = setTimeout(() => c.kill('SIGKILL'), 60_000);
  await exited(c);
  clearTimeout(killer);
}

/**
 * The server left data/update.request and exited: update, start the new code and check it, roll back when it fails.
 * The resume file the stopping server wrote is kept aside, so a rolled-back server still resumes the cut-off workers
 * and tells the orchestrator (a failed new server may already have taken it).
 */
async function update(): Promise<ChildProcess> {
  fs.rmSync(updateFlag, { force: true });
  log('update requested');
  const resumeBackup = `${resumeFile}.update`;
  if (fs.existsSync(resumeFile)) fs.copyFileSync(resumeFile, resumeBackup);
  let started: ChildProcess | undefined;
  const result = await runUpdate(
    sys,
    async (provisional) => {
      fs.writeFileSync(path.join(dataDir, 'update.result.json'), JSON.stringify(provisional));
      const sha = provisional.headAfter ?? '';
      started = startServer(false);
      const c = started;
      return waitHealthy(`http://127.0.0.1:${port}/api/health`, sha, { timeoutMs: HEALTH_TIMEOUT_MS, alive: () => c.exitCode === null && c.signalCode === null });
    },
    async () => {
      if (started) await stopServer(started);
      started = undefined;
      if (fs.existsSync(resumeBackup)) fs.copyFileSync(resumeBackup, resumeFile);
    },
  );
  // Written before the rolled-back server starts (it reads it at boot); a healthy new server reads it a little later.
  fs.writeFileSync(path.join(dataDir, 'update.result.json'), JSON.stringify(result));
  fs.rmSync(resumeBackup, { force: true });
  return started ?? startServer(false);
}

async function main() {
  let delay = 3;
  for (;;) {
    const c = fs.existsSync(updateFlag) ? await update() : startServer(delay === 6);
    child = c;
    const began = Date.now();
    const code = await exited(c);
    child = undefined;
    if (stopping) return;
    // Back off when it keeps dying quickly (a crash loop), reset after a healthy run; at most a minute.
    delay = Date.now() - began > 5 * 60_000 || fs.existsSync(updateFlag) ? 3 : Math.min(delay * 2, 60);
    let why = '';
    try {
      const last = fs.readFileSync(path.join(dataDir, 'server.err.log'), 'utf8').split('\n').slice(-60).filter((l) => /^\w*(Error|Exception)\b|^\s*Error:/.test(l)).pop();
      if (code && last) why = `; last error: ${last.trim()}`;
    } catch {
      // no log
    }
    log(`server exited with code ${code}${why}; ${fs.existsSync(updateFlag) ? 'updating' : `restarting in ${delay}s`}`);
    if (!fs.existsSync(updateFlag)) await new Promise((res) => setTimeout(res, delay * 1000));
  }
}

// launchd stops the job with SIGTERM (bootout, kickstart -k): stop the server cleanly first, then go.
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, async () => {
    if (stopping) return;
    stopping = true;
    log(`${sig}: stopping the server`);
    if (child) await stopServer(child);
    process.exit(0);
  });
}

main().catch((e) => {
  log(`supervisor crashed: ${(e as Error).stack ?? e}`);
  process.exit(1);
});
