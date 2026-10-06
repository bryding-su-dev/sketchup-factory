import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import webpush from 'web-push';
import { Notifier, sessionRoute } from './notify.ts';
import { Store, bus } from './store.ts';
import { SessionManager } from './sessions.ts';
import type { Config } from './config.ts';
import type { Sandbox, ServerEvent, SessionInfo, StandingAgent, StandingRun } from '../shared/types.ts';

const info = (over: Partial<SessionInfo>): SessionInfo => ({
  id: 's1',
  kind: 'worker',
  title: 'Belt fix',
  status: 'running',
  permissionMode: 'default',
  createdAt: '',
  lastActivityAt: '',
  turns: 0,
  costUsd: 0,
  pendingPermissions: [],
  ...over,
});

function setup(t: { after: (fn: () => void) => void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-notify-'));
  const store = new Store(dir);
  const sessions = new SessionManager({ limits: { maxSessions: 6 } } as Config, store);
  const n = new Notifier(dir, store, sessions);
  const sent: { endpoint: string; payload: { kind: string; title: string; url: string } }[] = [];
  const real = webpush.sendNotification;
  let fail = 0;
  (webpush as { sendNotification: unknown }).sendNotification = async (sub: { endpoint: string }, payload: string) => {
    if (fail) throw Object.assign(new Error('gone'), { statusCode: fail });
    sent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) });
  };
  const notices: string[] = [];
  const onBus = (e: ServerEvent) => e.type === 'notify' && notices.push(`${e.notice.kind}:${e.notice.title}`);
  bus.on('event', onBus);
  t.after(() => {
    (webpush as { sendNotification: unknown }).sendNotification = real;
    bus.off('event', onBus);
    store.flush();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { n, store, sessions, sent, notices, setFail: (c: number) => (fail = c) };
}

const sub = (id: string) => ({ endpoint: `https://push.example/${id}`, keys: { p256dh: 'p', auth: 'a' } });
const flush = () => new Promise((r) => setImmediate(r));

test('notify: events become notices, pushed to each device that wants that kind', async (t) => {
  const { n, store, sessions, sent, notices } = setup(t);
  assert.ok(n.publicKey.length > 40, 'VAPID keys made on first boot');
  n.subscribe('alice', sub('phone'), { turnEnd: false }, 'Safari on iPhone');
  n.subscribe('alice', sub('desk'), {}, 'Edge on Windows');

  const h = { info: info({}) };
  sessions.events.emit('permission', h, { toolName: 'Bash', input: {} });
  sessions.events.emit('turnEnd', h, '## Fixed the belt\nDetails');
  store.putSession(info({ status: 'error', statusDetail: 'CLI crashed' }));
  n.standingRun({ id: 'rev', name: 'Reviewer' } as StandingAgent, { outcome: 'budget', summary: 'Stopped at $2' } as StandingRun);
  n.standingRun({ id: 'rev', name: 'Reviewer' } as StandingAgent, { outcome: 'ok', summary: 'fine' } as StandingRun);
  await flush();

  assert.deepEqual(notices, ['permission:Belt fix needs you', 'turnEnd:Belt fix finished', 'error:Belt fix hit an error', 'standing:Reviewer hit its budget']);
  const to = (d: string) => sent.filter((s) => s.endpoint.endsWith(d)).map((s) => s.payload.kind);
  assert.deepEqual(to('phone'), ['permission', 'error', 'standing'], 'the phone turned "turn finished" off');
  assert.deepEqual(to('desk'), ['permission', 'turnEnd', 'error', 'standing']);
  assert.equal(sent[0].payload.url, '#/session/s1');
});

test('notify: an automatic compaction (w535) is no finished turn; a person\'s /compact still says it is done', async (t) => {
  const { sessions, notices } = setup(t);
  const h = { info: info({}) };
  sessions.events.emit('turnEnd', h, 'Echo: the last reply', { compaction: 'tokens' });
  sessions.events.emit('turnEnd', h, 'Echo: the last reply', { compaction: 'self' });
  sessions.events.emit('turnEnd', h, 'Compacted the conversation (the context was 276,366 tokens).', { compaction: 'person' });
  await flush();
  assert.deepEqual(notices, ['turnEnd:Belt fix finished']);
});

test('notify: a subscription the push service says is gone is dropped; bad subscriptions are refused', async (t) => {
  const { n, sessions, setFail } = setup(t);
  n.subscribe('alice', sub('old'), {}, 'x');
  setFail(410);
  sessions.events.emit('permission', { info: info({}) }, { toolName: 'Bash', input: {} });
  await flush();
  await flush();
  assert.equal(n.list('alice').length, 0);
  assert.throws(() => n.subscribe('alice', { endpoint: 'http://insecure' }, {}, 'x'), /not a push subscription/);
  assert.throws(() => n.setPrefs('https://nope', {}), /no such subscription/);
});

test('notify: click targets', () => {
  assert.equal(sessionRoute(info({ sandboxId: 'sb1' })), '#/sandbox/sb1/s1');
  assert.equal(sessionRoute(info({ machineId: 'm5' })), '#/machine/m5/s1');
  assert.equal(sessionRoute(info({ standingId: 'rev', kind: 'standing' })), '#/agent/rev/conversation');
  assert.equal(sessionRoute(info({ kind: 'orchestrator' })), '#/');
});

test('notify: a stuck Unity editor, and devices that subscribed before the kind existed get it', async (t) => {
  const { n, sent, notices } = setup(t);
  n.subscribe('alice', sub('phone'), {}, 'x');
  n.subscribe('alice', sub('quiet'), { unity: false }, 'y');
  n.unityBlocked({ id: 'sb1', purpose: 'Black hole shader' } as Sandbox, { reason: 'dialog', title: 'Enter Safe Mode?', text: 'The project you are opening\ncontains compilation errors.', since: '', resumeState: 'starting' });
  await flush();
  assert.deepEqual(notices, ['unity:Unity in Black hole shader (slot sb1) is stuck']);
  assert.deepEqual(sent.map((s) => [s.endpoint.split('/').pop(), s.payload.url]), [['phone', '#/sandbox/sb1']]);
  assert.match((sent[0].payload as { body?: string }).body ?? '', /^"Enter Safe Mode\?": The project you are opening contains/);
});

test('notify: saved subscriptions without a newer kind start at its default', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-notify-old-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const old = { ...sub('old'), user: 'alice', prefs: { permission: true, turnEnd: false, error: true, standing: true, delegation: true }, createdAt: '', device: 'x' };
  fs.writeFileSync(path.join(dir, 'push-subscriptions.json'), JSON.stringify([old]));
  const store = new Store(dir);
  const n = new Notifier(dir, store, new SessionManager({ limits: { maxSessions: 6 } } as Config, store));
  assert.deepEqual(n.list('alice')[0].prefs, { ...old.prefs, person: true, unity: true, host: true });
  store.flush();
});

