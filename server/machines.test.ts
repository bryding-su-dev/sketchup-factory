import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { EventEmitter } from 'node:events';
import type { AddressInfo } from 'node:net';
import { Store } from './store.ts';
import { SessionManager, snapshotOf, type SessionHandle, type SessionSink } from './sessions.ts';
import { collectResume } from './restart.ts';
import { MachineManager, RESUME_DELAY_MS, RemoteSession, cutOffMidTurn, daemonMismatch } from './machines.ts';
import { PROTOCOL_VERSION } from './machineProtocol.ts';
import { buildOptions } from './launch.ts';
import { HOST_LOGIN } from './usage.ts';
import { Daemon, type Probes } from '../machine/daemon.ts';
import { backupRootFor, checkOwnCheckout, hasRecentBackup } from './guard.ts';
import { agentPath, macReloadLines, nodeSupport, plist } from './machineDeploy.ts';
import type { Config } from './config.ts';
import type { HostStats, ImageInput, PermissionMode, SessionInfo, TranscriptEvent } from '../shared/types.ts';

/** Stands in for AgentSession on the daemon: answers every message with "echo <text>". */
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
  images: ImageInput[] = [];
  send(text: string, from: 'human' | 'orchestrator' | 'system' = 'human', uuid = 'u', images: ImageInput[] = []) {
    this.live = true;
    this.images = images;
    this.sink.append(this.info.id, { kind: 'user', text, from, uuid, images: images.map((i) => ({ id: i.id ?? '?', mediaType: i.mediaType })) });
    if (text === 'screenshot') {
      // A tool that returns an image: the daemon ships it to the portal before the event naming it.
      const id = this.sink.saveImage(this.info.id, 'image/png', 'iVBORw0KGgo=');
      this.sink.append(this.info.id, { kind: 'tool_result', toolUseId: 't', isError: false, text: '[image]', images: [{ id, mediaType: 'image/png' }] });
    }
    this.info.status = 'running';
    this.info.turnOpenSince ??= new Date().toISOString();
    this.sink.putSession(this.info);
    if (text.startsWith('long')) return uuid; // stays mid-turn
    setTimeout(() => {
      this.sink.append(this.info.id, { kind: 'assistant', text: `echo ${text}` });
      Object.assign(this.info, { status: 'idle', turnOpenSince: undefined, costUsd: this.info.costUsd + 0.01, turns: this.info.turns + 1 });
      this.sink.putSession(this.info);
      this.events.emit('result', this, 'success');
      this.events.emit('turnEnd', this, `echo ${text}`);
    }, 20);
    return uuid;
  }
  async interrupt() {}
  async setMode(m: PermissionMode) {
    this.info.permissionMode = m;
  }
  stop(onPurpose = true) {
    if (!this.live) return;
    this.live = false;
    this.info.status = 'stopped';
    // Like AgentSession: a stop on purpose ends the turn; a daemon going down keeps the restart mark.
    if (onPurpose) this.info.turnOpenSince = undefined;
    this.sink.putSession(this.info);
    this.events.emit('ended', this);
  }
  decide() {
    return false;
  }
}

/** A Mac's load and its own login's usage, without vm_stat or a Claude CLI. */
const MAC_STATS: HostStats = {
  hostname: 'mx.local',
  platform: 'darwin 25.0.0',
  cpuModel: 'Apple M4 Pro',
  cpuCount: 14,
  loadPct: 37,
  memTotalBytes: 48 * 2 ** 30,
  memFreeBytes: 30 * 2 ** 30,
  memUsedBytes: 18 * 2 ** 30,
  memPressure: 'normal',
  gpu: { name: 'Apple M4 Pro', memTotalMiB: 48 * 1024, memUsedMiB: 2048, utilPct: 12, unified: true },
};
const FAKE_PROBES: Probes = {
  stats: async () => MAC_STATS,
  usage: async () => ({
    account: { email: 'someone@example.com', plan: 'Claude Max' },
    reply: { subscription_type: 'max', rate_limits_available: true, rate_limits: { limits: [{ kind: 'weekly_all', percent: 41, resets_at: null }] } },
  }),
};

const until = async (what: string, cond: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

async function setup() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-machines-'));
  const cfg = { dataDir: tmp, limits: { maxSessions: 6 }, repo: { url: 'x' }, worker: { effort: 'high' } } as unknown as Config;
  const store = new Store(tmp);
  const sessions = new SessionManager(cfg, store);
  const mm = new MachineManager(cfg, store, sessions);
  mm.hooks = {
    specFor: (info) => ({ cwd: tmp, settingSources: [], append: '', strictMcp: true, guard: { id: 'x', ownPath: tmp, protectedPaths: [], gameRepos: [] }, model: info.model }),
    handlersFor: (_info, m) => ({ set_label: async (a) => mm.setPurpose(m.id, String(a.purpose)).purpose, wake_me: async (a) => `waking you in ${a.minutes} min: ${a.note}` }),
  };
  const server = http.createServer();
  server.on('upgrade', (req, socket, head) => mm.upgrade(req, socket, head, '127.0.0.1'));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const { token } = mm.register({ id: 'mx', host: 'mx', purpose: 'unused', status: 'ready', repoPath: tmp, home: tmp, portalUrl: url, maxSessions: 1 });
  const daemons: Daemon[] = [];
  const daemon = (tok = token, agent: typeof FakeAgent = FakeAgent) => {
    const d = new Daemon({ portalUrl: url, id: 'mx', token: tok, repoPath: tmp, appDir: tmp, claude: 'definitely-not-a-claude-binary', maxSessions: 1, maxEventsFile: path.join(tmp, 'max-events.jsonl') }, (i, s, o, e) => new agent(i, s, o, e), FAKE_PROBES);
    daemons.push(d);
    d.start();
    return d;
  };
  const cleanup = async () => {
    for (const d of daemons) d.shutdown();
    await until('disconnect', () => !mm.isOnline('mx')).catch(() => undefined);
    server.close();
    // Let the last session/machine updates (and their debounced saves) land before the folder goes.
    await new Promise((r) => setTimeout(r, 400));
    store.flush();
    fs.rmSync(tmp, { recursive: true, force: true });
  };
  return { store, sessions, mm, daemon, token, cleanup, tmp };
}

