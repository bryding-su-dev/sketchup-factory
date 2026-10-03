// The portal's own host as a machine (docs/beast-machine.md): the pool adopting and releasing existing worktrees, the
// migration of this host's sandboxes to its daemon and back (records, then live through a real daemon), the account
// rules, the local deploy, the fleet view, the guard and the reaper.
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
import { MachineManager, RemoteSession, localMachineDefaults, poolSettingsOf } from './machines.ts';
import { PROTOCOL_VERSION } from './machineProtocol.ts';
import { daemonConfig, type DeployOptions } from './machineDeploy.ts';
import { LOCAL, installScript, scriptCommand } from './machineDeployWin.ts';
import { Daemon, type Probes } from '../machine/daemon.ts';
import { SandboxPool, librarySource, samePath, totalAgentsRefusal, type PoolDeps, type SandboxEditor } from '../machine/sandboxes.ts';
import { HostMigrator, backProblems, hostSandboxFrom, machineSandboxFrom, moveStateToHost, moveStateToMachine, samePlace, toMachineProblems, type StateFile } from './hostMigration.ts';
import { accountSource, hostClaudeEnvFor, machineUsesLogin, usesHostClaudeEnv } from './secrets.ts';
import { sandboxGuard } from './guard.ts';
import { isProtected } from './reaper.ts';
import { fleetOf } from '../shared/fleet.ts';
import { copyTree, removeTree, run } from './proc.ts';
import { readGitStatus } from './gitStatus.ts';
import { daemonRowsAfter, main as offlineMain, parseArgs, runningDaemons } from '../scripts/host-migration.ts';
import type { Config } from './config.ts';
import type { ImageInput, Machine, PermissionMode, Sandbox, SandboxPoolSettings, SessionInfo, SystemStats } from '../shared/types.ts';

const GB = 1024 ** 3;
const T = '2026-09-29T10:00:00.000Z';

const until = async (what: string, cond: () => boolean, ms = 60_000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
};

/** A bare origin, the base clone, and two worktrees made the way this host's own pool made them (git worktree add). */
function hostRepos() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-beast-'));
  const origin = path.join(root, 'origin.git');
  const base = path.join(root, '_base');
  const git = (dir: string, ...a: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { stdio: 'pipe' }).toString().trim();
  execFileSync('git', ['init', '-q', '--bare', '-b', 'develop', origin]);
  execFileSync('git', ['clone', '-q', origin, base], { stdio: 'pipe' });
  git(base, 'switch', '-q', '-c', 'develop');
  fs.writeFileSync(path.join(base, '.gitignore'), 'Library/\nLogs/\nTemp/\n');
  fs.writeFileSync(path.join(base, 'README.md'), 'game\n');
  git(base, 'add', '.gitignore', 'README.md');
  git(base, 'commit', '-q', '-m', 'base');
  git(base, 'push', '-q', '-u', 'origin', 'develop');
  const sbRoot = path.join(root, 'ffsb');
  fs.mkdirSync(sbRoot);
  const worktree = (id: string, branch: string) => {
    git(base, 'worktree', 'add', '-q', '-b', branch, path.join(sbRoot, id), 'develop');
    fs.mkdirSync(path.join(sbRoot, id, 'Library'), { recursive: true });
    fs.writeFileSync(path.join(sbRoot, id, 'Library', 'warm.bin'), `library of ${id}`);
    fs.writeFileSync(path.join(sbRoot, id, 'work.txt'), `uncommitted work in ${id}`);
  };
  worktree('mp-r2', 'e2e-r2-matrix');
  worktree('slot-5', 'e2e-r2-chaos');
  return { root, origin, base, sbRoot, git, cleanup: () => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }) };
}

function poolDeps(repoPath: string, o: { copies?: { src: string; mode?: string }[]; lowered?: number[]; pids?: Map<string, number> } = {}) {
  const running = new Set<string>();
  const d: PoolDeps = {
    git: (args, opts = {}) => run('git', ['-C', repoPath, ...args], { timeoutMs: opts.timeoutMs ?? 120_000, signal: opts.signal, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }),
    copyTree: async (src, dst, signal, mode) => {
      o.copies?.push({ src, mode });
      await copyTree(src, dst, { signal });
    },
    removeTree,
    freeBytes: async () => 500 * GB,
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
        status: async () => (running.has(sb.path) ? 'running' : 'not running'),
        editors: () => {
          const pid = o.pids?.get(sb.path) ?? (running.has(sb.path) ? 4242 : undefined);
          return pid ? [{ pid, ppid: 1, cmd: `Unity -projectPath ${sb.path}` }] : [];
        },
      },
    }),
    bridgeUp: (p) => running.has(p) || !!o.pids?.has(p),
    gitStatus: readGitStatus,
    now: () => Date.now(),
    lowerPriority: (pid) => o.lowered?.push(pid),
  };
  return { d, running };
}

const SETTINGS = (root: string, over: Partial<SandboxPoolSettings> = {}): SandboxPoolSettings => ({ root, maxSandboxes: 5, maxAgentsPerSandbox: 6, maxUnity: 4, diskWarnGB: 50, diskCriticalGB: 20, ...over });

// ---------------------------------------------------------------- the pool: adopt and release (real git; CI runs Windows too)