test("notify: a person's own orchestrator, and a worker's finished turn, reach only the people they are for", async (t) => {
  const { n, sessions, sent } = setup(t);
  const seen: string[][] = [];
  const onBus = (e: ServerEvent) => e.type === 'notify' && seen.push(e.users ?? ['everyone']);
  bus.on('event', onBus);
  t.after(() => bus.off('event', onBus));
  n.subscribe('ben', sub('ben-phone'), {}, 'Safari on iPhone');
  n.subscribe('lothsahn', sub('loth-desk'), {}, 'Chrome on Windows');
  n.audience = (s, kind) => (s.orchestratorRole === 'personal' ? [s.requestedBy!.userId] : s.orchestratorRole === 'dispatcher' ? (kind === 'turnEnd' ? [] : ['ben']) : s.kind === 'worker' && kind === 'turnEnd' ? ['LothSahn'] : undefined);
  const emit = (over: Partial<SessionInfo>, event: 'turnEnd' | 'permission') => sessions.events.emit(event, { info: info(over) }, event === 'turnEnd' ? 'done' : { toolName: 'Bash', input: {} });

  emit({ id: 'p1', kind: 'orchestrator', orchestratorRole: 'personal', requestedBy: { userId: 'ben', displayName: 'Ben' } }, 'turnEnd');
  emit({ id: 'd1', kind: 'orchestrator', orchestratorRole: 'dispatcher' }, 'turnEnd');
  emit({ id: 'd1', kind: 'orchestrator', orchestratorRole: 'dispatcher' }, 'permission');
  emit({ id: 'w1', kind: 'worker', sandboxId: 'alpha' }, 'turnEnd');
  emit({ id: 'w1', kind: 'worker', sandboxId: 'alpha' }, 'permission');
  await flush();
  assert.deepEqual(
    sent.map((x) => `${x.endpoint.split('/').pop()} ${x.payload.title}`),
    ['ben-phone Your orchestrator finished', 'ben-phone The dispatcher needs you', 'loth-desk Belt fix finished', 'ben-phone Belt fix needs you', 'loth-desk Belt fix needs you'],
  );
  // Open pages hear only what is theirs; the dispatcher's own turns are nobody's news.
  assert.deepEqual(seen, [['ben'], ['ben'], ['LothSahn'], ['everyone']]);
  assert.equal(sessionRoute(info({ kind: 'orchestrator', orchestratorRole: 'dispatcher' })), '#/dispatcher/conversation');
  assert.equal(sessionRoute(info({ id: 'p1', kind: 'orchestrator', orchestratorRole: 'personal' })), '#/');
});

test('notify: a message from another person reaches only its recipient, and opens their chat', async (t) => {
  const { n, sent } = setup(t);
  const seen: string[][] = [];
  const onBus = (e: ServerEvent) => e.type === 'notify' && seen.push(e.users ?? ['everyone']);
  bus.on('event', onBus);
  t.after(() => bus.off('event', onBus));
  n.subscribe('ben', sub('ben-phone'), {}, 'Safari on iPhone');
  n.subscribe('lothsahn', sub('loth-desk'), {}, 'Chrome on Windows');
  n.subscribe('ben', sub('ben-quiet'), { person: false }, 'Firefox');
  n.personMessage({ userId: 'lothsahn', displayName: 'Lothsahn' }, { userId: 'ben', displayName: 'Ben' }, 'Deploy now or tonight?\nw22 is ready too.');
  await flush();
  assert.deepEqual(sent.map((x) => [x.endpoint.split('/').pop(), x.payload.kind, x.payload.title, (x.payload as { body?: string }).body, x.payload.url]), [['ben-phone', 'person', 'Message from Lothsahn', 'Deploy now or tonight?', '#/']]);
  assert.deepEqual(seen, [['ben']]);
});