test('machine: the daemon reports its Mac\'s load and its own login\'s usage; offline clears the load (protocol 4)', async (t) => {
  const { mm, daemon, cleanup } = await setup();
  t.after(cleanup);
  const usage: unknown[] = [];
  mm.onUsage = (id, account, u) => usage.push({ id, email: account.email, weekly: u.weekly?.percent });
  const d = daemon();
  await until('stats', () => !!mm.statsOf('mx'));
  const st = mm.statsOf('mx')!;
  assert.equal(st.loadPct, 37);
  assert.equal(st.gpu?.unified, true);
  assert.ok(!isNaN(Date.parse(st.at)), 'the portal stamps when it arrived');
  assert.deepEqual(Object.keys(mm.allStats()), ['mx']);
  await until('usage', () => usage.length > 0);
  assert.deepEqual(usage[0], { id: 'mx', email: 'someone@example.com', weekly: 41 });
  // It polls on the portal's interval (config usagePollMinutes, default 15), and at once when the meters' Refresh asks.
  await until('the interval', () => (d as unknown as { usageMs: number }).usageMs === 15 * 60_000);
  assert.equal(usage.length, 1);
  assert.equal(mm.requestUsage(), 1);
  await until('usage on request', () => usage.length === 2);
  d.shutdown();
  await until('offline', () => !mm.isOnline('mx'));
  assert.equal(mm.statsOf('mx'), undefined, "an offline machine's numbers are gone, not shown stale");
});

test("machine: the daemon forwards the Mac's Max events file, older lines first, then new ones (docs/max.md)", async (t) => {
  const { mm, daemon, cleanup, tmp } = await setup();
  t.after(cleanup);
  const lines: [string, string][] = [];
  mm.maxEvent = (id, line) => lines.push([id, line]);
  const file = path.join(tmp, 'max-events.jsonl');
  fs.writeFileSync(file, '{"v":1,"n":1}\n');
  daemon();
  await until('the line written before the daemon started', () => lines.length === 1);
  fs.appendFileSync(file, '{"v":1,"n":2}\n{"v":1,"n":3');
  await until('the next complete line', () => lines.length === 2);
  assert.deepEqual(lines, [
    ['mx', '{"v":1,"n":1}'],
    ['mx', '{"v":1,"n":2}'],
  ]);
  // The half-written third line waits for its newline; the offset is kept for a restart.
  fs.appendFileSync(file, '}\n');
  await until('the finished line', () => lines.length === 3);
  await until('the offset saved', () => fs.existsSync(`${file}.daemon-offset`) && Number(fs.readFileSync(`${file}.daemon-offset`, 'utf8')) === fs.statSync(file).size);
});

