// A hard crash (power cut, BSOD, WHEA error) while the app writes its data: the store, the transcripts, the
// orchestrators' memory and a whole server come back by themselves with the last good state (server/durable.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Store } from './store.ts';
import { backupMemory, healMemory, memoryBackupRoot } from './orchestratorMemory.ts';
import { dataRecoveries, generationPath } from './durable.ts';
import type { SessionInfo } from '../shared/types.ts';

function tmp(t: { after: (fn: () => void) => void }, prefix: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  return dir;
}

const session = (id: string, title: string): SessionInfo => ({
  id,
  kind: 'worker',
  title,
  status: 'idle',
  permissionMode: 'bypassPermissions',
  createdAt: '2026-09-30T13:00:00.000Z',
  lastActivityAt: '2026-09-30T13:00:00.000Z',
  turns: 1,
  costUsd: 0,
  pendingPermissions: [],
});

const zero = (f: string) => fs.writeFileSync(f, Buffer.alloc(Math.max(64, fs.statSync(f, { throwIfNoEntry: false })?.size ?? 0)));

test('store: a zeroed state.json and a torn work.json start from their last good versions', (t) => {
  const dir = tmp(t, 'ffsb-crash-store-');
  const a = new Store(dir);
  a.putSession(session('s1', 'first'));
  a.workSeq = 7;
  a.putWork({ id: 'w7', title: 'ledger item' } as never);
  a.flush();
  a.putSession(session('s2', 'second'));
  a.workSeq = 8;
  a.putWork({ id: 'w8', title: 'filed just before the crash' } as never);
  a.flush();
  // The crash hits while the next version is written: state.json zeroed, work.json cut off.
  zero(path.join(dir, 'state.json'));
  fs.writeFileSync(path.join(dir, 'work.json'), '{"seq": 7, "items": [{"id": "w7", "ti');
  const b = new Store(dir);
  assert.deepEqual([...b.sessions.keys()], ['s1'], 'state.json.1: the version before the last save');
  assert.deepEqual([...b.work.keys()], ['w7']);
  assert.equal(b.workSeq, 107, 'a restored ledger skips past numbers the lost version may have handed out');
  const mine = dataRecoveries.filter((r) => r.file.startsWith(dir));
  assert.deepEqual(
    mine.map((r) => [path.basename(r.file), path.basename(r.from ?? '')]),
    [
      ['state.json', 'state.json.1'],
      ['work.json', 'work.json.1'],
    ],
  );
  b.flush();
});

test('store: saves never lose to a steady stream of updates (7,000 sessions)', async (t) => {
  const dir = tmp(t, 'ffsb-crash-busy-');
  const s = new Store(dir);
  for (let i = 0; i < 7000; i++) s.sessions.set(`z${i}`, session(`z${i}`, `agent ${i}`));
  const t0 = Date.now();
  let n = 0;
  // Busy agents: a session update every 30 ms for 2.5 s. The old debounce restarted its 200 ms timer on each one.
  while (Date.now() - t0 < 2500) {
    s.putSession({ ...session('busy', `update ${++n}`) });
    await new Promise((r) => setTimeout(r, 30));
  }
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')) as { sessions: SessionInfo[] };
  const title = saved.sessions.find((x) => x.id === 'busy')?.title ?? '';
  const behind = n - Number(title.split(' ')[1]);
  assert.equal(saved.sessions.length, 7001);
  assert.ok(behind < 60, `state.json is at most ~1.5 s behind while busy (${behind} updates behind)`);
  await s.saved();
  s.flush();
});

test('transcripts: a line torn by a crash does not swallow the next event, and zero bytes are skipped', (t) => {
  const dir = tmp(t, 'ffsb-crash-tr-');
  fs.mkdirSync(path.join(dir, 'transcripts'));
  const f = path.join(dir, 'transcripts', 's1.jsonl');
  fs.writeFileSync(f, '{"seq":1,"t":"x","kind":"assistant","text":"before"}\n{"seq":2,"t":"x","kind":"assis');
  const s = new Store(dir);
  s.append('s1', { kind: 'assistant', text: 'after the crash' } as never);
  assert.deepEqual(
    s.readTranscript('s1').map((e) => (e as { text: string }).text),
    ['before', 'after the crash'],
  );
  fs.appendFileSync(f, Buffer.alloc(40));
  fs.appendFileSync(f, '{"seq":9,"t":"x","kind":"assistant","text":"after zeros"}\n');
  assert.equal((s.readTranscript('s1').pop() as { text: string }).text, 'after zeros');
  s.flush();
});

