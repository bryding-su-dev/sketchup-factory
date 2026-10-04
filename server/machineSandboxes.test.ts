import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import type { EventEmitter } from 'node:events';
import type { AddressInfo } from 'node:net';
import { Store } from './store.ts';
import { SessionManager, type SessionHandle, type SessionSink } from './sessions.ts';
import { MachineManager, limitOptions, machineForPath, mergeSandboxes, parseSandboxRef, poolSettingsOf } from './machines.ts';
import { daemonConfig } from './machineDeploy.ts';
import { Daemon, type Probes } from '../machine/daemon.ts';
import { SandboxPool, deletable, idleSandboxEditors, librarySource, type PoolDeps, type SandboxEditor } from '../machine/sandboxes.ts';
import { copyTree, removeTree, run } from './proc.ts';
import { readGitStatus } from './gitStatus.ts';
import type { Config } from './config.ts';
import type { ImageInput, PermissionMode, SandboxPoolSettings, SessionInfo } from '../shared/types.ts';

const GB = 1024 ** 3;

const until = async (what: string, cond: () => boolean, ms = 60_000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
};

/** A bare origin and the machine's main clone of it (on develop), with a warm Library the clone never commits. */
function repos() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-msb-'));
  const origin = path.join(root, 'origin.git');
  const main = path.join(root, 'FinalFactory');
  const git = (dir: string, ...a: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { stdio: 'pipe' }).toString().trim();
  execFileSync('git', ['init', '-q', '--bare', '-b', 'develop', origin]);
  execFileSync('git', ['clone', '-q', origin, main], { stdio: 'pipe' });
  git(main, 'switch', '-q', '-c', 'develop');
  fs.writeFileSync(path.join(main, '.gitignore'), 'Library/\nLogs/\nTemp/\n');
  fs.writeFileSync(path.join(main, 'README.md'), 'game\n');
  git(main, 'add', '.gitignore', 'README.md');
  git(main, 'commit', '-q', '-m', 'base');
  git(main, 'push', '-q', '-u', 'origin', 'develop');
  fs.mkdirSync(path.join(main, 'Library', 'Artifacts'), { recursive: true });
  fs.writeFileSync(path.join(main, 'Library', 'Artifacts', 'warm.bin'), 'imported');
  const sbRoot = path.join(root, 'ffsb');
  return { root, origin, main, sbRoot, git, cleanup: () => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }) };
}

/** Real git, copy and delete; a stand-in editor (no Unity), and free space the test sets. */
function deps(repoPath: string, o: { free?: () => number | undefined } = {}) {
  const running = new Set<string>();
  const d: PoolDeps = {
    git: (args, opts = {}) => run('git', ['-C', repoPath, ...args], { timeoutMs: opts.timeoutMs ?? 120_000, signal: opts.signal, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }),
    copyTree: (src, dst, signal) => copyTree(src, dst, { signal }),
    removeTree,
    freeBytes: async () => (o.free ? o.free() : 500 * GB),
    procs: async () => [],
    editor: (sb, logFile): SandboxEditor => ({
      unity: {
        logFile,
        start: async () => {
          running.add(sb.path);
          return 'Started (fake).';
        },
        stop: async () => {
          running.delete(sb.path);
          return 'Stopped (fake).';
        },
        status: async () => (running.has(sb.path) ? 'running: pid 4242' : 'not running'),
        editors: () => (running.has(sb.path) ? [{ pid: 4242, ppid: 1, cmd: `Unity -projectPath ${sb.path}` }] : []),
      },
    }),
    bridgeUp: (p) => running.has(p),
    gitStatus: readGitStatus,
    now: () => Date.now(),
  };
  return { d, running };
}

const SETTINGS = (root: string, over: Partial<SandboxPoolSettings> = {}): SandboxPoolSettings => ({ root, maxSandboxes: 2, maxAgentsPerSandbox: 2, maxUnity: 1, diskWarnGB: 50, diskCriticalGB: 20, ...over });

