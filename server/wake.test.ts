import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { COMPILE_DONE, COMPILE_FAILED, readSince, Waker } from './wake.ts';
import { collectResume, waitingOnWakeLine, type SessionSnapshot } from './restart.ts';
import { Store } from './store.ts';
import type { SessionManager } from './sessions.ts';
import type { SessionInfo } from '../shared/types.ts';

const info = (id: string, over: Partial<SessionInfo> = {}): SessionInfo => ({
  id,
  kind: 'worker',
  title: id,
  status: 'idle',
  permissionMode: 'default',
  createdAt: '',
  lastActivityAt: new Date().toISOString(),
  turns: 0,
  costUsd: 0,
  pendingPermissions: [],
  ...over,
});

function setup(t: { after: (fn: () => void) => void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-wake-'));
  const store = new Store(dir);
  const sent: { id: string; text: string }[] = [];
  const sessions = {
    sessions: new Map([['w1', {}], ['orch', {}]]),
    get: (id: string) => {
      if (!['w1', 'orch'].includes(id)) throw new Error(`no session "${id}"`);
      return {};
    },
    send: (id: string, text: string) => (sent.push({ id, text }), 'u'),
  } as unknown as SessionManager;
  const w = new Waker(sessions, store);
  let now = 1_000_000;
  w.now = () => now;
  t.after(() => {
    store.flush();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { w, store, sent, advance: (ms: number) => (now += ms) };
}

test('wake_me: the note comes back after N minutes; a new wake replaces the old; cancel works', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { w, sent } = setup(t);
  assert.match(w.schedule('w1', 30, 'check the build'), /\(30 min\)/);
  t.mock.timers.tick(29 * 60_000);
  assert.equal(sent.length, 0);
  w.schedule('w1', 5, 'actually check the tests');
  t.mock.timers.tick(5 * 60_000);
  assert.deepEqual(sent, [{ id: 'w1', text: '[wake_me] Time is up. Your note: actually check the tests' }]);
  t.mock.timers.tick(60 * 60_000);
  assert.equal(sent.length, 1, 'the replaced wake never fires');
  w.schedule('orch', 10, 'x');
  assert.equal(w.cancel('orch'), true);
  t.mock.timers.tick(20 * 60_000);
  assert.equal(sent.length, 1);
  assert.throws(() => w.schedule('w1', 0, 'x'), /minutes/);
  assert.throws(() => w.schedule('nope', 5, 'x'), /no session/);
});

test('heartbeat: only while a worker is busy, every N minutes, never over a busy orchestrator', (t) => {
  const { w, store, sent, advance } = setup(t);
  const beat = (m: number | null) => w.heartbeat('orch', m, (s) => `${s.id} ${s.status}`);
  store.putSession(info('orch', { kind: 'orchestrator' }));
  store.putSession(info('w1'));
  beat(15);
  advance(60 * 60_000);
  beat(15);
  assert.equal(sent.length, 0, 'everything idle: no wakes');

  store.putSession(info('w1', { status: 'running' }));
  beat(15); // busy starts now
  advance(14 * 60_000);
  beat(15);
  assert.equal(sent.length, 0);
  advance(60_000);
  beat(15);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /^\[heartbeat\] 1 worker\(s\) busy:\n- w1 running/);

  advance(15 * 60_000);
  store.putSession(info('orch', { kind: 'orchestrator', status: 'running' }));
  beat(15);
  assert.equal(sent.length, 1, 'the orchestrator is mid-turn: skipped');
  store.putSession(info('orch', { kind: 'orchestrator', status: 'idle' }));
  beat(15);
  assert.equal(sent.length, 2);
  advance(30 * 60_000);
  beat(null);
  assert.equal(sent.length, 2, 'off');
});

test('wait_for_unity: compile markers and reading only what the log gained', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-log-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const log = path.join(dir, 'Editor.log');
  fs.writeFileSync(log, 'old stuff\nReloading assemblies after finishing script compilation.\n');
  const start = readSince(log, 0).size;
  fs.appendFileSync(log, 'Assets/Scripts/Belt.cs(12,5): error CS1002: ; expected\n');
  const r = readSince(log, start);
  assert.ok(COMPILE_FAILED.test(r.text));
  assert.ok(!COMPILE_DONE.test(r.text), 'the earlier reload is not in the new part');
  assert.ok(COMPILE_DONE.test('Domain Reload Profiling: 1234ms'));
  assert.equal(readSince(path.join(dir, 'missing.log'), 0).size, 0);
  assert.equal(readSince(log, 10_000_000).text.length > 0, true, 'a shorter log (editor restarted) is read from the start');
});

test('wake_me: pending wakes survive a restart; one that came due while the server was down fires at once', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-wakes-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'wakes.json');
  const store = new Store(dir);
  const sent: { id: string; text: string }[] = [];
  let refuse = 0;
  const sessions = {
    sessions: new Map([['w1', {}], ['w2', {}], ['orch', {}]]),
    get: () => ({}),
    send: (id: string, text: string) => {
      if (refuse > 0 && refuse--) throw new Error('already 6 agents running');
      sent.push({ id, text });
      return 'u';
    },
  } as unknown as SessionManager;
  let now = 1_000_000;
  const before = new Waker(sessions, store, file);
  before.now = () => now;
  before.schedule('w1', 10, 'check the build');
  before.schedule('w2', 60, 'check CI');
  before.schedule('orch', 30, 'see how the belt fix is going');
  before.schedule('gone', 5, 'a session deleted before the restart');
  before.cancel('orch');
  before.schedule('orch', 30, 'see how the belt fix is going');
  // The server stops (an update or a crash): its timers are gone with it. It comes back 20 minutes later.
  t.mock.timers.reset();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  now += 20 * 60_000;
  const after = new Waker(sessions, store, file);
  after.now = () => now;
  assert.equal(after.restore(), 3);
  t.mock.timers.tick(0);
  assert.deepEqual(sent, [{ id: 'w1', text: '[wake_me] Time is up (10 min late: SketchUp Factory was restarting). Your note: check the build' }]);
  assert.equal(after.pending('w2')?.note, 'check CI');
  t.mock.timers.tick(10 * 60_000);
  assert.equal(sent.at(-1)?.id, 'orch');
  assert.equal(sent.at(-1)?.text, '[wake_me] Time is up. Your note: see how the belt fix is going');
  // At the agent limit it tries again a minute later instead of dropping the wake.
  refuse = 1;
  t.mock.timers.tick(30 * 60_000);
  assert.equal(sent.at(-1)?.id, 'orch');
  t.mock.timers.tick(60_000);
  assert.equal(sent.at(-1)?.text, '[wake_me] Time is up. Your note: check CI');
  // Everything fired: nothing is left to re-arm.
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {});
  store.flush();
});