test('orchestrator memory: backed up when changed, and a zeroed file gets its last good copy back', (t) => {
  const root = path.join(tmp(t, 'ffsb-crash-mem-'), 'orchestrator-memory');
  const ben = path.join(root, 'person-ben');
  fs.mkdirSync(ben, { recursive: true });
  fs.writeFileSync(path.join(ben, 'MEMORY.md'), '- [Deploys](deploys.md) wait for Ben\n');
  fs.writeFileSync(path.join(ben, 'deploys.md'), 'Never deploy without Ben.\n');
  assert.equal(backupMemory(root), true);
  assert.equal(backupMemory(root), false, 'nothing changed: no new copy');
  assert.equal(fs.statSync(path.join(memoryBackupRoot(root), '1', 'person-ben', 'MEMORY.md')).nlink, 1, 'a copy, not a hard link (the guard refuses those)');
  // The crash: MEMORY.md zeroed while the CLI wrote it, deploys.md emptied.
  zero(path.join(ben, 'MEMORY.md'));
  fs.writeFileSync(path.join(ben, 'deploys.md'), '');
  assert.equal(backupMemory(root), false, 'damaged files are not backed up over good copies');
  const healed = healMemory(root);
  assert.equal(healed.length, 2);
  assert.equal(fs.readFileSync(path.join(ben, 'MEMORY.md'), 'utf8'), '- [Deploys](deploys.md) wait for Ben\n');
  assert.equal(fs.readFileSync(path.join(ben, 'deploys.md'), 'utf8'), 'Never deploy without Ben.\n');
  assert.ok(fs.readdirSync(path.join(memoryBackupRoot(root), 'damaged', 'person-ben')).some((n) => n.startsWith('MEMORY.md.damaged-')), 'the damaged file is kept');
  assert.match(healed[0].label ?? '', /orchestrator memory person-ben\//);
});

async function freePort(): Promise<number> {
  const srv = net.createServer();
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as net.AddressInfo).port;
  await new Promise((r) => srv.close(r));
  return port;
}

test('the real server comes back by itself from a zeroed state.json and users.json', { timeout: 90_000 }, async (t) => {
  const base = tmp(t, 'ffsb-crash-boot-');
  const data = path.join(base, 'data');
  const repo = path.join(base, 'base');
  fs.mkdirSync(data);
  fs.mkdirSync(path.join(base, 'sandboxes'));
  fs.mkdirSync(repo);
  execFileSync('git', ['init', '-q', '-b', 'develop'], { cwd: repo });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@users.noreply.github.com', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: repo });
  const port = await freePort();
  fs.writeFileSync(
    path.join(base, 'config.json'),
    JSON.stringify({
      port,
      host: '127.0.0.1',
      trustProxy: false,
      dataDir: data,
      sandboxRoot: path.join(base, 'sandboxes'),
      repo: { url: repo, basePath: repo },
      defaultBase: 'develop',
      unity: { editorPath: path.join(base, 'no-unity', 'Unity.exe'), watchdog: { stallMinutes: 0, runningPollSeconds: 0, autoDismiss: false } },
      voice: { enabled: false, autoInstall: false, tts: false },
      hostGuard: { pollSeconds: 0 },
      // No orchestrator is started (no Claude in a unit test): the restart summary still goes to the log.
      orchestrator: { notifyOnWorkerEvents: false },
    }),
  );
  // What BEAST had on 2026-09-30: state.json all zero bytes. Plus users.json, which every start reads.
  const state = { sandboxes: [], sessions: [session('s1', 'kept across the crash')], settings: { heartbeatMinutes: null } };
  fs.writeFileSync(generationPath(path.join(data, 'state.json'), 1), JSON.stringify(state, null, 2));
  fs.writeFileSync(path.join(data, 'state.json'), Buffer.alloc(4096));
  fs.writeFileSync(generationPath(path.join(data, 'users.json'), 1), JSON.stringify([{ username: 'tester', hash: 'scrypt$1$1$1$AA$AA' }]));
  fs.writeFileSync(path.join(data, 'users.json'), Buffer.alloc(512));

  // A home of its own: no Claude login, no Discord token, nothing of this machine's.
  const home = path.join(base, 'home');
  fs.mkdirSync(home);
  const env: NodeJS.ProcessEnv = { ...process.env, FFSB_CONFIG: path.join(base, 'config.json'), HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude') };
  for (const k of ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'DISCORD_TOKEN']) delete env[k];
  const child = spawn(process.execPath, [path.join(import.meta.dirname, 'index.ts')], { cwd: path.join(import.meta.dirname, '..'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  const exited = new Promise<number | null>((r) => child.once('exit', (code) => r(code)));
  const until = async (what: RegExp, ms: number) => {
    const end = Date.now() + ms;
    while (!what.test(log)) {
      if (child.exitCode !== null) assert.fail(`the server exited (${child.exitCode}) before ${what}:\n${log}`);
      if (Date.now() > end) assert.fail(`no ${what} within ${ms} ms:\n${log}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  await until(new RegExp(`on http://127\\.0\\.0\\.1:${port}`), 60_000);
  const res = await fetch(`http://127.0.0.1:${port}/api/state`);
  assert.equal(res.status, 401, 'up and answering (a login is needed)');
  await until(/DATA RESTORED AFTER A CRASH/, 20_000);
  assert.match(log, /state\.json was all zero bytes \(4096 bytes\); restored the version saved at .*\(state\.json\.1\)/);
  assert.match(log, /users\.json was all zero bytes \(512 bytes\); restored/);
  // Stop it the way the scripts do.
  fs.writeFileSync(path.join(data, 'restart.request'), '');
  assert.equal(await exited, 0);
  const after = JSON.parse(fs.readFileSync(path.join(data, 'state.json'), 'utf8')) as typeof state;
  assert.ok(
    after.sessions.some((s) => s.title === 'kept across the crash'),
    after.sessions.map((s) => s.title).join(', '),
  );
  t.diagnostic(log.split('\n').filter((l) => /DATA|restored|unclean|SketchUp Factory/.test(l)).join('\n'));
  assert.ok(fs.readdirSync(data).some((n) => n.startsWith('state.json.damaged-')), 'the zeroed file is kept');
});