test('beast machine: the pool adopts worktrees as they are and releases them without touching anything', async (t) => {
  const r = hostRepos();
  t.after(r.cleanup);
  const lowered: number[] = [];
  const pids = new Map([[path.join(r.sbRoot, 'mp-r2'), 777]]);
  const { d } = poolDeps(r.base, { lowered, pids });
  const stateFile = path.join(r.root, 'app', 'sandboxes.json');
  const make = () => new SandboxPool({ repoPath: r.base, stateFile, settings: SETTINGS(r.sbRoot, { maxSandboxes: 2, belowNormal: true }), activity: () => ({ busy: false, lastActivityMs: Date.now() }), onChange: () => undefined, onEvent: () => undefined }, d);
  const p = make();
  const dir = path.join(r.sbRoot, 'mp-r2');
  const text = await p.adopt({ id: 'mp-r2', path: dir, branch: 'stale-name', base: 'origin/develop', createdAt: T, logPath: path.join(dir, 'Logs', 'sandbox-editor.log') });
  assert.match(text, /Adopted sandbox mp-r2 .*branch e2e-r2-matrix/, 'the branch checked out now, not the one on the old record');
  const sb = p.list()[0];
  assert.deepEqual([sb.id, sb.status, sb.branch, sb.createdAt, sb.unity.logPath], ['mp-r2', 'ready', 'e2e-r2-matrix', T, path.join(dir, 'Logs', 'sandbox-editor.log')]);
  await until('the running editor found and lowered', () => p.list()[0].unity.pid === 777);
  assert.deepEqual(lowered, [777], 'an adopted editor gets below-normal priority once');
  await p.tick();
  assert.deepEqual(lowered, [777], 'not again for the same pid');
  assert.equal(fs.readFileSync(path.join(dir, 'work.txt'), 'utf8'), 'uncommitted work in mp-r2', 'uncommitted work untouched');
  assert.equal(fs.readFileSync(path.join(dir, 'Library', 'warm.bin'), 'utf8'), 'library of mp-r2', 'Library untouched');
  assert.deepEqual(make().list().map((s) => s.id), ['mp-r2'], 'kept in sandboxes.json across a daemon restart');

  await assert.rejects(p.adopt({ id: 'mp-r2', path: dir, branch: 'x', base: 'b', createdAt: T }), /already exists/);
  const stray = path.join(r.sbRoot, 'stray');
  fs.mkdirSync(stray);
  await assert.rejects(p.adopt({ id: 'stray', path: stray, branch: 'x', base: 'b', createdAt: T }), /not a git worktree/);
  await assert.rejects(p.adopt({ id: 'slot-5', path: path.join(r.root, 'slot-5'), branch: 'x', base: 'b', createdAt: T }), /directly in the sandbox root/);
  await assert.rejects(p.adopt({ id: 'wrong', path: path.join(r.sbRoot, 'slot-5'), branch: 'x', base: 'b', createdAt: T }), /not a folder named wrong/);
  // A worktree of another repository is not this machine's.
  const other = path.join(r.root, 'other');
  execFileSync('git', ['init', '-q', '-b', 'main', other]);
  execFileSync('git', ['-C', other, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'x']);
  execFileSync('git', ['-C', other, 'worktree', 'add', '-q', '-b', 'o', path.join(r.sbRoot, 'foreign')]);
  await assert.rejects(p.adopt({ id: 'foreign', path: path.join(r.sbRoot, 'foreign'), branch: 'o', base: 'b', createdAt: T }), /not of this machine's main clone/);
  await p.adopt({ id: 'slot-5', path: path.join(r.sbRoot, 'slot-5'), branch: 'e2e-r2-chaos', base: 'origin/develop', createdAt: T });
  await assert.rejects(p.adopt({ id: 'another', path: path.join(r.sbRoot, 'another'), branch: 'x', base: 'b', createdAt: T }), /max_sandboxes 2/);

  assert.match(p.release('mp-r2'), /Released sandbox mp-r2/);
  assert.deepEqual(p.list().map((s) => s.id), ['slot-5']);
  assert.equal(fs.existsSync(path.join(dir, 'Library', 'warm.bin')), true, 'released: folder and Library stay');
  assert.match(r.git(r.base, 'worktree', 'list'), /mp-r2/, 'still a worktree of the base clone');
  assert.throws(() => p.release('mp-r2'), /no sandbox "mp-r2"/);
});

test('beast machine: the Library seed comes first and is block-cloned; a protected folder name is refused; the total agent cap', async (t) => {
  const r = hostRepos();
  t.after(r.cleanup);
  const seed = path.join(r.root, '_seed', 'Library');
  fs.mkdirSync(seed, { recursive: true });
  fs.writeFileSync(path.join(seed, 'seed.bin'), 'the warm seed');
  const copies: { src: string; mode?: string }[] = [];
  const { d } = poolDeps(r.base, { copies });
  const p = new SandboxPool(
    {
      repoPath: r.base,
      stateFile: path.join(r.root, 'app', 'sandboxes.json'),
      settings: SETTINGS(r.sbRoot, { librarySeed: seed, librarySeedCopy: 'clone', librarySeedGB: 1, protectedPaths: [path.join(r.root, 'FinalFactory')] }),
      activity: () => ({ busy: false, lastActivityMs: Date.now() }),
      onChange: () => undefined,
      onEvent: () => undefined,
    },
    d,
  );
  await p.create({ id: 'fresh', branch: 'sandbox/fresh', base: 'origin/develop', seedLibrary: true, startUnity: false });
  await until('ready', () => {
    const s = p.list().find((x) => x.id === 'fresh');
    if (s?.status === 'error') throw new Error(s.statusDetail);
    return s?.status === 'ready';
  });
  assert.deepEqual(copies, [{ src: seed, mode: 'clone' }], 'the seed, by block clone');
  assert.equal(fs.readFileSync(path.join(r.sbRoot, 'fresh', 'Library', 'seed.bin'), 'utf8'), 'the warm seed');
  await assert.rejects(p.create({ id: 'finalfactory', branch: 'sandbox/x', base: 'origin/develop', seedLibrary: false, startUnity: false }), /protected checkout/);

  assert.equal(librarySource(r.base, [], () => false, path.join(r.root, 'empty-seed')), undefined, 'an empty or missing seed is skipped');
  assert.equal(librarySource(r.base, [{ path: path.join(r.sbRoot, 'mp-r2'), status: 'ready', editorUp: false }], (dir) => fs.existsSync(path.join(dir, 'Library')), path.join(r.root, 'nope')), path.join(r.sbRoot, 'mp-r2', 'Library'));
  assert.equal(totalAgentsRefusal(5, { maxAgents: 6 }), undefined);
  assert.match(totalAgentsRefusal(6, { maxAgents: 6 })!, /already 6 agents running in this machine's sandboxes \(max_sandbox_agents 6\)/);
  assert.equal(totalAgentsRefusal(60, {}), undefined, 'no total set: none');
  assert.equal(samePath('C:\\ffsb\\_base\\.git', 'c:/ffsb/_base/.git/', 'win32'), true);
  assert.equal(samePath('/a/b', '/a/B', 'darwin'), false);
});

// ---------------------------------------------------------------- the record moves (pure)

const hostSb = (id: string, over: Partial<Sandbox> = {}): Sandbox => ({
  id,
  name: id,
  branch: `sandbox/${id}`,
  base: 'origin/develop',
  path: `F:\\ffsb\\${id}`,
  purpose: `work in ${id}`,
  status: 'ready',
  createdAt: T,
  unity: { state: 'running', pid: 41592, logPath: `F:\\ffsb\\${id}\\Logs\\sandbox-editor.log` },
  sessionIds: [`${id}-a`, `${id}-b`],
  git: { branch: 'e2e-r2-invariants-catchup', dirty: 0, untracked: 0, at: T },
  ...over,
});

const info = (id: string, where: Partial<SessionInfo> = {}): SessionInfo => ({
  id,
  kind: 'worker',
  title: id,
  status: 'stopped',
  permissionMode: 'bypassPermissions',
  createdAt: T,
  lastActivityAt: T,
  turns: 3,
  costUsd: 1,
  pendingPermissions: [],
  sdkSessionId: `sdk-${id}`,
  account: 'host:login',
  ...where,
});

const beastMachine = (over: Partial<Machine> = {}): Machine => ({
  id: 'beast',
  local: true,
  host: 'localhost',
  purpose: 'unused',
  status: 'ready',
  online: true,
  repoPath: 'C:\\ffsb\\_base',
  home: 'C:\\Users\\rydin',
  portalUrl: 'http://127.0.0.1:8790',
  maxSessions: 3,
  sessionIds: [],
  createdAt: T,
  platform: 'win32',
  sandboxRoot: 'F:\\ffsb',
  maxSandboxes: 5,
  ...over,
});

test('beast machine: records move to the machine and back unchanged (labels, agents, session ids, delegations)', () => {
  const state: StateFile = {
    sandboxes: [hostSb('shader-blackhole'), hostSb('slot-5', { unity: { state: 'stopped' } })],
    sessions: [info('shader-blackhole-a', { sandboxId: 'shader-blackhole' }), info('shader-blackhole-b', { sandboxId: 'shader-blackhole' }), info('slot-5-a', { sandboxId: 'slot-5' }), info('slot-5-b', { sandboxId: 'slot-5' }), info('m5-x', { machineId: 'm5' })],
    machines: [beastMachine()],
    delegations: [{ id: 'd1', agentId: 'sentry', agentName: 'Sentry', title: 't', task: 'x', createdAt: T, status: 'approved', sandboxId: 'slot-5', sessionId: 'slot-5-a' }],
    orchestratorId: 'o1',
  };
  const before = JSON.parse(JSON.stringify(state));
  const r = moveStateToMachine(state, 'beast');
  assert.deepEqual(r, { sandboxes: ['shader-blackhole', 'slot-5'], sessions: ['shader-blackhole-a', 'shader-blackhole-b', 'slot-5-a', 'slot-5-b'], delegations: ['d1'] });
  assert.deepEqual(state.sandboxes, [], 'the host has none left');
  const m = state.machines![0];
  assert.deepEqual(m.sandboxes!.map((s) => [s.id, s.purpose, s.branch, s.path, s.sessionIds.join(), s.unity.state, s.unity.pid]), [
    ['shader-blackhole', 'work in shader-blackhole', 'e2e-r2-invariants-catchup', 'F:\\ffsb\\shader-blackhole', 'shader-blackhole-a,shader-blackhole-b', 'running', 41592],
    ['slot-5', 'work in slot-5', 'e2e-r2-invariants-catchup', 'F:\\ffsb\\slot-5', 'slot-5-a,slot-5-b', 'stopped', undefined],
  ]);
  assert.deepEqual(m.sessionIds, ['shader-blackhole-a', 'shader-blackhole-b', 'slot-5-a', 'slot-5-b']);
  const moved = state.sessions.find((s) => s.id === 'slot-5-a')!;
  assert.deepEqual([moved.sandboxId, moved.machineId, moved.machineSandbox, moved.sdkSessionId], [undefined, 'beast', 'slot-5', 'sdk-slot-5-a'], 'the resume id stays');
  assert.equal(state.sessions.find((s) => s.id === 'm5-x')!.machineId, 'm5', "another machine's session is untouched");
  assert.equal(state.delegations![0].sandboxId, 'beast/slot-5');
  assert.throws(() => moveStateToMachine({ ...state, sandboxes: [hostSb('slot-5')] }, 'beast'), /already has a sandbox "slot-5"/);

  const back = moveStateToHost(state, 'beast');
  assert.deepEqual(back.sandboxes, ['shader-blackhole', 'slot-5']);
  assert.deepEqual(state.machines![0].sandboxes, []);
  assert.deepEqual(state.machines![0].sessionIds, []);
  assert.deepEqual(
    state.sessions.map((s) => [s.id, s.sandboxId, s.machineId, s.machineSandbox]),
    before.sessions.map((s: SessionInfo) => [s.id, s.sandboxId, s.machineId, s.machineSandbox]),
    'every session back where it was',
  );
  assert.equal(state.delegations![0].sandboxId, 'slot-5');
  assert.deepEqual(
    (state.sandboxes as Sandbox[]).map((s) => [s.id, s.path, s.purpose, s.sessionIds.join(), s.unity.state, s.unity.logPath]),
    before.sandboxes.map((s: Sandbox) => [s.id, s.path, s.purpose, s.sessionIds.join(), s.unity.state, s.unity.logPath]),
  );
  assert.throws(() => moveStateToMachine(state, 'nope'), /no machine "nope"/);

  // The round trip of one record: an editor shown blocked on the host is running as far as the daemon knows.
  assert.equal(machineSandboxFrom(hostSb('x', { unity: { state: 'blocked', pid: 5 } })).unity.state, 'running');
  assert.equal(hostSandboxFrom(machineSandboxFrom(hostSb('x', { unity: { state: 'crashed' } }))).unity.state, 'crashed');
  assert.equal(hostSandboxFrom(machineSandboxFrom(hostSb('x')), 'beast/x').id, 'beast/x');
  assert.equal(samePlace('F:/ffsb', 'f:\\FFSB\\'), true);
  assert.equal(samePlace('F:/ffsb', 'F:/ffsb2'), false);
});

test('beast machine: what stands in the way of a migration, both ways', () => {
  const cfg = { sandboxRoot: 'F:\\ffsb', repo: { basePath: 'C:\\ffsb\\_base' } } as Config;
  const sessions = new Map([
    ['a', info('a', { sandboxId: 'x', status: 'running' })],
    ['b', info('b', { sandboxId: 'y', pendingPermissions: [{ requestId: 'r', toolName: 'Bash', input: {}, createdAt: T }] })],
  ]);
  const ok = { sessions: new Map<string, SessionInfo>(), busy: () => false, online: true, protocol: 6, outdated: undefined, cfg };
  assert.deepEqual(toMachineProblems({ ...ok, host: [hostSb('x', { sessionIds: [] })], machine: beastMachine() }), []);
  assert.match(toMachineProblems({ ...ok, host: [], machine: undefined })[0], /add_machine with local: true/);
  const bad = toMachineProblems({
    host: [hostSb('x', { sessionIds: ['a'] }), hostSb('y', { sessionIds: ['b'], status: 'error', statusDetail: 'interrupted' }), hostSb('dup', { sessionIds: [] })],
    sessions,
    busy: () => false,
    machine: beastMachine({ sandboxRoot: 'D:\\other', repoPath: 'C:\\elsewhere', sandboxes: [machineSandboxFrom(hostSb('dup'))], maxSandboxes: 3 }),
    online: true,
    protocol: 5,
    outdated: undefined,
    cfg,
  }).join('\n');
  for (const re of [/protocol 5; it needs 6/, /sandbox_root D:\\other is not this host's sandboxRoot/, /main clone C:\\elsewhere is not this host's base clone/, /agent a in x is mid-turn/, /agent b in y waits on a permission answer/, /sandbox y is error \(interrupted\)/, /beast already has a sandbox "dup"/, /may hold 3 sandboxes/]) assert.match(bad, re);
  assert.match(toMachineProblems({ ...ok, host: [hostSb('x', { sessionIds: [] })], machine: beastMachine(), online: false })[0], /not connected/);
  assert.match(toMachineProblems({ ...ok, host: [hostSb('x', { sessionIds: [] })], machine: beastMachine(), outdated: 'it runs abc' })[0], /outdated/);

  const m = beastMachine({ sandboxes: [machineSandboxFrom(hostSb('x', { sessionIds: ['a'] }))] });
  assert.deepEqual(backProblems({ machine: m, online: true, protocol: 6, hostIds: new Set(), sessions, live: () => false }), []);
  const b = backProblems({ machine: m, online: false, protocol: undefined, hostIds: new Set(['x']), sessions, live: (id) => id === 'a' }).join('\n');
  for (const re of [/offline|not connected/, /already has a sandbox "x"/, /agent a in beast\/x still has a process/]) assert.match(b, re);
});

// ---------------------------------------------------------------- the live migration, through a real daemon

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
    this.sink.putSession?.(this.info);
    this.events?.emit('ended', this);
  }
  decide() {
    return false;
  }
}

