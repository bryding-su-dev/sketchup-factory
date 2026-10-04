import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { SessionManager, restartMarks, setQueryForTesting, snapshotOf, type SessionHandle } from './sessions.ts';
import { collectResume, resumeMessage } from './restart.ts';
import { Store, bus } from './store.ts';
import type { Config } from './config.ts';
import type { ServerEvent, SessionInfo, TranscriptEvent } from '../shared/types.ts';
import { RED_PNG, fakeQuery } from '../e2e/fakeAgent.ts';

/**
 * AgentSession end to end against the scripted fake SDK (e2e/fakeAgent.ts): the status a session
 * shows, what lands in its transcript, permission prompts, interrupts, stops and resumes, restore
 * after a restart, and the agent limit.
 */

const seen: { options: Options }[] = [];
const fake = fakeQuery({ stepMs: 1 });
setQueryForTesting(((args: { prompt: never; options: Options }) => {
  seen.push({ options: args.options });
  return fake(args);
}) as never);

function setup(t: { after: (fn: () => void | Promise<void>) => void }, maxSessions = 6, limits: Record<string, number> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-agent-'));
  const store = new Store(dir);
  t.after(async () => {
    sessions.stopAll();
    // Let the stopped sessions' last status updates land before the folder goes (the Store would
    // otherwise keep retrying a save into a deleted folder).
    await new Promise((r) => setTimeout(r, 50));
    store.flush();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  const sessions = new SessionManager({ limits: { maxSessions, ...limits } } as Config, store);
  const worker = (permissionMode: SessionInfo['permissionMode'] = 'bypassPermissions', kind: SessionInfo['kind'] = 'worker') =>
    sessions.create({ kind, title: 'w', permissionMode, options: () => ({ model: 'opus' }) });
  return { dir, store, sessions, worker };
}

/** Wait until `pred` holds (polling; the fake answers within milliseconds). */
async function until(pred: () => boolean, what: string, ms = 3000) {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const kinds = (evs: TranscriptEvent[]) => evs.map((e) => e.kind);
const texts = (store: Store, id: string) => store.readTranscript(id).map((e) => ('text' in e ? e.text : ''));

test('a message: starting, running, idle; the transcript and events a turn leaves', async (t) => {
  const { store, sessions, worker } = setup(t);
  const s = worker();
  const deltas: string[] = [];
  const onEvent = (e: ServerEvent) => e.type === 'delta' && e.sessionId === s.info.id && deltas.push(e.text);
  bus.on('event', onEvent);
  t.after(() => bus.off('event', onEvent));
  const turnEnds: string[] = [];
  sessions.events.on('turnEnd', (_h: SessionHandle, text: string) => turnEnds.push(text));

  assert.equal(s.live, false);
  sessions.send(s.info.id, 'hello there');
  assert.equal(s.live, true);
  assert.equal(s.info.status, 'running');
  await until(() => s.info.status === 'idle', 'idle');

  assert.deepEqual(kinds(store.readTranscript(s.info.id)), ['user', 'assistant', 'result']);
  assert.deepEqual(texts(store, s.info.id).slice(0, 2), ['hello there', 'Echo: hello there']);
  assert.equal(deltas.join(''), 'Echo: hello there');
  assert.deepEqual(turnEnds, ['Echo: hello there']);
  assert.equal(s.info.turns, 1);
  assert.ok(s.info.costUsd > 0);
  assert.equal(s.info.sdkSessionId?.startsWith('fake-'), true);
  assert.equal(s.info.lastResult, 'Echo: hello there');
  // Everything sent has been answered.
  assert.deepEqual(snapshotOf(s).unanswered, []);
  // The SDK was asked for streaming state events and partial messages, and never to prompt git.
  const opts = seen.at(-1)!.options;
  assert.equal(opts.includePartialMessages, true);
  assert.equal(opts.env?.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS, '1');
  assert.equal(opts.env?.GIT_TERMINAL_PROMPT, '0');
});

test('orchestrator messages are marked as such for the agent', async (t) => {
  const { store, sessions, worker } = setup(t);
  const s = worker();
  sessions.send(s.info.id, 'build it', 'orchestrator');
  await until(() => s.info.status === 'idle', 'idle');
  assert.equal(s.lastFrom, 'orchestrator');
  // Stored as sent (the UI shows who it came from), but the agent was told the sender.
  const [user, reply] = store.readTranscript(s.info.id);
  assert.deepEqual([user.kind, 'from' in user && user.from, 'text' in user && user.text], ['user', 'orchestrator', 'build it']);
  assert.equal('text' in reply && reply.text, 'Echo: build it');
});

test('permission: the prompt waits for the user; Allow runs the tool', async (t) => {
  const { store, sessions, worker } = setup(t);
  const s = worker('default');
  const asked: string[] = [];
  sessions.events.on('permission', (_h: SessionHandle, p: { toolName: string }) => asked.push(p.toolName));
  sessions.send(s.info.id, 'clean up #perm');
  await until(() => s.info.pendingPermissions.length === 1, 'the permission prompt');
  assert.equal(s.info.status, 'waiting_permission');
  assert.deepEqual(asked, ['Bash']);
  // Not answered yet: a restart now would have to resume it.
  assert.deepEqual(snapshotOf(s).unanswered, [{ text: 'clean up #perm', from: 'human' }]);

  const p = s.info.pendingPermissions[0];
  assert.equal(s.decide('no-such-request', true), false);
  assert.equal(s.decide(p.requestId, true), true);
  await until(() => s.info.status === 'idle', 'idle');
  assert.deepEqual(s.info.pendingPermissions, []);
  const perm = store.readTranscript(s.info.id).find((e) => e.kind === 'permission');
  assert.equal(perm && 'decision' in perm && perm.decision, 'allow');
  assert.ok(texts(store, s.info.id).includes('Allowed: I cleaned the build folder.'));
  // A decision is final.
  assert.equal(s.decide(p.requestId, false), false);
});

test('permission: Deny tells the agent why', async (t) => {
  const { store, sessions, worker } = setup(t);
  const s = worker('default');
  sessions.send(s.info.id, '#perm');
  await until(() => s.info.pendingPermissions.length === 1, 'the permission prompt');
  s.decide(s.info.pendingPermissions[0].requestId, false, 'not today');
  await until(() => s.info.status === 'idle', 'idle');
  const result = store.readTranscript(s.info.id).find((e) => e.kind === 'tool_result');
  assert.equal(result && 'text' in result && result.text, 'Permission denied: not today');
  assert.ok(texts(store, s.info.id).includes('Denied: I left the build folder alone.'));
});

test('interrupt: the turn stops, pending prompts are denied, the session stays live', async (t) => {
  const { store, sessions, worker } = setup(t);
  const s = worker();
  let streaming = false;
  const onEvent = (e: ServerEvent) => e.type === 'delta' && e.sessionId === s.info.id && (streaming = true);
  bus.on('event', onEvent);
  t.after(() => bus.off('event', onEvent));
  sessions.send(s.info.id, 'take your time #slow');
  // Mid-answer: the reply has started streaming.
  await until(() => streaming, 'the reply to start');
  await s.interrupt();
  assert.equal(s.info.status, 'idle');
  assert.equal(s.live, true);
  assert.equal(texts(store, s.info.id).at(-1), 'Interrupted.');
  assert.deepEqual(snapshotOf(s).unanswered, []);
  // It keeps working afterwards.
  sessions.send(s.info.id, 'again');
  await until(() => texts(store, s.info.id).includes('Echo: again'), 'the next answer');
});

test('stop and resume: a stopped session restarts on the next message, resuming its SDK session', async (t) => {
  const { sessions, worker } = setup(t);
  const s = worker('default');
  sessions.send(s.info.id, '#perm');
  await until(() => s.info.pendingPermissions.length === 1, 'the permission prompt');
  const sdk = s.info.sdkSessionId;
  const ended: string[] = [];
  sessions.events.on('ended', (h: SessionHandle) => ended.push(h.info.id));
  s.stop();
  assert.equal(s.live, false);
  assert.equal(s.info.status, 'stopped');
  assert.deepEqual(s.info.pendingPermissions, []);
  assert.deepEqual(ended, [s.info.id]);

  sessions.send(s.info.id, 'are you back?');
  assert.equal(seen.at(-1)!.options.resume, sdk);
  await until(() => s.info.status === 'idle', 'idle');
});

test('images: kept with the message and shown to the agent; tool-result images are kept too', async (t) => {
  const { store, sessions, worker } = setup(t);
  const s = worker();
  sessions.send(s.info.id, 'look', 'human', [{ mediaType: 'image/png', data: RED_PNG }]);
  await until(() => s.info.status === 'idle', 'idle');
  const [user] = store.readTranscript(s.info.id);
  assert.equal(user.kind === 'user' && user.images?.length, 1);
  assert.ok(user.kind === 'user' && store.imagePath(s.info.id, user.images![0].id));
  assert.ok(texts(store, s.info.id).includes('Echo: look (1 image)'));

  sessions.send(s.info.id, '#screenshot');
  await until(() => texts(store, s.info.id).includes('Here is the screenshot.'), 'the screenshot');
  const shot = store.readTranscript(s.info.id).find((e) => e.kind === 'tool_result');
  assert.equal(shot?.kind === 'tool_result' && shot.images?.length, 1);
  assert.equal(shot?.kind === 'tool_result' && shot.text, '[image]');
});

test('a failed turn is recorded as not ok', async (t) => {
  const { store, sessions, worker } = setup(t);
  const s = worker();
  sessions.send(s.info.id, '#fail');
  await until(() => s.info.status === 'idle', 'idle');
  const result = store.readTranscript(s.info.id).find((e) => e.kind === 'result');
  assert.equal(result?.kind === 'result' && result.ok, false);
  assert.equal(s.info.lastResult, 'stopped: error_during_execution');
});

test('w384: the agent limit counts mid-turn agents only: a message to an idle worker goes through with every slot held by idle ones', async (t) => {
  const { sessions, worker } = setup(t, 2);
  const a = worker();
  const b = worker();
  const c = worker();
  sessions.send(a.info.id, 'one');
  sessions.send(b.info.id, 'two');
  await until(() => a.info.status === 'idle' && b.info.status === 'idle', 'both idle');
  assert.equal(sessions.liveAgents(), 2, 'their processes are still up');
  assert.equal(sessions.runningAgents(), 0, 'but neither is mid-turn');
  // 4b35b8c1 on 2026-10-04: refused "already 6 agents running (limits.maxSessions)" with six idle workers.
  const uuid = sessions.send(c.info.id, 'three');
  assert.equal(sessions.isQueued(uuid), false, 'delivered at once, not queued');
  assert.equal(c.info.status === 'running' || c.info.status === 'starting', true, c.info.status);
  await until(() => c.info.status === 'idle', 'c answered');
  // And an idle one is resumed the same way.
  sessions.send(a.info.id, 'more');
  await until(() => a.info.status === 'idle', 'a answered again');
});

test('w384: with every running slot busy a message is queued, not refused, and delivered when a turn ends; the orchestrator never waits', async (t) => {
  const { sessions, worker, store } = setup(t, 2);
  const a = worker();
  const b = worker();
  const c = worker();
  const o = worker('default', 'orchestrator');
  sessions.send(a.info.id, '#slow one');
  sessions.send(b.info.id, '#slow two');
  assert.equal(sessions.runningAgents(), 2);
  const uuid = sessions.send(c.info.id, 'three');
  assert.equal(sessions.isQueued(uuid), true, 'queued');
  assert.notEqual(c.info.status, 'running');
  assert.match(sessions.queued()[0].why, /2 of 2 agents on this host are mid-turn \(limits\.maxSessions\)/);
  // A follow-up to a session already mid-turn joins its turn; the orchestrator never counts.
  assert.equal(sessions.isQueued(sessions.send(a.info.id, 'more')), false);
  assert.equal(sessions.isQueued(sessions.send(o.info.id, 'hi')), false);
  // A second message to the queued session keeps its place behind the first.
  const second = sessions.send(c.info.id, 'four');
  assert.equal(sessions.isQueued(second), true);
  await until(() => sessions.queued().length === 0, 'delivered once a slot freed', 20_000);
  await until(() => c.info.status === 'idle', 'c answered', 20_000);
  const said = store.readTranscript(c.info.id).filter((e) => e.kind === 'user').map((e) => (e as { text: string }).text);
  assert.deepEqual(said, ['three', 'four'], 'in order');
});

test('w384: past limits.maxSessions + limits.maxIdleAgents processes, the oldest idle one nothing protects is stopped to make room, resumably', async (t) => {
  const { sessions, worker } = setup(t, 1, { maxIdleAgents: 1 });
  const a = worker();
  const b = worker();
  const c = worker();
  sessions.keepIdle = (s) => (s.info.id === b.info.id ? 'its wake_me is pending' : undefined);
  sessions.send(a.info.id, 'one');
  await until(() => a.info.status === 'idle', 'a idle');
  sessions.send(b.info.id, 'two');
  await until(() => b.info.status === 'idle', 'b idle');
  assert.equal(sessions.liveAgents(), 2);
  sessions.send(c.info.id, 'three');
  assert.equal(a.live, false, 'the oldest idle one went');
  assert.equal(b.live, true, 'a protected one stays');
  assert.equal(a.info.status, 'stopped');
  await until(() => c.info.status === 'idle', 'c answered');
  // Resumable: a message brings it back (b is protected, so c, now the oldest idle, makes room).
  sessions.send(a.info.id, 'back');
  await until(() => a.info.status === 'idle', 'a resumed');
});

test('restore: sessions come back stopped; one cut off mid-turn says so and is reported', (t) => {
  const { dir, store } = setup(t);
  const base = { title: 't', permissionMode: 'default' as const, createdAt: 'x', lastActivityAt: 'x', turns: 0, costUsd: 0 };
  store.putSession({ ...base, id: 'busy', kind: 'worker', sandboxId: 'sb', status: 'running', pendingPermissions: [{ requestId: 'r', toolName: 'Bash', input: {}, createdAt: 'x' }] });
  store.putSession({ ...base, id: 'calm', kind: 'worker', sandboxId: 'sb', status: 'idle', pendingPermissions: [] });
  store.putSession({ ...base, id: 'orphan', kind: 'worker', status: 'idle', pendingPermissions: [] });
  store.flush();

  const again = new Store(dir);
  const restored = new SessionManager({ limits: { maxSessions: 6 } } as Config, again);
  const cutOff = restored.restore((info) => (info.id === 'orphan' ? undefined : () => ({})));
  assert.deepEqual(cutOff.map((i) => i.id), ['busy']);
  assert.deepEqual([...restored.sessions.keys()].sort(), ['busy', 'calm']);
  for (const id of ['busy', 'calm']) {
    assert.equal(again.sessions.get(id)!.status, 'stopped');
    assert.deepEqual(again.sessions.get(id)!.pendingPermissions, []);
  }
  assert.match(texts(again, 'busy').at(-1)!, /server restarted while this session was working/);
  assert.deepEqual(again.readTranscript('calm'), []);
  again.flush();
});

test('restart marks: a process that ends with the server leaves its turn open, and the next server resumes it', async (t) => {
  const { dir, store, sessions, worker } = setup(t);
  const s = worker();
  sessions.send(s.info.id, '#die');
  await until(() => s.info.status === 'error', 'the process to end');
  // Its process went first (a console close or a process-tree stop reaches it before the server): not busy by status...
  assert.ok(s.info.turnOpenSince, '...but its turn is still open');
  store.flush();

  // The server goes too; the next one finds it cut off and resumes it.
  const again = new Store(dir);
  const restored = new SessionManager({ limits: { maxSessions: 6 } } as Config, again);
  const cutOff = restored.restore(() => () => ({}));
  assert.deepEqual(cutOff.map((i) => i.id), [s.info.id]);
  const snaps = cutOff.map((i) => ({ ...snapshotOf(restored.get(i.id)), status: i.status }));
  assert.deepEqual(collectResume(snaps).map((e) => [e.id, e.why]), [[s.info.id, 'mid-turn']]);
  // Settled by the restart: a later restart does not resume it again.
  restored.get(s.info.id).clearRestartMarks!();
  assert.equal(again.sessions.get(s.info.id)!.turnOpenSince, undefined);
  again.flush();
});

test('restart marks: a worker cut off mid-turn by a crash is resumed (restore used to report it as stopped)', (t) => {
  const { dir, store } = setup(t);
  const base = { title: 't', permissionMode: 'default' as const, createdAt: 'x', lastActivityAt: 'x', turns: 0, costUsd: 0, pendingPermissions: [] };
  store.putSession({ ...base, id: 'busy', kind: 'worker', sandboxId: 'sb', status: 'running' });
  store.flush();
  const again = new Store(dir);
  const restored = new SessionManager({ limits: { maxSessions: 6 } } as Config, again);
  const cutOff = restored.restore(() => () => ({}));
  // Agents.uncleanResumeFile: the cut-off list's own status, over the restored session's snapshot.
  assert.equal(cutOff[0].status, 'running');
  const snaps = cutOff.map((i) => ({ ...snapshotOf(restored.get(i.id)), status: i.status }));
  assert.deepEqual(collectResume(snaps).map((e) => e.id), ['busy']);
  again.flush();
});

test('restart marks: a process that ends on its own, with the server still up, is not resumed later', async (t) => {
  const { sessions, worker } = setup(t);
  const grace = restartMarks.graceMs;
  restartMarks.graceMs = 30;
  t.after(() => void (restartMarks.graceMs = grace));
  const s = worker();
  sessions.send(s.info.id, '#die');
  await until(() => s.info.status === 'error', 'the process to end');
  await until(() => !s.info.turnOpenSince, 'the marks to clear after the grace');
  assert.deepEqual(collectResume([snapshotOf(s)]), []);
});

test('restart marks: stopped or interrupted on purpose is never resumed; stopped by the server stopping is', async (t) => {
  const { sessions, worker } = setup(t);
  const a = worker();
  sessions.send(a.info.id, '#slow working');
  await until(() => a.info.status === 'running', 'running');
  a.stop();
  // It had an unanswered message and a drain had asked it to pause: neither brings it back after the update.
  assert.deepEqual(collectResume([snapshotOf(a)], new Set([a.info.id])), []);
  assert.equal(a.info.turnOpenSince, undefined);

  const b = worker();
  sessions.send(b.info.id, '#slow working');
  await until(() => b.info.status === 'running', 'running');
  await b.interrupt();
  assert.deepEqual(collectResume([snapshotOf(b)]), []);

  const c = worker();
  sessions.send(c.info.id, '#slow working');
  await until(() => c.info.status === 'running', 'running');
  sessions.stopAll();
  assert.deepEqual(collectResume([snapshotOf(c)]).map((e) => [e.id, e.why]), [[c.info.id, 'mid-turn']]);
  // A message after a deliberate stop makes it resumable again.
  sessions.send(a.info.id, '#slow again');
  await until(() => a.info.status === 'running', 'running');
  assert.deepEqual(collectResume([snapshotOf(a)]).map((e) => e.why), ['mid-turn']);
});

test('restart marks: an idle worker waiting on a background task is resumed, told its task was ended', async (t) => {
  const { dir, store, sessions, worker } = setup(t);
  const s = worker();
  sessions.send(s.info.id, '#bg');
  await until(() => s.info.status === 'idle', 'idle');
  assert.equal(s.info.backgroundTasks, 1);
  assert.equal(s.info.turnOpenSince, undefined);
  const [e] = collectResume([snapshotOf(s)]);
  assert.equal(e.why, 'background');
  assert.match(resumeMessage(e, { reason: 'update', at: new Date().toISOString() }), /background tasks running .* the restart ended them/);
  // After a crash as well: the next server finds it in the store.
  store.flush();
  const again = new Store(dir);
  const cutOff = new SessionManager({ limits: { maxSessions: 6 } } as Config, again).restore(() => () => ({}));
  assert.deepEqual(cutOff.map((i) => i.id), [s.info.id]);
  assert.match(texts(again, s.info.id).at(-1)!, /1 background task\(s\) running; they were stopped/);
  again.flush();
});