test('machine: a daemon connects, runs a session, and everything it records lands in the portal', async (t) => {
  const { store, sessions, mm, daemon, cleanup } = await setup();
  t.after(cleanup);
  daemon();
  await until('online', () => mm.isOnline('mx') && !!store.machines.get('mx')?.info);
  assert.equal(store.machines.get('mx')!.online, true);

  const turnEnds: string[] = [];
  sessions.events.on('turnEnd', (s: SessionHandle, text: string) => turnEnds.push(`${s.info.id}:${text}`));
  const s = mm.createSession('mx', { kind: 'worker', title: 'w', permissionMode: 'default' });
  assert.ok(s instanceof RemoteSession);
  sessions.send(s.info.id, 'hello');
  await until('turn end', () => turnEnds.length === 1);
  assert.equal(turnEnds[0], `${s.info.id}:echo hello`);
  const events = store.readTranscript(s.info.id);
  assert.deepEqual(
    events.map((e) => [e.seq, e.kind]),
    [
      [1, 'user'],
      [2, 'assistant'],
    ],
  );
  assert.equal(s.info.status, 'idle');
  assert.equal(s.info.costUsd, 0.01);
  assert.equal(s.live, true, 'the process stays up between turns, like a local worker');
  assert.equal(sessions.liveAgents(), 0, "a machine's agents do not count toward this host's limit");
  assert.equal(mm.liveCount('mx'), 1);

  // The machine's own limit (1): a second session cannot start while the first is live.
  const s2 = mm.createSession('mx', { kind: 'worker', title: 'w2', permissionMode: 'default' });
  assert.throws(() => sessions.send(s2.info.id, 'x'), /already 1 agents running in mx's main clone/);
  s.stop();
  await until('stopped', () => !s.live);
  sessions.send(s2.info.id, 'second');
  await until('second turn', () => turnEnds.length === 2);
});

test("machine: a Mac agent on its own login shows on that Mac's login, not this host's (docs/accounts.md)", async (t) => {
  const { mm, daemon, cleanup } = await setup();
  t.after(cleanup);
  // What AgentSession records on the Mac when its process starts with no token (usage.ts accountKeyOf).
  class OnLogin extends FakeAgent {
    override send(text: string, from?: 'human' | 'orchestrator' | 'system', uuid?: string, images?: ImageInput[]) {
      this.info.account = HOST_LOGIN;
      return super.send(text, from, uuid, images);
    }
  }
  daemon(undefined, OnLogin);
  await until('online', () => mm.isOnline('mx'));
  const s = mm.createSession('mx', { kind: 'worker', title: 'w', permissionMode: 'default' });
  s.send('hello');
  await until('reported', () => s.info.account !== undefined);
  assert.equal(s.info.account, 'login:mx');
});

test('machine: offline sessions show stopped and refuse messages; a reconnect resumes the transcript numbering', async (t) => {
  const { store, sessions, mm, daemon, cleanup } = await setup();
  t.after(cleanup);
  const d = daemon();
  await until('online', () => mm.isOnline('mx'));
  const s = mm.createSession('mx', { kind: 'worker', title: 'w', permissionMode: 'default' });
  const ended: string[] = [];
  sessions.events.on('ended', (h: SessionHandle) => ended.push(h.info.id));
  sessions.send(s.info.id, 'one');
  await until('idle', () => s.info.status === 'idle');

  d.shutdown();
  await until('offline', () => !mm.isOnline('mx'));
  assert.equal(store.machines.get('mx')!.online, false);
  assert.equal(s.live, false);
  assert.ok(ended.includes(s.info.id), 'standing agents hear that the run ended');
  assert.throws(() => sessions.send(s.info.id, 'two'), /machine mx is offline/);

  daemon();
  await until('online again', () => mm.isOnline('mx'));
  sessions.send(s.info.id, 'three');
  await until('answered', () => store.readTranscript(s.info.id).length === 4);
  assert.deepEqual(
    store.readTranscript(s.info.id).map((e) => e.seq),
    [1, 2, 3, 4],
  );
});

test('machine: images go to the agent with ids the portal already stored; images it produces come back', async (t) => {
  const { store, sessions, mm, daemon, cleanup } = await setup();
  t.after(cleanup);
  daemon();
  await until('online', () => mm.isOnline('mx'));
  const s = mm.createSession('mx', { kind: 'worker', title: 'w', permissionMode: 'default' });
  sessions.send(s.info.id, 'look', 'human', [{ mediaType: 'image/jpeg', data: '/9j/4AAQ' }]);
  await until('answered', () => store.readTranscript(s.info.id).some((e) => e.kind === 'assistant'));
  const user = store.readTranscript(s.info.id).find((e) => e.kind === 'user') as Extract<TranscriptEvent, { kind: 'user' }>;
  assert.equal(user.images?.length, 1);
  assert.ok(store.imagePath(s.info.id, user.images![0].id), 'stored on the portal before it was sent');

  sessions.send(s.info.id, 'screenshot');
  await until('tool result', () => store.readTranscript(s.info.id).some((e) => e.kind === 'tool_result'));
  const tr = store.readTranscript(s.info.id).find((e) => e.kind === 'tool_result') as Extract<TranscriptEvent, { kind: 'tool_result' }>;
  assert.ok(store.imagePath(s.info.id, tr.images![0].id), 'the image arrived before the event that names it');
});

test('machine: a bad token is refused; tool calls go back to the portal', async (t) => {
  const { store, mm, daemon, token, cleanup } = await setup();
  t.after(cleanup);
  const bad = daemon(token.slice(0, -4) + 'AAAA');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(mm.isOnline('mx'), false);
  assert.equal(bad.connected, false);
  bad.shutdown();
  assert.equal(mm.authenticate(`Bearer ${token}`), 'mx');
  assert.equal(mm.authenticate(`Bearer ${token}x`), undefined);
  assert.equal(mm.authenticate('Bearer ffsb_whatever'), undefined);

  const d = daemon();
  await until('online', () => mm.isOnline('mx'));
  const s = mm.createSession('mx', { kind: 'worker', title: 'w', permissionMode: 'default' });
  type H = (a: Record<string, unknown>) => Promise<string>;
  const handlers = (d as unknown as { handlers(id: string): Record<string, H> }).handlers(s.info.id);
  assert.equal(await handlers.set_label({ purpose: 'shader pass' }), 'shader pass');
  assert.equal(store.machines.get('mx')!.purpose, 'shader pass');
  // Every portal tool is forwarded (wake_me and unity were left out once); the portal decides who may use which.
  assert.equal(await handlers.wake_me({ minutes: 20, note: 'check the build' }), 'waking you in 20 min: check the build');
  await assert.rejects(handlers.unity({ action: 'status' }), /unity is not available to this session/);
});

test("own checkout: discards need a fresh backup first (the user's standing permission); never stage or commit everything", (t) => {
  const clean = () => true;
  const dirty = () => false;
  const none = { root: '/Users/b/nevergames/ff-local-backups', has: () => false };
  const fresh = { ...none, has: () => true };
  const discards = [
    'git stash',
    'git stash push -m x',
    'git stash pop',
    'git reset --hard origin/develop',
    'git clean -fd',
    'git checkout -- Assets/x.cs',
    'git checkout .',
    'git restore Assets/x.cs',
    'cd sub && git switch -f other',
  ];
  for (const cmd of discards) {
    const why = checkOwnCheckout(cmd, '/r', clean, none);
    assert.match(why ?? '', /standing permission.*FIRST copy them.*\/Users\/b\/nevergames\/ff-local-backups\/\$\(date.*report what you moved/, cmd);
    assert.equal(checkOwnCheckout(cmd, '/r', clean, fresh), undefined, `${cmd} after a backup`);
  }
  // Never everything into a commit, backup or not.
  for (const cmd of ['git add -A', 'git add .', 'git add --all', 'git commit -am "x"', 'git commit -a -m x']) {
    assert.ok(checkOwnCheckout(cmd, '/r', clean, fresh), cmd);
  }
  for (const cmd of ['git stash list', 'git reset HEAD Assets/x.cs', 'git restore --staged Assets/x.cs', 'git add Assets/x.cs', 'git commit -m x', 'git clean -n', 'git status', 'git checkout -b feature/x', 'git switch develop']) {
    assert.equal(checkOwnCheckout(cmd, '/r', clean, none), undefined, cmd);
  }
  // A branch switch on a dirty tree: after a backup.
  assert.match(checkOwnCheckout('git checkout develop', '/r', dirty, none)!, /uncommitted changes.*FIRST copy them/);
  assert.equal(checkOwnCheckout('git -C /other switch -c x', '/r', dirty, fresh), undefined);
  assert.equal(checkOwnCheckout('git commit -m x', '/r', dirty, none), undefined, 'committing your own staged files is fine on a dirty tree');
  // The folder beside the clone, and "fresh" = a backup folder from the last 2 hours.
  assert.equal(backupRootFor('/Users/b/nevergames/FinalFactory/'), '/Users/b/nevergames/ff-local-backups');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-local-backups-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(hasRecentBackup(root), false);
  fs.mkdirSync(path.join(root, '20260925-101500'));
  assert.equal(hasRecentBackup(root), true);
  assert.equal(hasRecentBackup(root, 2 * 3_600_000, Date.now() + 3 * 3_600_000), false, 'three hours later it is stale');
});

test('deploy: node support and the LaunchAgent', () => {
  assert.deepEqual(nodeSupport('22.15.0'), { ok: true, flag: true });
  assert.deepEqual(nodeSupport('26.5.0'), { ok: true, flag: false });
  assert.deepEqual(nodeSupport('23.6.0'), { ok: true, flag: false });
  assert.equal(nodeSupport('22.5.1').ok, false);
  assert.equal(nodeSupport(undefined).ok, false);
  const p = plist('/Users/b', '/Users/b/.nvm/versions/node/v22.15.0/bin/node', true);
  assert.match(p, /<string>--experimental-strip-types<\/string>/);
  assert.match(p, /<string>\/Users\/b\/.ff-factory\/app\/machine\/daemon.ts<\/string>/);
  assert.match(p, /<key>KeepAlive<\/key><true\/>/);
  assert.match(p, /\/Users\/b\/.nvm\/versions\/node\/v22.15.0\/bin:/);
  // The user's shell PATH comes through (~/bin/gh on the M5), with Homebrew and the system dirs after it.
  const path = agentPath('/Users/b', '/opt/homebrew/bin/node', '/Users/b/bin:~/.dotnet/tools:/opt/homebrew/bin::relative');
  assert.equal(path, '/opt/homebrew/bin:/Users/b/bin:/Users/b/.dotnet/tools:/Users/b/.local/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin');
  assert.match(plist('/Users/b', '/opt/homebrew/bin/node', false, '/Users/b/bin'), /<key>PATH<\/key><string>\/opt\/homebrew\/bin:\/Users\/b\/bin:/);
});

test('deploy: the game clone is recognised by the owner/name of config repo.url', async () => {
  const { repoSlug } = await import('./machineDeploy.ts');
  assert.equal(repoSlug('https://github.com/Some-Org/SomeGame.git'), 'Some-Org/SomeGame');
  assert.equal(repoSlug('git@github.com:Some-Org/SomeGame.git'), 'Some-Org/SomeGame');
  assert.equal(repoSlug('https://github.com/Some-Org/SomeGame/'), 'Some-Org/SomeGame');
  assert.equal(repoSlug('not a url'), undefined);
});

test('machines: an offline daemon is redeployed only after 2 minutes, when idle, at most every 30 minutes', async () => {
  const { redeployDue } = await import('./machines.ts');
  const ok = { status: 'ready', deploying: false, liveAgents: 0 };
  assert.equal(redeployDue(ok, 90_000, Infinity), undefined, 'it reconnects by itself within about a minute');
  assert.match(redeployDue(ok, 3 * 60_000, Infinity) ?? '', /offline for 3 min/);
  assert.equal(redeployDue(ok, 3 * 60_000, 10 * 60_000), undefined, 'tried 10 min ago');
  assert.equal(redeployDue({ ...ok, deploying: true }, 3 * 60_000, Infinity), undefined);
  assert.equal(redeployDue({ ...ok, liveAgents: 1 }, 3 * 60_000, Infinity), undefined);
});

test('daemon: reconnects every ~2 s for two minutes after a drop, then backs off', async () => {
  const { reconnectDelayMs } = await import('../machine/daemon.ts');
  assert.equal(reconnectDelayMs(5_000, 5, 0.5), 2000);
  assert.equal(reconnectDelayMs(119_000, 6, 0.5), 2000);
  assert.equal(reconnectDelayMs(130_000, 2, 0.5), 4000);
  assert.equal(reconnectDelayMs(600_000, 6, 0.5), 30_000);
});

test('daemon: a portal answering 502 (restarting behind the proxy) is retried at once, not after a handshake timeout', async (t) => {
  // The proxy in front of a restarting portal answers the upgrade with 502. Each refusal must end the attempt
  // right away; before the fix it hung until the handshake timeout, so a restart took ~40 s to get over.
  let upgrades = 0;
  const server = http.createServer();
  server.on('upgrade', (_req, socket) => {
    upgrades++;
    socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-502-'));
  const d = new Daemon(
    { portalUrl: url, id: 'mx', token: 't', repoPath: tmp, claude: 'definitely-not-a-claude-binary', maxSessions: 1, maxEventsFile: null },
    () => {
      throw new Error('no sessions here');
    },
    FAKE_PROBES,
  );
  t.after(() => {
    d.shutdown();
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  d.start();
  await new Promise((r) => setTimeout(r, 6000));
  // Attempts every ~2 s (jitter 1.5-2.5 s): at least 3 in 6 s. A hung attempt would allow 1.
  assert.ok(upgrades >= 3, `only ${upgrades} attempt(s) in 6 s`);
});

test('daemon versions: another protocol or another commit is outdated; unknown versions are not', () => {
  const head = '5b181de0123456789abcdef0123456789abcdef0';
  assert.equal(daemonMismatch({ protocol: PROTOCOL_VERSION, daemon: '5b181de' }, head), undefined);
  assert.match(daemonMismatch({ protocol: PROTOCOL_VERSION, daemon: 'dd72bd0' }, head) ?? '', /runs dd72bd0, this portal 5b181de01/);
  assert.match(daemonMismatch({ protocol: PROTOCOL_VERSION - 1, daemon: '5b181de' }, head) ?? '', /protocol/);
  assert.equal(daemonMismatch({ protocol: PROTOCOL_VERSION, daemon: `protocol ${PROTOCOL_VERSION}` }, head), undefined);
  assert.equal(daemonMismatch({ protocol: PROTOCOL_VERSION, daemon: '5b181de' }, undefined), undefined);
});

test('machine: an outdated daemon is redeployed, and new agents get a clear refusal meanwhile, not a crash', async (t) => {
  const { store, sessions, mm, daemon, cleanup } = await setup();
  t.after(cleanup);
  const deployed: string[] = [];
  mm.deployMachine = ((o: { id: string }) => (deployed.push(o.id), store.machines.get(o.id)!)) as typeof mm.deployMachine;
  const reports: string[] = [];
  mm.report = (text) => reports.push(text);
  daemon();
  await until('online', () => mm.isOnline('mx') && !!store.machines.get('mx')?.info);
  assert.equal(mm.outdated('mx'), undefined, 'this checkout has no machine/VERSION: current');
  // The daemon a previous version deployed says hello (as after an app update).
  mm.portalHead = '5b181de0123456789abcdef0123456789abcdef0';
  const hello = (daemonVersion: string, protocol = PROTOCOL_VERSION) =>
    (mm as unknown as { onMessage(id: string, msg: unknown): void }).onMessage('mx', { type: 'hello', protocol, home: '', live: [], info: { ...store.machines.get('mx')!.info, daemon: daemonVersion } });
  hello('dd72bd0');
  assert.deepEqual(deployed, ['mx'], 'redeployed at once: no agent runs there');
  assert.match(reports.at(-1) ?? '', /mx's daemon is outdated \(it runs dd72bd0, this portal 5b181de01\); redeploying/);
  assert.match(store.machines.get('mx')!.statusDetail ?? '', /daemon outdated/);
  const s = mm.createSession('mx', { kind: 'worker', title: 'w', permissionMode: 'default' });
  assert.throws(() => sessions.send(s.info.id, 'hello'), /mx's daemon is outdated \(it runs dd72bd0.*Try again in a few minutes/);
  // At most one automatic redeploy per 10 minutes.
  mm.checkOutdated();
  assert.equal(deployed.length, 1);
  // The redeployed daemon: current again, and agents start.
  hello('5b181de');
  assert.equal(mm.outdated('mx'), undefined);
  assert.equal(store.machines.get('mx')!.statusDetail, undefined);
  assert.equal(await mm.whenCurrent('mx', 1000, 10), undefined);
  const turnEnds: string[] = [];
  sessions.events.on('turnEnd', (_s: SessionHandle, text: string) => turnEnds.push(text));
  sessions.send(s.info.id, 'hello');
  await until('turn end', () => turnEnds.length === 1);
  // Offline: whenCurrent gives up with why.
  assert.match((await mm.whenCurrent('nope', 50, 10)) ?? '', /no machine/);
});

test('launch: a tool this version does not know is left out, not fatal (a newer portal, an older daemon)', () => {
  const tmp = os.tmpdir();
  const o = buildOptions(
    { cwd: tmp, settingSources: [], append: '', strictMcp: true, guard: { id: 'x', ownPath: tmp, protectedPaths: [], gameRepos: [] }, mcp: { server: 'machine', tools: [{ name: 'set_label', description: 'd' }, { name: 'from_the_future' as never, description: 'd' }] } },
    {},
  );
  assert.ok(o.mcpServers?.machine);
});

test('machine: a lockout does not feed itself, and a good token gets through it', async (t) => {
  const { mm, token, cleanup } = await setup();
  t.after(cleanup);
  const bad = token.slice(0, -4) + 'AAAA';
  let clock = Date.now();
  t.mock.method(Date, 'now', () => clock);
  const answers: string[] = [];
  const attempt = (tok: string) => {
    const out: string[] = [];
    const socket = { write: (s: string) => out.push(s), destroy: () => undefined } as unknown as import('node:stream').Duplex;
    const req = { headers: { authorization: `Bearer ${tok}` } } as unknown as http.IncomingMessage;
    const ok = mm.upgrade(req, socket, Buffer.alloc(0), '198.51.100.7');
    answers.push(ok ? 'ok' : (out[0]?.split(' ')[1] ?? '?'));
    return ok;
  };
  for (let i = 0; i < 10; i++) attempt(bad);
  assert.deepEqual(answers.splice(0), [...Array(10).fill('401')]);
  // A daemon retrying about every 36 s for an hour: refused, but its refusals do not extend the lockout.
  for (let i = 0; i < 100; i++) {
    clock += 36_000;
    attempt(bad);
  }
  assert.equal(answers.at(10), '429', 'still locked out ten retries in');
  assert.equal(answers.at(-1), '401', 'the lockout ends 15 minutes after the last counted failure');
  answers.length = 0;

  // Locked out again; a good token still gets in (the reinstall fixed the daemon), and it clears the address.
  for (let i = 0; i < 11; i++) attempt(bad);
  assert.equal(answers.at(-1), '429');
  const failures = (mm as unknown as { failures: Map<string, number[]> }).failures;
  const wss = (mm as unknown as { wss: { handleUpgrade: (...a: unknown[]) => void } }).wss;
  let upgraded = 0;
  t.mock.method(wss, 'handleUpgrade', () => upgraded++);
  assert.equal(attempt(token), true);
  assert.equal(upgraded, 1);
  assert.equal(failures.has('198.51.100.7'), false);
  assert.equal(attempt(bad), false);
  assert.equal(answers.at(-1), '401');
});

test('machine: the hello reports the platform (a Windows PC), and a mixed-case id is stored lower-case and shown as typed', async (t) => {
  const { store, mm, daemon, cleanup } = await setup();
  t.after(cleanup);
  daemon();
  await until('online', () => mm.isOnline('mx') && !!store.machines.get('mx')?.info);
  const hello = (platform: 'win32' | 'darwin') =>
    (mm as unknown as { onMessage(id: string, msg: unknown): void }).onMessage('mx', { type: 'hello', protocol: PROTOCOL_VERSION, home: 'C:\\Users\\Loth', live: [], info: { ...store.machines.get('mx')!.info, platform } });
  hello('win32');
  assert.equal(store.machines.get('mx')!.platform, 'win32');
  assert.equal(store.machines.get('mx')!.home, 'C:\\Users\\Loth');
  // add_machine "LothDesktop": id lothdesktop, shown as LothDesktop; a later redeploy by id keeps the name.
  (mm as unknown as { runDeploy: () => Promise<void> }).runDeploy = async () => undefined;
  const m = mm.deployMachine({ id: 'LothDesktop', host: 'lothdesktop', portalUrl: 'https://beast.example.ts.net' });
  assert.equal(m.id, 'lothdesktop');
  assert.equal(m.name, 'LothDesktop');
  assert.equal(mm.require('LothDesktop').id, 'lothdesktop', 'either spelling finds it');
  assert.equal(mm.deployMachine({ id: 'lothdesktop' }).name, 'LothDesktop');
  assert.throws(() => mm.deployMachine({ id: 'Loth Desktop' }), /lower-case letters, digits and dashes/);
});

test('machine: stopping or restarting a daemon is refused while agents run unless forced; a stopped daemon is not redeployed', async (t) => {
  const { store, sessions, mm, daemon, cleanup } = await setup();
  t.after(cleanup);
  const d = daemon();
  await until('online', () => mm.isOnline('mx'));
  const s = mm.createSession('mx', { kind: 'worker', title: 'w', permissionMode: 'default' });
  sessions.send(s.info.id, 'hello');
  await until('live', () => mm.liveCount('mx') === 1);
  await assert.rejects(mm.controlDaemon('mx', 'stop'), /mx has 1 agent\(s\) running; a daemon stop stops them/);
  await assert.rejects(mm.controlDaemon('mx', 'restart'), /Stop them first or pass force/);
  // Stopped on purpose: the offline watch leaves it down even when ssh answers.
  d.shutdown();
  await until('offline', () => !mm.isOnline('mx'));
  mm.update('mx', { daemonStopped: true });
  const redeployed: string[] = [];
  mm.deployMachine = ((o: { id: string }) => (redeployed.push(o.id), store.machines.get(o.id)!)) as typeof mm.deployMachine;
  await mm.watchOffline(Date.now(), async () => true);
  assert.deepEqual(await mm.watchOffline(Date.now() + 10 * 60_000, async () => true), []);
  assert.deepEqual(redeployed, []);
  mm.update('mx', { daemonStopped: undefined });
  assert.deepEqual(await mm.watchOffline(Date.now() + 20 * 60_000, async () => true), ['mx'], 'otherwise it is redeployed as before');
});

test('machine: agents cut off mid-turn by a forced redeploy or a daemon restart are resumed when the daemon is back; a stop is not', async (t) => {
  const { store, sessions, mm, daemon, cleanup } = await setup();
  t.after(cleanup);
  RESUME_DELAY_MS.value = 50;
  t.after(() => (RESUME_DELAY_MS.value = 3000));
  const reports: string[] = [];
  mm.report = (text) => reports.push(text);
  const d1 = daemon();
  await until('online', () => mm.isOnline('mx'));
  const s = mm.createSession('mx', { kind: 'worker', title: 'w', permissionMode: 'default' });
  sessions.send(s.info.id, 'long build');
  await until('mid-turn', () => s.info.status === 'running');
  const users = () => store.readTranscript(s.info.id).filter((e) => e.kind === 'user').map((e) => (e as { text: string }).text);

  // add_machine with force: the old daemon (and its agent processes) goes, a new one connects.
  mm.expectDrop('mx', 'was redeployed (add_machine with force)');
  d1.shutdown();
  await until('offline', () => !mm.isOnline('mx'));
  assert.equal(s.info.status, 'stopped');
  const d2 = daemon();
  await until('resumed', () => users().length === 2, 8000).catch((e) => {
    throw new Error(`${e.message}; cutOff=${JSON.stringify([...(mm as unknown as { cutOff: Map<string, unknown> }).cutOff])} outdated=${mm.outdated('mx')} users=${JSON.stringify(users())} status=${s.info.status} reports=${reports.join(' | ')}`);
  });
  assert.match(users()[1], /^\[machine mx\] The SketchUp Factory daemon on this machine was redeployed \(add_machine with force\) at .* while you were mid-turn/);
  await until('the resumed turn ran', () => s.info.status === 'idle');
  assert.ok(reports.some((r) => /mx is back after its daemon was redeployed \(add_machine with force\); resumed 1 agent\(s\)/.test(r)), reports.join('\n'));

  // A network blip: the daemon (and the agent) live on; the reconnect finds it live, so no resume message.
  sessions.send(s.info.id, 'long again');
  await until('the daemon has it mid-turn', () => s.info.status === 'running' && users().length === 3);
  (mm as unknown as { links: Map<string, { ws: { terminate(): void } }> }).links.get('mx')!.ws.terminate();
  await until('dropped', () => !mm.isOnline('mx'));
  await until('back', () => mm.isOnline('mx') && s.live, 8000);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(users().length, 3, 'a live agent is not sent a resume');

  // machine_daemon stop: on purpose, so nothing is resumed when a daemon comes back later.
  mm.expectDrop('mx', false);
  d2.shutdown();
  await until('offline again', () => !mm.isOnline('mx'));
  daemon();
  await until('online again', () => mm.isOnline('mx'));
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(users().length, 3, `a stop is not undone: ${JSON.stringify(users())} ${reports.join(' | ')}`);
});

test('machine: a dropped link resumes only agents mid-turn now, never finished ones with a stale turn mark (21 old agents resumed, 2026-09-29)', async (t) => {
  const { store, sessions, mm, daemon, cleanup } = await setup();
  t.after(cleanup);
  RESUME_DELAY_MS.value = 50;
  t.after(() => (RESUME_DELAY_MS.value = 3000));
  const now = Date.parse('2026-09-29T12:00:00Z');
  const worker = (over: Partial<SessionInfo>) => ({ kind: 'worker' as const, status: 'idle' as const, lastActivityAt: '2026-09-29T11:59:00Z', ...over });
  assert.equal(cutOffMidTurn(worker({ status: 'running' }), true, now), true);
  assert.equal(cutOffMidTurn(worker({ status: 'stopped', turnOpenSince: '2026-09-29T11:50:00Z' }), true, now), true, 'a daemon going down keeps the mark');
  assert.equal(cutOffMidTurn(worker({ status: 'stopped', turnOpenSince: '2026-09-26T10:00:00Z', lastActivityAt: '2026-09-26T10:05:00Z' }), true, now), false, 'finished days ago');
  assert.equal(cutOffMidTurn(worker({ status: 'idle' }), true, now), false);
  assert.equal(cutOffMidTurn({ ...worker({ status: 'running' }), kind: 'standing' }, true, now), false);
  // 2026-09-29, M5: the portal's mark and a fresh activity time are not enough; the daemon must have had it live.
  assert.equal(cutOffMidTurn(worker({ status: 'error', turnOpenSince: '2026-09-29T01:15:00Z' }), false, now), false, 'not live on the link that dropped');
  assert.equal(cutOffMidTurn(worker({ status: 'running', stoppedOnPurpose: true }), true, now), false, 'stopped on purpose');
  // At boot, a stale mark on an agent idle for days goes (else the next restart's resume file resumes it); a fresh one stays.
  const stale = { id: 's1', machineId: 'mx', turnOpenSince: '2026-09-20T10:00:00Z', lastActivityAt: '2026-09-20T10:05:00Z' } as SessionInfo;
  const fresh = { id: 's2', machineId: 'mx', turnOpenSince: '2026-09-29T11:50:00Z', lastActivityAt: '2026-09-29T11:58:00Z' } as SessionInfo;
  assert.ok(mm.restore(stale, now) && mm.restore(fresh, now));
  assert.equal(stale.turnOpenSince, undefined);
  assert.equal(fresh.turnOpenSince, '2026-09-29T11:50:00Z');

  const reports: string[] = [];
  mm.report = (text) => reports.push(text);
  const d1 = daemon();
  await until('online', () => mm.isOnline('mx'));
  // A turn that finished: the daemon clears its mark, and the portal's copy must follow (JSON drops undefined fields).
  const done = mm.createSession('mx', { kind: 'worker', title: 'done', permissionMode: 'default' });
  sessions.send(done.info.id, 'quick');
  await until('finished', () => done.info.status === 'idle');
  assert.equal(done.info.turnOpenSince, undefined, 'the finished turn is not left marked');
  // An old agent as the portal's state has them after the bug: stopped days ago, the mark still set.
  const old = mm.createSession('mx', { kind: 'worker', title: 'old', permissionMode: 'default' });
  Object.assign(old.info, { status: 'stopped', turnOpenSince: '2026-09-20T10:00:00Z', lastActivityAt: '2026-09-20T10:05:00Z' });
  store.putSession(old.info);
  const users = (id: string) => store.readTranscript(id).filter((e) => e.kind === 'user').length;

  mm.expectDrop('mx', 'was redeployed (add_machine with force)');
  d1.shutdown();
  await until('offline', () => !mm.isOnline('mx'));
  assert.equal(old.info.turnOpenSince, undefined, 'a drop clears marks, so the next drop cannot find them again');
  daemon();
  await until('online again', () => mm.isOnline('mx'));
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(users(done.info.id), 1, 'a finished agent is not resumed');
  assert.equal(users(old.info.id), 0, 'an old agent is not resumed');
  assert.ok(!reports.some((r) => /resumed/.test(r)), reports.join('\n'));
});

/** A process that ignores a stop on purpose (a stuck CLI, a stop that never reached it); a daemon going down still ends it. */
class StubbornAgent extends FakeAgent {
  override stop(onPurpose = true) {
    if (!onPurpose) super.stop(false);
  }
}

test('machine: redeploying an outdated daemon resumes only the agent live mid-turn on it, not finished ones the portal still marks (8 on M5, 2026-09-29)', async (t) => {
  const { store, sessions, mm, daemon, cleanup } = await setup();
  t.after(cleanup);
  RESUME_DELAY_MS.value = 50;
  t.after(() => (RESUME_DELAY_MS.value = 3000));
  const reports: string[] = [];
  mm.report = (text) => reports.push(text);
  const deployed: string[] = [];
  mm.deployMachine = ((o: { id: string }) => (deployed.push(o.id), store.machines.get(o.id)!)) as typeof mm.deployMachine;
  const d1 = daemon();
  await until('online', () => mm.isOnline('mx') && !!store.machines.get('mx')?.info);
  const users = (id: string) => store.readTranscript(id).filter((e) => e.kind === 'user').length;

  // The one agent really mid-turn on the daemon.
  const busy = mm.createSession('mx', { kind: 'worker', title: 'busy', permissionMode: 'default' });
  sessions.send(busy.info.id, 'long build');
  await until('mid-turn', () => busy.info.status === 'running' && busy.live);

  // Agents that finished hours ago, as the portal had them: the daemon (restarted since) no longer holds them, so
  // nothing ever cleared their turn mark, and refused resumes kept moving their activity time.
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
  const refused = "already 3 agents running in this machine's main clone";
  const old = [0, 1, 2].map((n) => {
    const h = mm.createSession('mx', { kind: 'worker', title: `old ${n}`, permissionMode: 'default' });
    Object.assign(h.info, { status: 'error', statusDetail: refused, turnOpenSince: hoursAgo(13), lastActivityAt: hoursAgo(3), ...(n ? { backgroundTasks: 1 } : {}) });
    store.putSession(h.info);
    return h;
  });
  // A refused start (the daemon's 'failed') is not activity: it no longer makes an old agent look recent.
  const onMessage = (msg: unknown) => (mm as unknown as { onMessage(id: string, msg: unknown): void }).onMessage('mx', msg);
  const before = old[0].info.lastActivityAt;
  onMessage({ type: 'failed', sessionId: old[0].info.id, error: refused });
  assert.equal(old[0].info.lastActivityAt, before, 'a refusal does not move the activity time');
  assert.equal(store.readTranscript(old[0].info.id).at(-1)?.kind, 'error', 'the refusal is still in its transcript');
  // An outdated daemon may report an agent it holds with a stale mark and a fresh time, but not live.
  onMessage({ type: 'session', info: { ...old[1].info, status: 'stopped', turnOpenSince: hoursAgo(13), lastActivityAt: new Date().toISOString() }, live: false });
  assert.equal(old[1].live, false);

  // The daemon turns out to be outdated (the portal was updated): with an agent running, it waits.
  mm.portalHead = '5b181de0123456789abcdef0123456789abcdef0';
  onMessage({ type: 'hello', protocol: PROTOCOL_VERSION, home: '', live: [busy.info.id], info: { ...store.machines.get('mx')!.info, daemon: 'dd72bd0' } });
  assert.ok(mm.outdated('mx'));
  assert.deepEqual(deployed, [], 'not redeployed while an agent runs');

  // Then it is redeployed (no expectDrop: the portal only sees the link drop) and a current daemon connects.
  d1.shutdown();
  await until('offline', () => !mm.isOnline('mx'));
  const cut = (mm as unknown as { cutOff: Map<string, { sessions: string[] }> }).cutOff.get('mx');
  assert.deepEqual(cut?.sessions, [busy.info.id], 'only the agent live mid-turn on the dropped link is noted');
  mm.portalHead = undefined;
  daemon();
  await until('resumed', () => users(busy.info.id) === 2, 8000);
  await new Promise((r) => setTimeout(r, 300));
  for (const h of old) assert.equal(users(h.info.id), 0, `${h.info.title} is not resumed`);
  const resumed = reports.filter((r) => /resume/.test(r));
  assert.equal(resumed.length, 1, resumed.join('\n'));
  assert.match(resumed[0], new RegExp(`mx is back after its daemon lost its connection to the portal; resumed 1 agent\\(s\\) that were mid-turn: ${busy.info.id}\\.$`));
});

test('machine: an agent stopped with stop_agent is never resumed by a dropped link, whenever the stop came (2026-09-29)', async (t) => {
  const { store, sessions, mm, daemon, cleanup } = await setup();
  t.after(cleanup);
  RESUME_DELAY_MS.value = 50;
  t.after(() => (RESUME_DELAY_MS.value = 3000));
  const reports: string[] = [];
  mm.report = (text) => reports.push(text);
  const users = (id: string) => store.readTranscript(id).filter((e) => e.kind === 'user').length;

  // 1. Stopped while online, but its process did not end (the daemon still reports it live and mid-turn).
  const d1 = daemon(undefined, StubbornAgent);
  await until('online', () => mm.isOnline('mx'));
  const s = mm.createSession('mx', { kind: 'worker', title: 'w', permissionMode: 'default' });
  sessions.send(s.info.id, 'long build');
  await until('mid-turn', () => s.info.status === 'running' && s.live);
  sessions.get(s.info.id).stop(); // what stop_agent does
  assert.equal(s.info.stoppedOnPurpose, true);
  assert.equal(store.sessions.get(s.info.id)?.stoppedOnPurpose, true, 'saved: a portal restart keeps it');
  assert.equal(s.info.turnOpenSince, undefined);
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(s.live, 'the stubborn process is still live');
  // A portal restart's resume file skips it too.
  assert.deepEqual(collectResume([{ ...snapshotOf(s), status: 'running' }]), []);
  mm.expectDrop('mx', 'was redeployed (add_machine with force)');
  d1.shutdown();
  await until('offline', () => !mm.isOnline('mx'));
  const d2 = daemon();
  await until('online again', () => mm.isOnline('mx'));
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(users(s.info.id), 1, 'not resumed after its daemon was redeployed');

  // 2. Cut off mid-turn by a restart, then stopped while the daemon was down: not resumed when it is back.
  sessions.send(s.info.id, 'long again');
  assert.equal(s.info.stoppedOnPurpose, undefined, 'a new message ends the stop');
  await until('mid-turn again', () => s.info.status === 'running' && s.live);
  mm.expectDrop('mx', 'was restarted (machine_daemon restart)');
  d2.shutdown();
  await until('offline again', () => !mm.isOnline('mx'));
  const cutOff = (mm as unknown as { cutOff: Map<string, { sessions: string[] }> }).cutOff;
  assert.deepEqual(cutOff.get('mx')?.sessions, [s.info.id], 'noted as cut off');
  sessions.get(s.info.id).stop();
  const d3 = daemon();
  await until('back', () => mm.isOnline('mx'));
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(users(s.info.id), 2, 'a stop after the drop still holds');
  assert.ok(!reports.some((r) => /resumed/.test(r)), reports.join('\n'));

  // 3. Messaged again, it is an ordinary agent: a later cut-off resumes it.
  sessions.send(s.info.id, 'long third');
  await until('mid-turn a third time', () => s.info.status === 'running' && s.live);
  mm.expectDrop('mx', 'was restarted (machine_daemon restart)');
  d3.shutdown();
  await until('offline a third time', () => !mm.isOnline('mx'));
  daemon();
  await until('resumed', () => users(s.info.id) === 4, 8000);
});

test('machine: a daemon that connects during its own install counts as connected, and a connected daemon is never shown in error (m5, 2026-09-29)', async (t) => {
  const { store, mm, daemon, cleanup } = await setup();
  t.after(cleanup);
  mm.deployWaitMs = { settle: 50, poll: 20 };
  const result = { platform: 'darwin' as const, home: '/Users/x', repoPath: '/Users/x/game', node: '/usr/local/bin/node', nodeVersion: 'v22', version: 'abc1234' };

  // launchd starts the new daemon inside the install step: it connects before the ssh session returns.
  mm.deployer = async (o) => {
    o.step?.('copying code');
    o.step?.('installing');
    daemon(o.token); // a deploy mints the daemon a new token
    await until('the new daemon connected', () => mm.isOnline('mx') && !!store.machines.get('mx')?.info);
    await new Promise((r) => setTimeout(r, 100));
    return result;
  };
  mm.deployMachine({ id: 'mx' });
  await until('settled', () => store.machines.get('mx')!.status !== 'deploying');
  assert.equal(store.machines.get('mx')!.status, 'ready', String(store.machines.get('mx')!.statusDetail));
  assert.equal(store.machines.get('mx')!.statusDetail, undefined);

  // An install or connection error from before (the state m5 was left in): its daemon's next hello clears it.
  mm.update('mx', { status: 'error', statusDetail: 'installed, but the daemon has not connected to https://beast.example.ts.net; see ~/.ff-factory/logs/daemon.log on mx' });
  (mm as unknown as { links: Map<string, { ws: { terminate(): void } }> }).links.get('mx')!.ws.terminate();
  await until('back', () => mm.isOnline('mx') && store.machines.get('mx')!.status === 'ready', 8000);
  assert.equal(store.machines.get('mx')!.statusDetail, undefined);

  // A redeploy that fails while the old daemon still runs: the machine works, the failure stays in view.
  mm.deployer = async () => {
    throw new Error('install on mx failed: exit code 5; stderr: Bootstrap failed: 5: Input/output error');
  };
  mm.deployMachine({ id: 'mx' });
  await until('failed', () => store.machines.get('mx')!.status !== 'deploying');
  assert.equal(store.machines.get('mx')!.status, 'ready');
  assert.match(store.machines.get('mx')!.statusDetail ?? '', /^the last redeploy failed, so the previous daemon is still the one running: install on mx failed/);
});

test('machine: a deploy cut short by a portal restart is not left "deploying" (the offline watch would skip it forever)', async (t) => {
  const { store, sessions, mm, daemon, cleanup, tmp } = await setup();
  t.after(cleanup);
  mm.update('mx', { status: 'deploying', statusDetail: 'npm ci' });
  store.flush();
  // The next portal process: a new Store and MachineManager over the same data folder.
  const cfg = { dataDir: tmp, limits: { maxSessions: 6 }, repo: { url: 'x' }, worker: { effort: 'high' } } as unknown as Config;
  const store2 = new Store(tmp);
  const mm2 = new MachineManager(cfg, store2, new SessionManager(cfg, store2));
  assert.equal(store2.machines.get('mx')!.status, 'error');
  assert.match(store2.machines.get('mx')!.statusDetail ?? '', /a portal restart interrupted its deploy \(at: npm ci\)/);
  void sessions;
  void mm2;
  // And a daemon saying hello clears a stale 'deploying' too (no deploy runs in this process).
  mm.update('mx', { status: 'deploying', statusDetail: 'installing' });
  daemon();
  await until('ready', () => mm.isOnline('mx') && store.machines.get('mx')!.status === 'ready');
});

const posixSh = process.platform !== 'win32' && fs.existsSync('/bin/sh');

test('machine deploy (mac): the LaunchAgent reload waits for bootout and retries bootstrap (m3 "Bootstrap failed: 5", 2026-09-29)', { skip: !posixSh && 'needs a POSIX sh' }, async () => {
  const { execFileSync, spawnSync } = await import('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-launchctl-'));
  try {
    // A launchctl whose old service lingers for `linger` prints after bootout, and whose bootstrap fails with 5
    // while it is loaded, and `failFirst` more times after; sleep returns at once.
    const fake = (linger: number, failFirst: number) => {
      fs.writeFileSync(path.join(dir, 'linger'), String(linger));
      fs.writeFileSync(path.join(dir, 'fail'), String(failFirst));
      fs.writeFileSync(path.join(dir, 'log'), '');
    };
    fs.writeFileSync(
      path.join(dir, 'launchctl'),
      `#!/bin/sh
D=${JSON.stringify(dir)}
echo "$1" >> "$D/log"
L=$(cat "$D/linger"); F=$(cat "$D/fail")
case "$1" in
  print) if [ "$L" -gt 0 ]; then echo $((L-1)) > "$D/linger"; exit 0; fi; exit 113 ;;
  bootout) exit 0 ;;
  bootstrap)
    if [ "$L" -gt 0 ] || [ "$F" -gt 0 ]; then echo $((F-1)) > "$D/fail"; echo "Bootstrap failed: 5: Input/output error" >&2; exit 5; fi
    echo ok >> "$D/log"; exit 0 ;;
esac
`,
      { mode: 0o755 },
    );
    fs.writeFileSync(path.join(dir, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const script = `set -e\n${macReloadLines('gui/501')}echo done\n`;
    const run = () => spawnSync('/bin/sh', ['-c', script], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, HOME: dir }, encoding: 'utf8' });
    const log = () => fs.readFileSync(path.join(dir, 'log'), 'utf8').trim().split('\n');

    // The old daemon takes a few seconds to go: no bootstrap until it has.
    fake(3, 0);
    let r = run();
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(log(), ['bootout', 'print', 'print', 'print', 'print', 'bootstrap', 'ok']);
    // A bootstrap refused anyway is retried.
    fake(0, 2);
    r = run();
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(log().filter((l) => l === 'bootstrap').length, 3);
    // Still refused after five tries: the install fails loudly (set -e), as before.
    fake(0, 99);
    r = run();
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /launchctl bootstrap failed 5 times/);
    assert.equal(log().filter((l) => l === 'bootstrap').length, 5);
    void execFileSync;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('machine: agents finished days ago and stopped again and again are not resumed when the daemon comes back after being offline (m3, 4 agents, 2026-09-29)', async (t) => {
  const { store, sessions, mm, daemon, cleanup } = await setup();
  t.after(cleanup);
  RESUME_DELAY_MS.value = 50;
  t.after(() => (RESUME_DELAY_MS.value = 3000));
  const reports: string[] = [];
  mm.report = (text) => reports.push(text);
  const d1 = daemon();
  await until('online', () => mm.isOnline('mx'));
  const users = (id: string) => store.readTranscript(id).filter((e) => e.kind === 'user').length;
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
  // As on m3: finished days ago, the daemon (restarted since) does not hold them, the portal's mark never cleared,
  // refused resumes (05:43, 10:44) moved their activity time, and stop_agent was called on each, several times.
  const old = [0, 1, 2, 3].map((n) => {
    const h = mm.createSession('mx', { kind: 'worker', title: `old ${n}`, permissionMode: 'default' });
    Object.assign(h.info, { status: 'error', statusDetail: "already 3 agents running in this machine's main clone", turnOpenSince: hoursAgo(60), lastActivityAt: hoursAgo(4) });
    store.putSession(h.info);
    for (let i = 0; i < 3; i++) sessions.get(h.info.id).stop();
    return h;
  });
  for (const h of old) {
    assert.equal(h.info.stoppedOnPurpose, true);
    assert.equal(h.info.turnOpenSince, undefined, 'stop_agent clears the mark the portal holds, not only the daemon');
  }
  // The daemon goes (a failed redeploy), the machine is offline a while, the offline watch redeploys it, it is back.
  d1.shutdown();
  await until('offline', () => !mm.isOnline('mx'));
  assert.equal((mm as unknown as { cutOff: Map<string, unknown> }).cutOff.has('mx'), false, 'nothing noted as cut off');
  daemon();
  await until('back', () => mm.isOnline('mx'));
  await new Promise((r) => setTimeout(r, 300));
  for (const h of old) assert.equal(users(h.info.id), 0, `${h.info.title} is not resumed`);
  assert.ok(!reports.some((r) => /resume/.test(r)), reports.join('\n'));
});