const PROBES: Probes = {
  stats: async () => ({ hostname: 'BEAST', platform: 'win32', cpuCount: 1, cpuModel: 'x', loadPct: 0, memTotalBytes: GB, memFreeBytes: GB }),
  usage: async () => ({ account: {}, reply: { rate_limits_available: false } }),
};

test('beast machine: migrate_host_sandboxes moves live records to the daemon and back, with nothing on disk touched', async (t) => {
  const r = hostRepos();
  const cfg = { dataDir: path.join(r.root, 'data'), sandboxRoot: r.sbRoot, limits: { maxSessions: 6 }, repo: { url: 'x', basePath: r.base }, worker: { effort: 'high' }, defaultBase: 'origin/develop' } as unknown as Config;
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  const store = new Store(cfg.dataDir);
  // This host's records, as they are before the migration: two sandboxes, three worker records, one idle process.
  for (const id of ['mp-r2', 'slot-5']) {
    store.putSandbox({ ...hostSb(id), path: path.join(r.sbRoot, id), branch: id === 'mp-r2' ? 'e2e-r2-matrix' : 'e2e-r2-chaos', git: undefined, unity: { state: 'stopped', logPath: path.join(r.sbRoot, id, 'Logs', 'sandbox-editor.log') }, sessionIds: id === 'mp-r2' ? ['w1', 'w2'] : ['w3'] });
  }
  store.putSession(info('w1', { sandboxId: 'mp-r2' }));
  store.putSession(info('w2', { sandboxId: 'mp-r2', status: 'idle' }));
  store.putSession(info('w3', { sandboxId: 'slot-5' }));
  const sessions = new SessionManager(cfg, store);
  const hostHandles = new Map<string, FakeAgent>();
  const hostSession = (i: SessionInfo) => {
    const h = new FakeAgent(i, store as unknown as SessionSink, undefined, sessions.events);
    hostHandles.set(i.id, h);
    return h;
  };
  for (const id of ['w1', 'w2', 'w3']) sessions.sessions.set(id, hostSession(store.sessions.get(id)!));
  hostHandles.get('w2')!.live = true; // an idle agent keeps its process

  const mm = new MachineManager(cfg, store, sessions);
  mm.hooks = {
    specFor: (i, m) => {
      const sb = mm.requireSandbox(m.id, i.machineSandbox!);
      return { cwd: sb.path, sandbox: sb.id, settingSources: [], append: '', strictMcp: true, guard: { id: sb.id, ownPath: sb.path, protectedPaths: [], gameRepos: [] } };
    },
    handlersFor: () => ({}),
  };
  const server = http.createServer();
  server.on('upgrade', (req, socket, head) => mm.upgrade(req, socket, head, '127.0.0.1'));
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const { token } = mm.register({ ...beastMachine({ repoPath: r.base, sandboxRoot: r.sbRoot, portalUrl: url, home: r.root, platform: undefined }), sessionIds: [] });
  const { d } = poolDeps(r.base);
  const daemon = new Daemon({ portalUrl: url, id: 'beast', token, repoPath: r.base, appDir: path.join(r.root, 'app'), claude: 'no-such-claude', maxSessions: 3, maxEventsFile: null }, (i, s, o, e) => new FakeAgent(i, s, o, e), PROBES, d);
  t.after(async () => {
    daemon.shutdown();
    server.close();
    await new Promise((res) => setTimeout(res, 300));
    store.flush();
    r.cleanup();
  });
  daemon.start();
  await until('the daemon online', () => mm.isOnline('beast') && mm.protocolOf('beast') === PROTOCOL_VERSION);

  const migrator = new HostMigrator({ cfg, store, sessions, machines: mm, hostSession, stopWaitMs: 2000 });
  // A worker mid-turn holds everything up.
  store.sessions.get('w3')!.status = 'running';
  await assert.rejects(migrator.toMachine(), /agent w3 in slot-5 is mid-turn/);
  store.sessions.get('w3')!.status = 'stopped';

  assert.match(await migrator.toMachine(true), /Would move 2 sandbox\(es\) to beast: mp-r2 .*stop the idle agent processes of w2/);
  assert.equal(store.sandboxes.size, 2, 'a dry run moves nothing');

  // A wake starts w3 here while slot-5 is being adopted: slot-5 stays this host's, and the daemon gives it back.
  const racing = new HostMigrator({
    cfg,
    store,
    sessions,
    hostSession,
    stopWaitMs: 2000,
    machines: {
      local: () => mm.local(),
      isOnline: (id) => mm.isOnline(id),
      protocolOf: (id) => mm.protocolOf(id),
      outdated: (id) => mm.outdated(id),
      restore: (i) => mm.restore(i),
      releaseSandbox: (id, sb) => mm.releaseSandbox(id, sb),
      adoptSandbox: async (id, req) => {
        const text = await mm.adoptSandbox(id, req);
        if (req.id === 'slot-5') hostHandles.get('w3')!.live = true;
        return text;
      },
    },
  });
  const first = await racing.toMachine();
  assert.match(first, /Moved 1 sandbox\(es\) to beast: beast\/mp-r2 \(bare names keep working\)\. 2 agent record\(s\) moved/);
  assert.match(first, /Stopped the idle agent processes of w2 first/);
  assert.match(first, /NOT moved \(still this host's\): slot-5: agent\(s\) w3 started while it was being moved, so it stays here; beast had taken it and gave it back/);
  assert.equal(hostHandles.get('w2')!.live, false);
  await until('the daemon gave slot-5 back', () => daemon.pool.list().map((x) => x.id).join() === 'mp-r2');
  assert.deepEqual([...store.sandboxes.keys()], ['slot-5']);
  assert.equal(sessions.sessions.get('w3'), hostHandles.get('w3'), 'w3 still runs here');
  assert.deepEqual(store.machines.get('beast')!.sandboxes!.map((x) => x.id), ['mp-r2']);
  hostHandles.get('w3')!.live = false;

  const text = await migrator.toMachine();
  assert.match(text, /Moved 1 sandbox\(es\) to beast: beast\/slot-5 \(bare names keep working\)\. 1 agent record\(s\) moved/);
  assert.equal(store.sandboxes.size, 0, 'no host sandboxes left');
  const m = store.machines.get('beast')!;
  assert.deepEqual(m.sandboxes!.map((s) => [s.id, s.purpose, s.sessionIds.join(), s.branch]), [
    ['mp-r2', 'work in mp-r2', 'w1,w2', 'e2e-r2-matrix'],
    ['slot-5', 'work in slot-5', 'w3', 'e2e-r2-chaos'],
  ]);
  assert.deepEqual(m.sessionIds, ['w1', 'w2', 'w3']);
  assert.deepEqual(daemon.pool.list().map((s) => s.id), ['mp-r2', 'slot-5'], "the daemon's pool has them");
  assert.ok(sessions.sessions.get('w1') instanceof RemoteSession, 'the handle runs on the daemon now');
  assert.deepEqual([store.sessions.get('w1')!.machineSandbox, store.sessions.get('w1')!.sandboxId, store.sessions.get('w1')!.sdkSessionId], ['mp-r2', undefined, 'sdk-w1']);
  assert.equal(fs.readFileSync(path.join(r.sbRoot, 'mp-r2', 'work.txt'), 'utf8'), 'uncommitted work in mp-r2');
  const rec = migrator.last()!;
  assert.deepEqual([rec.direction, rec.machine, rec.sandboxes.join()], ['to_machine', 'beast', 'slot-5']);
  assert.ok(fs.existsSync(rec.backup!), 'a copy of state.json from before');
  assert.equal(JSON.parse(fs.readFileSync(rec.backup!, 'utf8')).sandboxes.length, 1);

  // A message to a moved worker starts it on the daemon, with its history.
  sessions.send('w1', 'carry on');
  await until('w1 live on the daemon', () => sessions.sessions.get('w1')!.live);
  await assert.rejects(migrator.back(), /agent w1 in beast\/mp-r2 still has a process/);
  sessions.sessions.get('w1')!.stop();
  await until('w1 stopped', () => !sessions.sessions.get('w1')!.live);

  assert.match(await migrator.back(true), /Would move 2 sandbox\(es\) back from beast/);
  const backText = await migrator.back();
  assert.match(backText, /Moved 2 sandbox\(es\) back from beast to this host: mp-r2, slot-5, with 3 agent record\(s\)/);
  assert.deepEqual([...store.sandboxes.keys()].sort(), ['mp-r2', 'slot-5']);
  assert.deepEqual(store.sandboxes.get('mp-r2')!.sessionIds, ['w1', 'w2']);
  assert.equal(store.sandboxes.get('mp-r2')!.purpose, 'work in mp-r2');
  assert.deepEqual([store.sessions.get('w3')!.sandboxId, store.sessions.get('w3')!.machineId], ['slot-5', undefined]);
  assert.ok(hostHandles.get('w3') === sessions.sessions.get('w3'), 'a host handle again');
  assert.deepEqual(store.machines.get('beast')!.sandboxes, []);
  assert.deepEqual(store.machines.get('beast')!.sessionIds, []);
  await until("the daemon's pool is empty", () => daemon.pool.list().length === 0);
  assert.match(r.git(r.base, 'worktree', 'list'), /mp-r2[\s\S]*slot-5/, 'both still worktrees of the base clone');
  assert.equal(fs.readFileSync(path.join(r.sbRoot, 'slot-5', 'Library', 'warm.bin'), 'utf8'), 'library of slot-5');
});

// ---------------------------------------------------------------- the offline script

test('beast machine: the offline script moves state.json and the daemon file, and refuses while the portal runs', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-offline-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const data = path.join(dir, 'data');
  const daemonDir = path.join(dir, 'daemon');
  fs.mkdirSync(data);
  const state: StateFile = { sandboxes: [], sessions: [info('w1', { machineId: 'beast', machineSandbox: 'mp-r2' })], machines: [beastMachine({ sandboxes: [machineSandboxFrom(hostSb('mp-r2', { sessionIds: ['w1'] }))], sessionIds: ['w1'] })] };
  fs.writeFileSync(path.join(data, 'state.json'), JSON.stringify(state));
  fs.mkdirSync(daemonDir);
  fs.writeFileSync(path.join(daemonDir, 'sandboxes.json'), JSON.stringify([{ id: 'mp-r2', path: 'F:\\ffsb\\mp-r2' }, { id: 'keep', path: 'F:\\ffsb\\keep' }]));
  assert.equal(typeof parseArgs(['sideways']), 'string');
  assert.deepEqual(parseArgs(['back', '--data', data, '--machine', 'BEAST', '--dry-run']), { direction: 'back', data, machine: 'beast', daemonDir: undefined, dryRun: true });

  const lines: string[] = [];
  fs.writeFileSync(path.join(data, 'server.pid'), String(process.pid));
  assert.equal(offlineMain(['back', '--data', data, '--machine', 'beast'], (l) => lines.push(l), () => []), 1);
  assert.match(lines.join('\n'), /the portal still runs/);
  fs.rmSync(path.join(data, 'server.pid'));

  assert.equal(offlineMain(['back', '--data', data, '--machine', 'beast', '--daemon-dir', daemonDir], (l) => lines.push(l), () => [4242]), 1);
  assert.match(lines.join('\n'), /a machine daemon still runs here \(pid 4242\)/);
  assert.deepEqual(runningDaemons(() => '  12 "node.exe" C:\\Users\\r\\.ff-factory\\app\\machine\\daemon.ts x.json\n  13 node server/index.ts\n'), [12]);
  assert.equal(offlineMain(['back', '--data', data, '--machine', 'beast', '--daemon-dir', daemonDir], (l) => lines.push(l), () => []), 0);
  const after = JSON.parse(fs.readFileSync(path.join(data, 'state.json'), 'utf8')) as StateFile;
  assert.deepEqual(after.sandboxes.map((s) => [s.id, s.sessionIds.join()]), [['mp-r2', 'w1']]);
  assert.equal(after.sessions[0].sandboxId, 'mp-r2');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(daemonDir, 'sandboxes.json'), 'utf8')).map((x: { id: string }) => x.id), ['keep']);
  assert.ok(fs.readdirSync(data).some((f) => f.startsWith('state.pre-host-migration-offline-')), 'state.json copied first');

  // And forward again: the daemon file gains the rows its pool loads.
  assert.equal(offlineMain(['to_machine', '--data', data, '--machine', 'beast', '--daemon-dir', daemonDir], () => undefined, () => []), 0);
  const rows = JSON.parse(fs.readFileSync(path.join(daemonDir, 'sandboxes.json'), 'utf8'));
  assert.deepEqual(rows.map((x: { id: string; status?: string }) => [x.id, x.status ?? '']), [['keep', ''], ['mp-r2', 'ready']]);
  assert.deepEqual(daemonRowsAfter([{ id: 'a' }], { sandboxes: [], sessions: [], machines: [] }, { direction: 'back', machine: 'beast' }, ['a']), []);
});