function pool(r: ReturnType<typeof repos>, o: { free?: () => number | undefined; settings?: Partial<SandboxPoolSettings>; activity?: (id: string) => { busy: boolean; lastActivityMs: number }; idle?: number } = {}) {
  const events: { text: string; checkpoint?: boolean }[] = [];
  const { d, running } = deps(r.main, o);
  const p = new SandboxPool(
    {
      repoPath: r.main,
      stateFile: path.join(r.root, 'app', 'sandboxes.json'),
      settings: SETTINGS(r.sbRoot, o.settings),
      activity: o.activity ?? (() => ({ busy: false, lastActivityMs: Date.now() })),
      onChange: () => undefined,
      onEvent: (e) => events.push(e),
      idleStopMinutes: o.idle,
      librarySeedGB: 1,
    },
    d,
  );
  return { p, events, running };
}

const ready = (p: SandboxPool, id: string) => until(`${id} ready`, () => {
  const s = p.list().find((x) => x.id === id);
  if (s?.status === 'error') throw new Error(`${id} failed: ${s.statusDetail}`);
  return s?.status === 'ready';
});

// ---------------------------------------------------------------- the pool, against real git (CI runs this on Windows too)

test('machine sandboxes: a worktree of the main clone on its own branch, a warm Library, removed cleanly', async (t) => {
  const r = repos();
  t.after(r.cleanup);
  const { p } = pool(r);
  const created = await p.create({ id: 'sb1', branch: 'sandbox/sb1', base: 'origin/develop', seedLibrary: true, startUnity: false });
  assert.equal(created.status, 'creating');
  assert.equal(created.path, path.join(r.sbRoot, 'sb1'));
  await ready(p, 'sb1');
  const dir = path.join(r.sbRoot, 'sb1');
  assert.equal(fs.readFileSync(path.join(dir, 'README.md'), 'utf8').replace(/\r\n/g, '\n'), 'game\n', 'checked out');
  assert.equal(fs.readFileSync(path.join(dir, 'Library', 'Artifacts', 'warm.bin'), 'utf8'), 'imported', "the main clone's Library, copied");
  // The copied Library's stale script mappings: the first editor start reimports the scripts, via a script git ignores.
  const script = path.join(dir, 'Assets', '__FFFactoryReimport', 'Editor', 'ScriptReimportAfterLibraryCopy.cs');
  assert.match(fs.readFileSync(script, 'utf8'), /ImportAsset\(p, ImportAssetOptions\.ForceUpdate\)[\s\S]*DeleteAsset\(Folder\)/);
  fs.writeFileSync(path.join(dir, 'Assets', '__FFFactoryReimport.meta'), 'guid: x');
  assert.equal(r.git(dir, 'status', '--porcelain'), '', 'excluded from git, with the .meta Unity makes');
  assert.equal(r.git(r.main, 'status', '--porcelain'), '', 'the main clone is clean too');
  assert.equal(r.git(dir, 'branch', '--show-current'), 'sandbox/sb1');
  assert.match(r.git(r.main, 'worktree', 'list'), /ffsb[\\/]sb1/);
  assert.equal(r.git(r.main, 'branch', '--show-current'), 'develop', "the main clone's own checkout is untouched");
  assert.equal(p.list()[0].git?.branch, 'sandbox/sb1');

  // Persisted: a new daemon finds it.
  const again = pool(r).p;
  assert.deepEqual(again.list().map((s) => [s.id, s.status]), [['sb1', 'ready']]);

  const text = await p.remove('sb1');
  assert.match(text, /Deleted sandbox sb1/);
  assert.equal(fs.existsSync(dir), false, 'the folder is gone');
  assert.doesNotMatch(r.git(r.main, 'worktree', 'list'), /sb1/);
  assert.match(r.git(r.main, 'branch', '--list', 'sandbox/sb1'), /sandbox\/sb1/, 'the branch is kept by default');
  assert.deepEqual(p.list(), []);
});

