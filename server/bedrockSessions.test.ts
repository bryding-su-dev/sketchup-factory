import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { SessionManager, setQueryForTesting } from './sessions.ts';
import { Store } from './store.ts';
import type { Config } from './config.ts';
import type { SessionInfo } from '../shared/types.ts';
import { fakeQuery } from '../e2e/fakeAgent.ts';

/** What the Bedrock backend needs of the sessions (w38): the backend a process records, recycling an idle one, the held queue. */

const PLAN_ENV = { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-' + 'p'.repeat(40) };
const BEDROCK_ENV = { CLAUDE_CODE_USE_BEDROCK: '1', AWS_PROFILE: 'sketchup-bedrock', AWS_REGION: 'us-west-2' };

const started: { env: Record<string, string | undefined>; resume?: string }[] = [];
const fake = fakeQuery({ stepMs: 1 });
// The scripted agent, plus what Claude Code adds to a Bedrock turn's result: the cumulative usage per model.
setQueryForTesting(((args: { prompt: never; options: Options }) => {
  const env = (args.options.env ?? {}) as Record<string, string | undefined>;
  started.push({ env, resume: args.options.resume });
  const bedrock = env.CLAUDE_CODE_USE_BEDROCK === '1';
  const q = fake(args as never);
  let turns = 0;
  const proxy: unknown = new Proxy(q, {
    get(target, prop) {
      if (prop === Symbol.asyncIterator) return () => proxy;
      if (prop === 'next') {
        return async (...a: []) => {
          const r = await target.next(...a);
          if (!r.done && r.value.type === 'result') {
            turns++;
            (r.value as { modelUsage?: unknown }).modelUsage = { [bedrock ? 'us.anthropic.claude-haiku-5-5' : 'claude-haiku-5-5']: { inputTokens: 100 * turns, outputTokens: 10 * turns, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.001 * turns, provider: bedrock ? 'bedrock' : 'firstParty' } };
          }
          return r;
        };
      }
      const v = Reflect.get(target, prop) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
  return proxy as never;
}) as never);

function setup(t: { after: (fn: () => void | Promise<void>) => void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-bedrock-sessions-'));
  const store = new Store(dir);
  t.after(async () => {
    sessions.stopAll();
    await new Promise((r) => setTimeout(r, 50));
    store.flush();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  const sessions = new SessionManager({ limits: { maxSessions: 6 }, dataDir: dir } as unknown as Config, store);
  /** What the controller says: the backend a new process starts on, and whether new work is held. */
  const want = { backend: 'plan' as 'plan' | 'bedrock', reason: 'plan usage is under the 94% threshold', blocked: undefined as string | undefined };
  sessions.backendWant = () => (want.blocked ? undefined : { backend: want.backend, reason: want.reason });
  sessions.backendGate = () => want.blocked;
  const worker = () => sessions.create({ kind: 'worker', title: 'w', permissionMode: 'bypassPermissions', options: () => ({ model: 'opus', env: want.backend === 'bedrock' ? { ...BEDROCK_ENV } : { ...PLAN_ENV } }) });
  return { dir, store, sessions, worker, want };
}

async function until(pred: () => boolean, what: string, ms = 3000) {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}
const idle = (s: { info: SessionInfo }) => s.info.status === 'idle';
const lines = (store: Store, id: string) => store.readTranscript(id).map((e) => ('text' in e ? e.text : ''));

test('a process records where it runs: the plan account, or Bedrock with the profile name only', async (t) => {
  const { sessions, worker, want } = setup(t);
  const a = worker();
  sessions.send(a.info.id, 'hello');
  await until(() => idle(a), 'the plan turn');
  assert.equal(a.info.backend, 'plan');
  assert.match(a.info.account!, /^token:[0-9a-f]{12}$/);
  want.backend = 'bedrock';
  const b = worker();
  sessions.send(b.info.id, 'hello');
  await until(() => idle(b), 'the Bedrock turn');
  assert.equal(b.info.backend, 'bedrock');
  assert.equal(b.info.account, 'bedrock:sketchup-bedrock');
});

test("every result of a Bedrock session is emitted as 'bedrockResult'; a plan session's is not", async (t) => {
  const { sessions, worker, want } = setup(t);
  const seen: { id: string; usage: Record<string, { provider?: string; inputTokens: number }> }[] = [];
  sessions.events.on('bedrockResult', (s: { info: SessionInfo }, m: { modelUsage: Record<string, { provider?: string; inputTokens: number }> }) => seen.push({ id: s.info.id, usage: m.modelUsage }));
  const plan = worker();
  sessions.send(plan.info.id, 'one');
  await until(() => idle(plan), 'the plan turn');
  assert.equal(seen.length, 0);
  want.backend = 'bedrock';
  const b = worker();
  sessions.send(b.info.id, 'one');
  await until(() => idle(b), 'the first turn');
  sessions.send(b.info.id, 'two');
  await until(() => seen.length === 2 && idle(b), 'the second turn');
  assert.deepEqual(seen.map((x) => x.id), [b.info.id, b.info.id]);
  assert.equal(seen[1].usage['us.anthropic.claude-haiku-5-5'].provider, 'bedrock');
  assert.equal(seen[1].usage['us.anthropic.claude-haiku-5-5'].inputTokens, 200, 'cumulative: the listener takes the difference');
});

test('an idle live process on the other backend is stopped and resumed on the right one by the next message', async (t) => {
  const { sessions, store, worker, want } = setup(t);
  const s = worker();
  sessions.send(s.info.id, 'first');
  await until(() => idle(s), 'the first turn');
  assert.equal(s.info.backend, 'plan');
  const sdk = s.info.sdkSessionId;
  assert.ok(sdk);
  const before = started.length;
  // Same decision: nothing restarts.
  sessions.send(s.info.id, 'second');
  await until(() => s.info.turns === 2 && idle(s), 'the second turn');
  assert.equal(started.length, before, 'the same process');
  // The plan reached the threshold.
  want.backend = 'bedrock';
  want.reason = 'session usage 95% is at the 94% threshold';
  sessions.send(s.info.id, 'third');
  await until(() => s.info.turns === 3 && idle(s), 'the third turn');
  assert.equal(started.length, before + 1, 'one new process');
  const next = started.at(-1)!;
  assert.equal(next.resume, sdk, 'resumed: the history is intact');
  assert.equal(next.env.CLAUDE_CODE_USE_BEDROCK, '1');
  assert.equal(next.env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(s.info.backend, 'bedrock');
  assert.equal(s.info.sdkSessionId, sdk);
  assert.ok(lines(store, s.info.id).includes('Switched to Bedrock (session usage 95% is at the 94% threshold); continuing on it.'));
  // And back.
  want.backend = 'plan';
  want.reason = 'plan usage is back to 70% (resumes under 84%)';
  sessions.send(s.info.id, 'fourth');
  await until(() => s.info.turns === 4 && idle(s), 'the fourth turn');
  assert.equal(s.info.backend, 'plan');
  assert.equal(started.at(-1)!.resume, sdk);
  assert.ok(lines(store, s.info.id).includes('Switched to your Claude plan (plan usage is back to 70% (resumes under 84%)); continuing on it.'));
});

test('a turn that is running finishes on the backend it started on; so does one with a background task', async (t) => {
  const { sessions, store, worker, want } = setup(t);
  const s = worker();
  sessions.send(s.info.id, '#slow a long one');
  await until(() => s.info.status === 'running', 'the turn to start');
  const before = started.length;
  want.backend = 'bedrock';
  sessions.send(s.info.id, 'a follow-up that joins the turn');
  assert.equal(started.length, before, 'no new process');
  assert.equal(s.info.backend, 'plan');
  assert.equal(lines(store, s.info.id).some((l) => l.startsWith('Switched to')), false);
  await until(() => idle(s) && s.info.turns >= 1, 'the turns to end', 10_000);
  // With a background task alive, the idle process is left alone too.
  const bg = worker();
  want.backend = 'plan';
  sessions.send(bg.info.id, '#bg start one');
  await until(() => idle(bg) && !!bg.info.backgroundTasks, 'a background task');
  const n = started.length;
  want.backend = 'bedrock';
  sessions.send(bg.info.id, 'again');
  await until(() => bg.info.turns === 2 && idle(bg), 'the second turn');
  assert.equal(started.length, n, 'its process, and its task, stay');
  assert.equal(bg.info.backend, 'plan');
});

test('blocked: new messages wait in the queue with the reason, bypassGate ones do not, and they go once it lifts', async (t) => {
  const { sessions, store, worker, want } = setup(t);
  const s = worker();
  sessions.send(s.info.id, 'warm up');
  await until(() => idle(s), 'the first turn');
  want.blocked = "today's Bedrock cap is spent ($200 of $200) and the plan is at its limit, so new work waits";
  const before = s.info.turns;
  const uuid = sessions.send(s.info.id, 'held 1');
  const second = sessions.send(s.info.id, 'held 2');
  assert.equal(sessions.isQueued(uuid), true);
  assert.equal(sessions.isQueued(second), true, 'in order behind the first');
  assert.equal(sessions.queued().length, 2);
  assert.match(sessions.queued()[0].why, /cap is spent/);
  assert.ok(lines(store, s.info.id).some((l) => /A message is waiting \(today's Bedrock cap is spent .*new work waits\); it is delivered as soon as Bedrock or your plan has room again\./.test(l)));
  assert.equal(sessions.drain(), 0, 'still blocked: kept');
  assert.equal(sessions.queued().length, 2);
  assert.equal(s.info.turns, before, 'nothing was delivered');
  // The harness's own message is not held (to a session with nothing waiting: order still holds within one).
  const other = worker();
  sessions.send(other.info.id, 'resume after recovery', 'system', undefined, { bypassGate: true });
  await until(() => other.info.turns === 1 && idle(other), 'the bypass turn');
  assert.equal(sessions.queued().length, 2);
  // It lifts: the decision changes, drain is asked again and delivers in order.
  want.blocked = undefined;
  assert.equal(sessions.drain(), 2, 'both go, in order: the second joins the first one\'s turn');
  await until(() => sessions.queued().length === 0 && idle(s) && s.info.turns === before + 2, 'both delivered', 5000);
  const said = store.readTranscript(s.info.id).filter((e) => e.kind === 'user').map((e) => ('text' in e ? e.text : ''));
  assert.deepEqual(said.slice(-2), ['held 1', 'held 2']);
});

test('a session already mid-turn is not held by the gate; a stopped one is, and starts nothing', async (t) => {
  const { sessions, worker, want } = setup(t);
  const running = worker();
  sessions.send(running.info.id, '#slow long');
  await until(() => running.info.status === 'running', 'the turn to start');
  want.blocked = 'blocked';
  const before = started.length;
  const id = sessions.send(running.info.id, 'joins the running turn');
  assert.equal(sessions.isQueued(id), false);
  const stopped = worker();
  sessions.send(stopped.info.id, 'never started');
  assert.equal(started.length, before, 'no process was started for it');
  assert.equal(sessions.queued().length, 1);
  assert.equal(stopped.live, false);
});