// ---------------------------------------------------------------- accounts, deploy, settings

test("beast machine: its agents keep the host workers' account (claudeAccounts.workers), unless the machine is named", () => {
  const token = 'sk-ant-oat01-' + 'x'.repeat(40) + 'WXYZ';
  const cfg = { claudeEnv: { CLAUDE_CODE_OAUTH_TOKEN: token, CLAUDE_CONFIG_DIR: 'C:\\claude-cfg' }, claudeAccounts: { workers: 'login' as const }, machines: { useHostClaudeEnv: { '*': true, lothdesktop: false } } };
  const beast = { id: 'beast', local: true };
  assert.equal(usesHostClaudeEnv(cfg, beast), false, 'workers on the login: so are the daemon\'s');
  assert.deepEqual(hostClaudeEnvFor(cfg, beast), { CLAUDE_CONFIG_DIR: 'C:\\claude-cfg' }, 'no credential, but the config dir stays (resumed sessions find their history)');
  assert.equal(machineUsesLogin(cfg, beast), true);
  assert.match(accountSource(cfg, beast), /login \(this host's stored Claude login/);
  assert.equal(usesHostClaudeEnv({ ...cfg, claudeAccounts: { workers: 'token' } }, beast), true, 'workers on the token: so are they');
  assert.match(accountSource({ ...cfg, claudeAccounts: { workers: 'token' } }, beast), /host token …WXYZ/);
  assert.equal(usesHostClaudeEnv({ ...cfg, machines: { useHostClaudeEnv: { beast: true } } }, beast), true, 'an entry naming it wins');
  assert.equal(usesHostClaudeEnv(cfg, 'beast'), true, 'not known to be local: the "*" rule');
  assert.equal(usesHostClaudeEnv(cfg, 'lothdesktop'), false);
  assert.deepEqual(hostClaudeEnvFor(cfg, 'lothdesktop'), {}, 'a Mac or PC on its own login gets nothing');
});

test('beast machine: add_machine local takes its settings from the config, deploys without ssh, and is the only one', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-local-'));
  let store: Store | undefined;
  t.after(() => {
    store?.flush();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const cfg = {
    dataDir: dir,
    port: 8790,
    sandboxRoot: 'F:\\ffsb',
    repo: { url: 'https://github.com/o/g.git', basePath: 'C:\\ffsb\\_base' },
    limits: { maxUnity: 4, maxSessions: 6, maxSandboxes: 5 },
    protectedPaths: ['C:\\Users\\rydin\\nevergames\\FinalFactory'],
    librarySeed: 'F:\\ffsb\\_seed\\Library',
    librarySeedCopy: 'clone',
    librarySeedGB: 64,
    hostGuard: { warnFreeGB: 80, criticalFreeGB: 40 },
    unity: { mcpServer: { command: 'uvx.exe', args: ['mcp-for-unity'] }, idleStopMinutes: 120 },
  } as unknown as Config;
  const defaults = localMachineDefaults(cfg, 'C:\\ff-sandboxes');
  assert.deepEqual(
    { ...defaults },
    {
      host: 'localhost',
      portalUrl: 'http://127.0.0.1:8790',
      repoPath: 'C:\\ffsb\\_base',
      sandboxRoot: 'F:\\ffsb',
      maxSandboxes: 5,
      maxUnity: 4,
      maxSandboxAgents: 6,
      maxAgentsPerSandbox: 6,
      diskWarnGB: 80,
      diskCriticalGB: 40,
      protectedPaths: ['C:\\Users\\rydin\\nevergames\\FinalFactory', 'C:\\ff-sandboxes', dir],
      librarySeed: 'F:\\ffsb\\_seed\\Library',
      librarySeedCopy: 'clone',
      librarySeedGB: 10,
      unityBelowNormal: true,
    },
  );
  store = new Store(dir);
  const mm = new MachineManager(cfg, store, new SessionManager(cfg, store));
  mm.allowLocalAnywhere = true;
  mm.deployWaitMs = { settle: 1, poll: 1 };
  const seen: DeployOptions[] = [];
  mm.deployer = async (o) => {
    seen.push(o);
    return { platform: 'win32', home: 'C:\\Users\\rydin', repoPath: o.repoPath!, node: 'node.exe', nodeVersion: '24.0.0', version: 'abc1234', started: true };
  };
  const m = mm.deployMachine({ id: 'BEAST', local: true, maxUnity: 3 });
  assert.equal(m.local, true);
  assert.equal(m.name, 'BEAST');
  assert.equal(m.maxUnity, 3, 'what add_machine is given wins');
  assert.equal(m.maxSandboxes, 5);
  await until('deployed', () => seen.length === 1 && store!.machines.get('beast')!.status !== 'deploying');
  const o = seen[0];
  assert.equal(o.local, true);
  assert.equal(o.portalUrl, 'http://127.0.0.1:8790', "this server's loopback address: no Funnel round trip");
  assert.equal(o.repoPath, 'C:\\ffsb\\_base');
  assert.deepEqual(o.sandboxes, { root: 'F:\\ffsb', maxSandboxes: 5, maxAgentsPerSandbox: 6, maxUnity: 3, diskWarnGB: 80, diskCriticalGB: 40, maxAgents: 6, librarySeed: 'F:\\ffsb\\_seed\\Library', librarySeedCopy: 'clone', librarySeedGB: 10, belowNormal: true, protectedPaths: localMachineDefaults(cfg).protectedPaths });
  assert.deepEqual(o.extra, { unityMcpServer: { command: 'uvx.exe', args: ['mcp-for-unity'] }, maxEventsFile: null, sandboxIdleStopMinutes: 120, cleanup: { everyMinutes: 0, softFreeGB: 0 } });
  assert.equal(mm.local()?.id, 'beast');
  // A redeploy (an outdated daemon) keeps the base clone as the main clone rather than re-probing for one.
  mm.deployMachine({ id: 'beast', force: true });
  await until('redeployed', () => seen.length === 2 && store!.machines.get('beast')!.status !== 'deploying');
  assert.equal(seen[1].repoPath, 'C:\\ffsb\\_base');
  assert.equal(seen[1].local, true);
  assert.throws(() => mm.deployMachine({ id: 'beast2', local: true }), /beast is already the portal's own host/);
  mm.register({ id: 'm5', host: 'm5', purpose: 'unused', status: 'ready', repoPath: '/r', home: '/h', portalUrl: 'https://p', maxSessions: 3 });
  assert.throws(() => mm.deployMachine({ id: 'm5', local: true }), /a machine reached over ssh; remove it first/);
  assert.throws(() => mm.cleanupNow('beast'), /cleaned by this host's guard/);

  const json = JSON.parse(daemonConfig({ portalUrl: 'http://127.0.0.1:8790', id: 'beast', token: 't', repoPath: 'C:\\ffsb\\_base', maxSessions: 3, extra: o.extra }));
  assert.deepEqual([json.maxEventsFile, json.unityMcpServer.command, json.sandboxIdleStopMinutes], [null, 'uvx.exe', 120]);
  assert.deepEqual(poolSettingsOf({ sandboxRoot: '/s' }), { root: '/s', maxSandboxes: 3, maxAgentsPerSandbox: 2, maxUnity: 2, diskWarnGB: 50, diskCriticalGB: 20 }, 'a machine without the extras: as before');
});

test('beast machine: the local transport runs the same bootstrap without ssh; an existing task survives a non-elevated deploy', () => {
  const [cmd, args] = scriptCommand(LOCAL);
  assert.equal(cmd, 'powershell.exe');
  assert.ok(args.includes('-EncodedCommand'));
  const [sshCmd, sshArgs] = scriptCommand('lothdesktop');
  assert.equal(sshCmd, 'ssh');
  assert.deepEqual(sshArgs.slice(-args.length), args, 'the same bootstrap, over ssh');
  assert.equal(sshArgs[sshArgs.indexOf('lothdesktop') + 1], 'powershell.exe');
  const s = installScript({ sid: 'S-1-5-21-1-2-3-1001', home: 'C:\\Users\\rydin', config: '{}', node: 'C:\\nvm4w\\nodejs\\node.exe', flag: false });
  assert.match(s, /registered=kept/);
  assert.match(s, /Register it once from an administrator PowerShell: Register-ScheduledTask -TaskName FFFactoryDaemon -Xml \(Get-Content -Raw/);
});

test('beast machine: the host group lists its daemon\'s sandboxes as its own; the daemon has no group of its own', () => {
  const s = (id: string, over: Partial<SessionInfo>) => info(id, { status: 'running', ...over });
  const beast = beastMachine({ sandboxes: [machineSandboxFrom(hostSb('mp-r2', { sessionIds: ['w1'] }))], sessionIds: ['w1'], maxUnity: 4 });
  const m5 = { ...beastMachine({ id: 'm5', local: undefined, sandboxRoot: undefined, sandboxes: [], platform: 'darwin' }) };
  const system = { hostname: 'BEAST', platform: 'win32', limits: { maxUnity: 4, maxSessions: 6, maxSandboxes: 5 } } as SystemStats;
  const fleet = fleetOf({ sandboxes: [], sessions: [s('w1', { machineId: 'beast', machineSandbox: 'mp-r2' })], machines: [beast, m5], system, machineStats: {} });
  assert.deepEqual(fleet.map((c) => c.key), ['host', 'm5']);
  const host = fleet[0];
  assert.equal(host.daemon?.id, 'beast');
  assert.deepEqual(host.sandboxes.map((x) => [x.key, x.machineId, x.agents.live.length]), [['beast/mp-r2', 'beast', 1]]);
  assert.deepEqual([host.sandboxLimit, host.editors, host.editorLimit, host.live, host.busy], [5, 1, 4, 1, 1]);
  const before = fleetOf({ sandboxes: [hostSb('mp-r2')], sessions: [], machines: [m5], system, machineStats: {} });
  assert.equal(before[0].daemon, undefined, 'no daemon: the host as before');
});

test('beast machine: no agent ends the daemon\'s task; the reaper never touches a daemon', async () => {
  const g = sandboxGuard({ sandboxId: 'mp-r2', sandboxPath: 'F:/ffsb/mp-r2', protectedPaths: ['C:/Users/rydin/nevergames/FinalFactory', 'C:/ff-sandboxes'] });
  const decide = async (command: string) => {
    const input = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, tool_use_id: 'x', session_id: 's', transcript_path: '', cwd: 'F:/ffsb/mp-r2' };
    const r = (await g(input as never, 'x', { signal: new AbortController().signal })) as { hookSpecificOutput?: { permissionDecision?: string } };
    return r.hookSpecificOutput?.permissionDecision ?? 'allow';
  };
  for (const c of ['schtasks /End /TN FFFactoryDaemon', 'Stop-ScheduledTask -TaskName FFFactoryDaemon', 'Get-ScheduledTask FFFactoryDaemon | Disable-ScheduledTask', 'ls C:/ff-sandboxes/data']) assert.equal(await decide(c), 'deny', c);
  assert.equal(await decide('git status'), 'allow');
  const daemonProc = { pid: 9, ppid: 1, name: 'node.exe', cmd: '"C:\\nvm4w\\nodejs\\node.exe" "C:\\Users\\rydin\\.ff-factory\\app\\machine\\daemon.ts" daemon.json', created: 0 };
  assert.equal(isProtected(daemonProc, 1), true);
  assert.equal(isProtected({ ...daemonProc, cmd: 'node shot.js' }, 1), false);
});

test('beast machine: a standing agent on it keeps the workers\' account; its daemon cleans nothing even before the first welcome', () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, 'standing.ts'), 'utf8');
  assert.match(src, /hostClaudeEnvFor\(this\.cfg, m \?\? a\.machineId\)/, 'the machine record, so the local rule applies');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-dclean-'));
  try {
    const d = new Daemon({ portalUrl: 'http://127.0.0.1:1', id: 'beast', token: 't', repoPath: dir, appDir: dir, maxEventsFile: null, cleanup: { everyMinutes: 0, softFreeGB: 0 } }, (i, s, o, e) => new FakeAgent(i, s, o, e), PROBES);
    assert.deepEqual((d as unknown as { cleanupSettings: unknown }).cleanupSettings, { everyMinutes: 0, softFreeGB: 0 });
    const other = new Daemon({ portalUrl: 'http://127.0.0.1:1', id: 'm5', token: 't', repoPath: dir, appDir: path.join(dir, 'x'), maxEventsFile: null }, (i, s, o, e) => new FakeAgent(i, s, o, e), PROBES);
    assert.deepEqual((other as unknown as { cleanupSettings: unknown }).cleanupSettings, { everyMinutes: 60, softFreeGB: 80 }, 'other machines: the defaults, as before');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