test('machine sandboxes: a second one seeds its Library from a sandbox when the main clone has none; limits and bad names are refused', async (t) => {
  const r = repos();
  t.after(r.cleanup);
  const { p } = pool(r);
  await p.create({ id: 'sb1', branch: 'sandbox/sb1', base: 'origin/develop', seedLibrary: true, startUnity: false });
  await ready(p, 'sb1');
  fs.rmSync(path.join(r.main, 'Library'), { recursive: true, force: true });
  await p.create({ id: 'sb2', branch: 'feature/x', base: 'origin/develop', seedLibrary: true, startUnity: false });
  await ready(p, 'sb2');
  assert.equal(fs.readFileSync(path.join(r.sbRoot, 'sb2', 'Library', 'Artifacts', 'warm.bin'), 'utf8'), 'imported', "sb1's Library");
  assert.ok(fs.existsSync(path.join(r.sbRoot, 'sb2', 'Assets', '__FFFactoryReimport')), 'armed after any Library copy');
  const exclude = fs.readFileSync(path.join(r.main, '.git', 'info', 'exclude'), 'utf8');
  assert.equal(exclude.split('\n').filter((l) => l === '/Assets/__FFFactoryReimport*').length, 1, 'the exclude line once');

  await assert.rejects(p.create({ id: 'sb3', branch: 'sandbox/sb3', base: 'origin/develop', seedLibrary: false, startUnity: false }), /already 2 sandboxes on this machine \(max_sandboxes 2\)/);
  await p.remove('sb2', true);
  assert.equal(r.git(r.main, 'branch', '--list', 'feature/x'), '', 'deleteBranch removes the branch');
  await assert.rejects(p.create({ id: 'sb1', branch: 'sandbox/other', base: 'origin/develop', seedLibrary: false, startUnity: false }), /already exists/);
  await assert.rejects(p.create({ id: 'sb3', branch: 'develop', base: 'origin/develop', seedLibrary: false, startUnity: false }), /never master, main or develop/);
  await assert.rejects(p.create({ id: 'sb3', branch: 'bad..name', base: 'origin/develop', seedLibrary: false, startUnity: false }), /not a valid branch name/);
  await assert.rejects(p.create({ id: 'finalfactory', branch: 'sandbox/ff', base: 'origin/develop', seedLibrary: false, startUnity: false }), /main clone's folder name/);
  await assert.rejects(p.create({ id: 'Bad Name', branch: 'sandbox/x', base: 'origin/develop', seedLibrary: false, startUnity: false }), /not a usable sandbox name/);
});

test('machine sandboxes: editors are limited by max_unity; a switch waits for the editor to stop; the disk guard', async (t) => {
  const r = repos();
  t.after(r.cleanup);
  let free: number | undefined = 500 * GB;
  let busy = true;
  const { p, events, running } = pool(r, { free: () => free, settings: { maxUnity: 1 }, activity: () => ({ busy, lastActivityMs: Date.now() }) });
  for (const id of ['a', 'b']) await p.create({ id, branch: `sandbox/${id}`, base: 'origin/develop', seedLibrary: false, startUnity: false });
  await ready(p, 'a');
  await ready(p, 'b');
  await p.unity('a', 'start');
  assert.equal(p.list().find((s) => s.id === 'a')!.unity.state, 'starting');
  assert.match(p.list().find((s) => s.id === 'a')!.unity.logPath ?? '', /sandbox-editor\.log$/, 'its own log, not the shared Editor.log');
  await assert.rejects(p.unity('b', 'start'), /already 1 sandbox editors running on this machine \(a; max_unity 1\)/);
  await p.tick();
  assert.equal(p.list().find((s) => s.id === 'a')!.unity.state, 'running', 'up once its bridge is');
  await assert.rejects(p.switch('a', 'feature/y'), /editor of sandbox a is running: stop it first/);
  await p.unity('a', 'stop');
  assert.equal(running.size, 0);
  const res = await p.switch('a', 'feature/y');
  assert.equal(res.to, 'feature/y');
  assert.equal(p.list().find((s) => s.id === 'a')!.branch, 'feature/y');

  // Low disk: no new sandboxes or editors; critical: idle editors stop, busy agents are asked to checkpoint.
  free = 30 * GB;
  await p.tick();
  assert.equal(p.diskState().level, 'warn');
  await assert.rejects(p.unity('b', 'start'), /disk space is warn/);
  await assert.rejects(p.create({ id: 'c', branch: 'sandbox/c', base: 'origin/develop', seedLibrary: false, startUnity: false }), /disk space is warn|already 2 sandboxes/);
  free = 52 * GB;
  await p.tick();
  assert.equal(p.diskState().level, 'warn', 'hysteresis: 5 GB above the threshold before it clears');
  free = 200 * GB;
  await p.tick();
  assert.equal(p.diskState().level, 'ok');
  await p.unity('b', 'start');
  free = 10 * GB;
  await p.tick();
  assert.equal(p.diskState().level, 'critical');
  assert.equal(running.size, 1, 'an editor with a busy agent keeps running');
  assert.ok(events.some((e) => e.checkpoint), 'the portal is asked to tell busy agents to checkpoint');
  busy = false;
  await p.tick();
  assert.equal(running.size, 0, 'an idle one is stopped');
});

test('machine sandboxes: the idle-editor stop and a restarted daemon', async (t) => {
  const r = repos();
  t.after(r.cleanup);
  let last = Date.now();
  const { p, running } = pool(r, { idle: 1, activity: () => ({ busy: false, lastActivityMs: last }) });
  await p.create({ id: 'a', branch: 'sandbox/a', base: 'origin/develop', seedLibrary: false, startUnity: true });
  await ready(p, 'a');
  await until('editor started', () => running.size === 1);
  await p.tick();
  assert.equal(running.size, 1, 'recent activity');
  last = Date.now() - 5 * 60_000;
  // Started just now counts as activity too; age the start.
  (p as unknown as { unityState: Map<string, { startedAt?: number }> }).unityState.get('a')!.startedAt = last;
  await p.tick();
  assert.equal(running.size, 0, 'idle for longer than idleStopMinutes');

  // A create cut off by a daemon restart reads as an error, not as forever "creating".
  const file = path.join(r.root, 'app', 'sandboxes.json');
  const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
  rows[0].status = 'creating';
  fs.writeFileSync(file, JSON.stringify(rows));
  const after = pool(r).p;
  assert.equal(after.list()[0].status, 'error');
  assert.match(after.list()[0].statusDetail ?? '', /interrupted while creating/);
});

// ---------------------------------------------------------------- pure parts

test('machine sandboxes: only a direct child of the root named after it can be deleted, never the main clone', () => {
  assert.equal(deletable('D:\\work\\ffsb\\sb1', 'sb1', 'D:\\work\\ffsb', 'D:\\work\\FFFRepo', 'win32'), true);
  assert.equal(deletable('d:/work/FFSB/sb1/', 'sb1', 'D:\\work\\ffsb', 'D:\\work\\FFFRepo', 'win32'), true, 'case and slashes on Windows');
  assert.equal(deletable('D:\\work\\ffsb\\sb1\\Library', 'sb1', 'D:\\work\\ffsb', 'D:\\work\\FFFRepo', 'win32'), false);
  assert.equal(deletable('D:\\work\\ffsb\\sb2', 'sb1', 'D:\\work\\ffsb', 'D:\\work\\FFFRepo', 'win32'), false);
  assert.equal(deletable('D:\\work\\FFFRepo', 'fffrepo', 'D:\\work', 'D:\\work\\FFFRepo', 'win32'), false, 'the main clone itself');
  assert.equal(deletable('D:\\work\\FFFRepo\\sb', 'sb', 'D:\\work\\FFFRepo', 'D:\\work\\FFFRepo', 'win32'), false, 'inside the main clone');
  assert.equal(deletable('/Users/b/ffsb/sb1', 'sb1', '/Users/b/ffsb', '/Users/b/FinalFactory', 'darwin'), true);
  assert.equal(deletable('/Users/b/FFSB/sb1', 'sb1', '/Users/b/ffsb', '/Users/b/FinalFactory', 'darwin'), false, 'a Mac compares exactly');
});

test('machine sandboxes: where a Library comes from, and which editors are idle', () => {
  const has = (d: string) => d !== '/main' && d !== '/sb/empty';
  assert.equal(librarySource('/x', [], () => true), path.join('/x', 'Library'), "the main clone's first");
  const sbs = [
    { path: '/sb/busy', status: 'ready' as const, editorUp: true },
    { path: '/sb/idle', status: 'ready' as const, editorUp: false },
    { path: '/sb/new', status: 'creating' as const, editorUp: false },
  ];
  assert.equal(librarySource('/main', sbs, has), path.join('/sb/idle', 'Library'), 'a sandbox whose editor is stopped');
  assert.equal(librarySource('/main', [sbs[0]], has), path.join('/sb/busy', 'Library'), 'else any ready one');
  assert.equal(librarySource('/main', [{ path: '/sb/empty', status: 'ready', editorUp: false }], has), undefined);

  const now = 10 * 3_600_000;
  const act = (id: string) => ({ busy: id === 'busy', lastActivityMs: id === 'recent' ? now - 60_000 : 0 });
  const eds = [
    { id: 'old', up: true, startedAt: 0 },
    { id: 'recent', up: true, startedAt: 0 },
    { id: 'busy', up: true, startedAt: 0 },
    { id: 'justStarted', up: true, startedAt: now - 60_000 },
    { id: 'down', up: false },
  ];
  assert.deepEqual(idleSandboxEditors(eds, act, now, 120), ['old']);
  assert.deepEqual(idleSandboxEditors(eds, act, now, 0), [], '0 turns it off');
});

test('machine sandboxes: settings, limits, references and snapshots on the portal', () => {
  assert.equal(poolSettingsOf({}), null, 'no sandbox_root, no sandboxes');
  assert.deepEqual(poolSettingsOf({ sandboxRoot: 'D:\\work\\ffsb' }), { root: 'D:\\work\\ffsb', maxSandboxes: 3, maxAgentsPerSandbox: 2, maxUnity: 2, diskWarnGB: 50, diskCriticalGB: 20 });
  assert.equal(poolSettingsOf({ sandboxRoot: '/x', diskWarnGB: 10 })!.diskCriticalGB, 10, 'critical never above warn');

  assert.deepEqual(limitOptions({ maxSandboxes: 3 }, { maxUnity: 2, maxSandboxes: 1 }), { maxSandboxes: 3, maxAgentsPerSandbox: undefined, maxUnity: 2, diskWarnGB: undefined, diskCriticalGB: undefined, maxSandboxAgents: undefined }, 'unset ones are kept');
  assert.throws(() => limitOptions({ maxSandboxes: 0 }, undefined), /maxSandboxes must be a whole number from 1 to 8/);
  assert.throws(() => limitOptions({ diskWarnGB: 10, diskCriticalGB: 20 }, undefined), /disk_critical_gb must not be above disk_warn_gb/);

  assert.deepEqual(parseSandboxRef('lothdesktop/sb1'), { machine: 'lothdesktop', sandbox: 'sb1' });
  assert.deepEqual(parseSandboxRef('LothDesktop/SB 1'), { machine: 'lothdesktop', sandbox: 'sb-1' });
  assert.equal(parseSandboxRef('spec-098'), undefined);

  const unity = { state: 'stopped' as const };
  const prev = [{ id: 'a', branch: 'x', base: 'b', path: '/a', purpose: 'belts', status: 'ready' as const, createdAt: '', unity, sessionIds: ['s1'] }];
  const next = mergeSandboxes(prev, [
    { id: 'a', branch: 'y', base: 'b', path: '/a', status: 'ready', createdAt: '', unity },
    { id: 'b', branch: 'z', base: 'b', path: '/b', status: 'creating', createdAt: '', unity },
  ], new Map([['b', 'shaders']]));
  assert.deepEqual(next.map((s) => [s.id, s.branch, s.purpose, s.sessionIds]), [
    ['a', 'y', 'belts', ['s1']],
    ['b', 'z', 'shaders', []],
  ]);
  assert.deepEqual(mergeSandboxes(prev, []), [], 'gone on the machine, gone here');

  const m = { repoPath: 'D:\\work\\FFFRepo', home: 'C:\\Users\\l', platform: 'win32' as const, sandboxRoot: 'D:\\work\\ffsb' };
  assert.equal(machineForPath('D:/work/ffsb/sb1/Assets/Screenshots/a.png', [m]), m, "a sandbox's screenshot belongs to its machine");

  const cfg = JSON.parse(daemonConfig({ portalUrl: 'https://p', id: 'x', token: 't', repoPath: '/r', maxSessions: 3, sandboxes: poolSettingsOf({ sandboxRoot: '/s', maxSandboxes: 3 }) }));
  assert.deepEqual(cfg.sandboxes, { root: '/s', maxSandboxes: 3, maxAgentsPerSandbox: 2, maxUnity: 2, diskWarnGB: 50, diskCriticalGB: 20 }, 'daemon.json keeps them');
  assert.equal(JSON.parse(daemonConfig({ portalUrl: 'https://p', id: 'x', token: 't', repoPath: '/r', maxSessions: 3 })).sandboxes, undefined);
});

// ---------------------------------------------------------------- portal <-> daemon, end to end

class FakeAgent implements SessionHandle {
  info: SessionInfo;
  live = false;
  lastFrom: 'human' | 'orchestrator' | 'system' = 'human';
  private readonly sink: SessionSink;
  private readonly events: EventEmitter;
  constructor(info: SessionInfo, sink: SessionSink, _o: unknown, events: EventEmitter) {
    this.info = info;
    this.sink = sink;
    this.events = events;
  }
  send(text: string, from: 'human' | 'orchestrator' | 'system' = 'human', uuid = 'u', _images: ImageInput[] = []) {
    this.live = true;
    this.sink.append(this.info.id, { kind: 'user', text, from, uuid });
    this.info.status = 'idle';
    this.sink.putSession(this.info);
    this.events.emit('turnEnd', this, `echo ${text}`);
    return uuid;
  }
  async interrupt() {}
  async setMode(m: PermissionMode) {
    this.info.permissionMode = m;
  }
  stop() {
    if (!this.live) return;
    this.live = false;
    this.info.status = 'stopped';
    this.sink.putSession(this.info);
    this.events.emit('ended', this);
  }
  decide() {
    return false;
  }
}

const PROBES: Probes = {
  stats: async () => ({ hostname: 'pc', platform: 'win32', cpuModel: 'x', cpuCount: 1, loadPct: 0, memTotalBytes: GB, memFreeBytes: GB }),
  usage: async () => ({ account: {}, reply: { rate_limits_available: false } }),
};

test('machine sandboxes: create, run agents (per-sandbox limit), drive the editor and delete, from the portal through a daemon', async (t) => {
  const r = repos();
  const cfg = { dataDir: path.join(r.root, 'data'), limits: { maxSessions: 6 }, repo: { url: 'x' }, worker: { effort: 'high' }, defaultBase: 'origin/develop' } as unknown as Config;
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  const store = new Store(cfg.dataDir);
  const sessions = new SessionManager(cfg, store);
  const mm = new MachineManager(cfg, store, sessions);
  mm.hooks = {
    specFor: (info, m) => {
      const sb = info.machineSandbox ? mm.requireSandbox(m.id, info.machineSandbox) : undefined;
      return { cwd: sb?.path ?? r.main, sandbox: sb?.id, settingSources: [], append: '', strictMcp: true, guard: { id: sb?.id ?? 'x', ownPath: sb?.path ?? r.main, protectedPaths: [], gameRepos: [] } };
    },
    handlersFor: () => ({}),
  };
  const server = http.createServer();
  server.on('upgrade', (req, socket, head) => mm.upgrade(req, socket, head, '127.0.0.1'));
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const { token } = mm.register({ id: 'pc', host: 'pc', purpose: 'unused', status: 'ready', repoPath: r.main, home: r.root, portalUrl: url, maxSessions: 1, sandboxRoot: r.sbRoot, maxSandboxes: 2, maxAgentsPerSandbox: 1, maxUnity: 1 });
  const { d: poolDeps, running } = deps(r.main);
  const daemon = new Daemon({ portalUrl: url, id: 'pc', token, repoPath: r.main, appDir: path.join(r.root, 'app'), claude: 'no-such-claude', maxSessions: 1, maxEventsFile: null }, (i, s, o, e) => new FakeAgent(i, s, o, e), PROBES, poolDeps);
  t.after(async () => {
    daemon.shutdown();
    server.close();
    await new Promise((res) => setTimeout(res, 300));
    store.flush();
    r.cleanup();
  });
  daemon.start();
  await until('online with hello', () => mm.isOnline('pc') && !!store.machines.get('pc')?.info);

  const text = await mm.createSandbox('pc', { name: 'sb1', purpose: 'belt work', seedLibrary: true });
  assert.match(text, /Creating sandbox sb1 on branch sandbox\/sb1 from origin\/develop/);
  await until('ready on the portal', () => store.machines.get('pc')?.sandboxes?.find((s) => s.id === 'sb1')?.status === 'ready');
  const sb = mm.requireSandbox('pc', 'sb1');
  assert.equal(sb.purpose, 'belt work', 'the purpose given at creation is kept across snapshots');
  assert.equal(fs.existsSync(path.join(sb.path, 'Library', 'Artifacts', 'warm.bin')), true);
  await assert.rejects(mm.createSandbox('pc', { name: 'sb1' }), /already exists on pc/);

  // Agents: the sandbox has its own limit (1), apart from the main clone's.
  const a1 = mm.createSession('pc', { kind: 'worker', title: 'a1', permissionMode: 'default', sandbox: 'sb1' });
  assert.equal(a1.info.machineSandbox, 'sb1');
  assert.deepEqual(mm.requireSandbox('pc', 'sb1').sessionIds, [a1.info.id]);
  sessions.send(a1.info.id, 'hello');
  await until('a1 live', () => a1.live);
  const a2 = mm.createSession('pc', { kind: 'worker', title: 'a2', permissionMode: 'default', sandbox: 'sb1' });
  // The limit counts mid-turn agents only (w384): an idle a1 takes no slot; a1 mid-turn makes a2's message wait.
  await until('a1 idle', () => a1.info.status === 'idle');
  assert.equal(mm.placeFull(a2), undefined);
  a1.info.status = 'running';
  assert.match(mm.placeFull(a2) ?? '', /1 agents mid-turn in sandbox pc\/sb1 \(max_agents_per_sandbox 1\)/);
  assert.equal(sessions.isQueued(sessions.send(a2.info.id, 'x')), true, 'queued, not refused');
  a1.info.status = 'idle';
  sessions.drain();
  await until('a2 delivered once a1 is idle', () => a2.live && !sessions.queued().length);
  const main = mm.createSession('pc', { kind: 'worker', title: 'main', permissionMode: 'default' });
  sessions.send(main.info.id, 'main clone work');
  await until('main-clone agent live beside it', () => main.live);

  // The sandbox's editor, not the main clone's.
  assert.match(await mm.unity('pc', 'start', false, 'sb1'), /Started \(fake\)/);
  assert.deepEqual([...running], [sb.path]);
  await until('the snapshot shows it', () => mm.requireSandbox('pc', 'sb1').unity.state !== 'stopped');
  await assert.rejects(mm.switchBranch('pc', 'feature/z', undefined, 'sb1'), /is running: stop it first/);
  await mm.unity('pc', 'stop', false, 'sb1');
  const sw = await mm.switchBranch('pc', 'feature/z', undefined, 'sb1');
  assert.equal(sw.to, 'feature/z');
  assert.equal(r.git(r.main, 'branch', '--show-current'), 'develop', 'the main clone stays where it was');

  // Delete: refused while an agent there runs; then gone on both sides.
  await assert.rejects(mm.deleteSandbox('pc', 'sb1'), /2 agent\(s\) still run in sandbox sb1/);
  a1.stop();
  a2.stop();
  await until('a1 and a2 stopped', () => !a1.live && !a2.live);
  assert.match(await mm.deleteSandbox('pc', 'sb1'), /Deleted sandbox sb1/);
  assert.deepEqual(store.machines.get('pc')!.sandboxes, []);
  assert.equal(fs.existsSync(sb.path), false);
});