test("heartbeat per person: each orchestrator hears only its person's busy workers, on its own clock", (t) => {
  const { w, store, sent, advance } = setup(t);
  const describe = (s: SessionInfo) => `${s.id} ${s.status}`;
  const mine = (who: string) => (s: SessionInfo) => s.requestedBy?.userId === who;
  store.putSession(info('ben-chat', { kind: 'orchestrator' }));
  store.putSession(info('loth-chat', { kind: 'orchestrator' }));
  store.putSession(info('w1', { status: 'running', requestedBy: { userId: 'ben', displayName: 'Ben' } }));
  const beat = () => {
    w.heartbeat('ben-chat', 15, describe, mine('ben'));
    w.heartbeat('loth-chat', 15, describe, mine('lothsahn'));
  };
  beat();
  advance(15 * 60_000);
  beat();
  assert.deepEqual(
    sent.map((x) => x.id),
    ['ben-chat'],
    "Lothsahn's orchestrator is not woken for Ben's worker",
  );
  assert.match(sent[0].text, /^\[heartbeat\] 1 worker\(s\) busy:\n- w1 running/);
  // Lothsahn's worker starts now: his clock starts now too.
  store.putSession(info('w2', { status: 'running', requestedBy: { userId: 'lothsahn', displayName: 'Lothsahn' } }));
  beat();
  advance(14 * 60_000);
  beat();
  assert.equal(sent.filter((x) => x.id === 'loth-chat').length, 0);
  advance(60_000);
  beat();
  assert.deepEqual(
    sent.map((x) => x.id),
    ['ben-chat', 'ben-chat', 'loth-chat'],
  );
  assert.match(sent[2].text, /- w2 running/);
  assert.doesNotMatch(sent[2].text, /w1/);
});

// w311 (2026-10-03): f6b32781 on lothdesktop/pr-fix ended its turn at 21:46:53 with a 21-minute wake (due 22:07:36). The
// d60dcf1b deploy stopped the portal at 22:04:30. It was on neither list of the [app restarted] report: idle, it was
// rightly not resumed, and its wake fired on time, but nothing said so and it looked stopped and forgotten.
test('w311: an idle machine worker waiting on a wake_me is not resumed, is named in the restart report, and its wake fires', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-w311-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'wakes.json');
  const store = new Store(dir);
  const sent: { id: string; text: string }[] = [];
  const worker = info('f6b32781', { machineId: 'lothdesktop', machineSandbox: 'pr-fix', sandboxId: undefined, title: 'Enemy attacks deep dive (w283)', status: 'stopped' });
  const sessions = {
    sessions: new Map([['f6b32781', { info: worker }]]),
    get: () => ({}),
    send: (id: string, text: string) => {
      sent.push({ id, text });
      return 'u';
    },
  } as unknown as SessionManager;
  let now = Date.parse('2026-10-03T21:46:36Z');
  const before = new Waker(sessions, store, file);
  before.now = () => now;
  before.schedule('f6b32781', 21, 'w283: run2 should be near 20 game min');
  // The restart: the old server's timers die, the new one restores from wakes.json.
  t.mock.timers.reset();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  now = Date.parse('2026-10-03T22:05:30Z');
  const after = new Waker(sessions, store, file);
  after.now = () => now;
  assert.equal(after.restore(), 1);
  // Not resumed: between turns, no marks, no unanswered message, no drain.
  const snap: SessionSnapshot = { id: 'f6b32781', kind: 'worker', title: worker.title, machineId: 'lothdesktop', status: 'stopped', unanswered: [], lastFrom: 'orchestrator' };
  assert.deepEqual(collectResume([snap], new Set()), []);
  // But the report names it, with where and when.
  const line = waitingOnWakeLine(after.all(), (id) => sessions.sessions.get(id)?.info, new Set(), now);
  assert.match(line ?? '', /^Between turns, waiting on their wake_me \(kept across the restart; it wakes them, nothing to resume\): "Enemy attacks deep dive \(w283\)" \(f6b32781 on lothdesktop\/pr-fix\) at .+ \(in 2 min\)\.$/);
  // A worker the report already lists as resumed, an orchestrator or an unknown session is left out.
  assert.equal(waitingOnWakeLine(after.all(), (id) => sessions.sessions.get(id)?.info, new Set(['f6b32781']), now), undefined);
  assert.equal(waitingOnWakeLine([{ sessionId: 'x', at: now }], () => ({ title: 'd', kind: 'orchestrator' }), new Set(), now), undefined);
  // And the wake fires on time.
  t.mock.timers.tick(2 * 60_000 + 6_000);
  assert.deepEqual(sent, [{ id: 'f6b32781', text: '[wake_me] Time is up. Your note: w283: run2 should be near 20 game min' }]);
  store.flush();
});
