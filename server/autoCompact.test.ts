import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionManager, setQueryForTesting, type AutoCompaction, type SessionHandle, type TurnEndMeta } from './sessions.ts';
import { AUTO_COMPACT_DEFAULTS, AutoCompactor, COST_TRIGGER_MIN_TOKENS, DISPATCHER_FOCUS, MIN_TURNS_BETWEEN, PERSONAL_FOCUS, RETRY_AFTER_MS, autoCompactSettings, compactBlocker, compactionDue } from './autoCompact.ts';
import { Store } from './store.ts';
import type { Config } from './config.ts';
import type { Requester, SessionInfo } from '../shared/types.ts';
import { fakeQuery } from '../e2e/fakeAgent.ts';

/**
 * w535: the orchestrators compact their conversations by themselves, between turns, once the context or a turn's cost
 * passes its threshold, against the scripted fake SDK (e2e/fakeAgent.ts: "#ctx <tokens>" sets the context its usage
 * reports, "#spend <usd>" what the turn costs, "/compact" compacts it to 18,000 tokens).
 */

setQueryForTesting(fakeQuery({ stepMs: 1 }) as never);

const LOTHSAHN: Requester = { userId: 'lothsahn', displayName: 'Lothsahn' };

function setup(t: { after: (fn: () => void | Promise<void>) => void }, orchestrator: Partial<Config['orchestrator']> = { compactAtTokens: 50_000 }, settleMs = 20) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-autocompact-'));
  const store = new Store(dir);
  const cfg = { limits: { maxSessions: 6 }, orchestrator: { model: 'opus', effort: 'low', notifyOnWorkerEvents: false, ...orchestrator } } as unknown as Config;
  const sessions = new SessionManager(cfg, store);
  const auto = new AutoCompactor(sessions, cfg, { settleMs });
  t.after(async () => {
    auto.stop();
    sessions.stopAll();
    await new Promise((r) => setTimeout(r, 50));
    store.flush();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  // What each compaction was sent with: the focus and FF Factory's reason.
  const compactions: { focus: string; auto?: AutoCompaction }[] = [];
  const real = sessions.compact.bind(sessions);
  sessions.compact = (id, focus = '', by, a) => {
    compactions.push({ focus, ...(a ? { auto: a } : {}) });
    return real(id, focus, by, a);
  };
  const ends: { text: string; meta?: TurnEndMeta }[] = [];
  sessions.events.on('turnEnd', (_h: SessionHandle, text: string, meta?: TurnEndMeta) => ends.push({ text, meta }));
  const make = (role: 'personal' | 'dispatcher' = 'personal') =>
    sessions.create({ kind: 'orchestrator', title: role === 'personal' ? 'lothsahn' : 'Dispatcher', permissionMode: 'default', options: () => ({ model: 'opus' }), orchestratorRole: role, ...(role === 'personal' ? { requestedBy: LOTHSAHN } : {}) });
  const say = (id: string, text: string) => sessions.send(id, text, 'human', undefined, { requestedBy: LOTHSAHN });
  return { store, sessions, auto, compactions, ends, make, say, cfg };
}

async function until(pred: () => boolean, what: string, ms = 4000) {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const systemLines = (store: Store, id: string) => store.readTranscript(id).filter((e) => e.kind === 'system').map((e) => ('text' in e ? e.text : ''));
const compacted = (store: Store, id: string) => systemLines(store, id).filter((l) => l.startsWith('Compacted'));

const info = (over: Partial<SessionInfo>) => ({ turns: 10, ...over }) as SessionInfo;
const S = { atTokens: 200_000, atTurnUsd: 1 };

test('compactionDue: the context past compactAtTokens, or a costly turn with 100k or more; 0 turns either off', () => {
  assert.equal(compactionDue(info({ contextTokens: 199_999 }), S), undefined);
  assert.deepEqual(compactionDue(info({ contextTokens: 200_000 }), S), { trigger: 'tokens', reason: 'the context passed 200,000 tokens' });
  assert.equal(compactionDue(info({ contextTokens: 900_000 }), { ...S, atTokens: 0 }), undefined, 'the token trigger off');
  assert.equal(compactionDue(info({}), S), undefined, 'nothing measured yet');
  // The cost trigger: a turn that cost $1 or more, but only with the context at 100k or more (below, it saves too little).
  assert.deepEqual(compactionDue(info({ contextTokens: 120_000, lastTurnCostUsd: 1.25 }), S), { trigger: 'cost', reason: 'its last turn cost $1.25, $1.00 or more, with the context at 120,000 tokens' });
  assert.equal(compactionDue(info({ contextTokens: COST_TRIGGER_MIN_TOKENS - 1, lastTurnCostUsd: 3 }), S), undefined);
  assert.equal(compactionDue(info({ contextTokens: 120_000, lastTurnCostUsd: 0.99 }), S), undefined);
  assert.equal(compactionDue(info({ contextTokens: 120_000, lastTurnCostUsd: 5 }), { ...S, atTurnUsd: 0 }), undefined, 'the cost trigger off');
});

test('compactionDue: never within a few turns of the last compaction, nor again before the context grew by half the threshold', () => {
  const last = { at: '2026-10-06T15:11:07Z', trigger: 'tokens' as const, before: 260_000, after: 40_000, turns: 10 };
  assert.equal(compactionDue(info({ contextTokens: 250_000, turns: 10 + MIN_TURNS_BETWEEN - 1, lastCompaction: last }), S), undefined);
  assert.equal(compactionDue(info({ contextTokens: 250_000, turns: 10 + MIN_TURNS_BETWEEN, lastCompaction: last }), S)?.trigger, 'tokens');
  // A compaction that left 180k (a threshold set below what a summary can reach) waits until 280k, not every 3 turns.
  const big = { ...last, after: 180_000 };
  assert.equal(compactionDue(info({ contextTokens: 250_000, turns: 20, lastCompaction: big }), S), undefined);
  assert.equal(compactionDue(info({ contextTokens: 280_000, turns: 20, lastCompaction: big }), S)?.trigger, 'tokens');
});

test('autoCompactSettings: defaults 200,000 tokens and $1, as config sets them; 0 is off', () => {
  assert.deepEqual(autoCompactSettings({ orchestrator: {} } as Config), { atTokens: AUTO_COMPACT_DEFAULTS.atTokens, atTurnUsd: AUTO_COMPACT_DEFAULTS.atTurnUsd });
  assert.deepEqual(AUTO_COMPACT_DEFAULTS, { atTokens: 200_000, atTurnUsd: 1 });
  assert.deepEqual(autoCompactSettings({ orchestrator: { compactAtTokens: 0, compactAtTurnUsd: 2.5 } } as Config), { atTokens: 0, atTurnUsd: 2.5 });
});

test('compactBlocker: only between turns, with nothing waiting', () => {
  const h = (over: Partial<SessionInfo>, extra: Partial<{ live: boolean; compactingNow: boolean }> = {}) =>
    ({ info: { kind: 'orchestrator', status: 'idle', sdkSessionId: 'x', pendingPermissions: [], ...over }, live: true, compact: () => '', ...extra }) as unknown as SessionHandle & { compactingNow?: boolean };
  assert.equal(compactBlocker(h({}), false), undefined);
  assert.match(compactBlocker(h({ status: 'running' }), false)!, /running/);
  assert.match(compactBlocker(h({ status: 'waiting_permission' }), false)!, /waiting permission/);
  assert.match(compactBlocker(h({ turnOpenSince: '2026-10-06T15:00:00Z' }), false)!, /not answered/);
  assert.match(compactBlocker(h({}), true)!, /send queue/);
  assert.match(compactBlocker(h({}, { live: false }), false)!, /process is not running/);
  assert.match(compactBlocker(h({}, { compactingNow: true }), false)!, /compacting already/);
  assert.match(compactBlocker(h({ kind: 'worker' }), false)!, /not an orchestrator/);
});

test('past the threshold, an orchestrator compacts by itself after its turn: one line "Compacted: N → M tokens", no notification, the last report stays', async (t) => {
  const { store, auto, compactions, ends, make, say } = setup(t);
  const o = make();
  say(o.info.id, 'small talk');
  await until(() => o.info.status === 'idle', 'the first turn');
  await sleep(60);
  assert.equal(compactions.length, 0, 'under 50,000 tokens: no compaction');
  assert.equal(o.info.contextTokens, 25_000, "the context measured from the reply's usage");
  say(o.info.id, 'a long one #ctx 60000');
  await until(() => compacted(store, o.info.id).length === 1 && o.info.status === 'idle' && !!o.info.lastCompaction, 'the automatic compaction');
  assert.equal(compactions.length, 1);
  assert.equal(compactions[0].focus, PERSONAL_FOCUS, "a person's orchestrator keeps its open requests, questions, decisions and ids");
  assert.deepEqual(compactions[0].auto, { trigger: 'tokens', reason: 'the context passed 50,000 tokens' });
  // One line in the chat, when it is done; nothing when it starts.
  assert.deepEqual(systemLines(store, o.info.id).filter((l) => /ompact/.test(l)), ['Compacted: 60,000 → 18,000 tokens (automatically: the context passed 50,000 tokens), in 2 s.']);
  assert.deepEqual({ ...o.info.lastCompaction, at: undefined }, { at: undefined, trigger: 'tokens', before: 60_000, after: 18_000, turns: 2 });
  assert.equal(o.info.contextTokens, 18_000);
  assert.equal(o.info.lastResult, 'Echo: a long one #ctx 60000', 'the last report is the last real reply');
  assert.equal(o.info.turns, 2);
  // Its end is marked as an automatic compaction (notify.ts sends nothing for it), and carries the last reply's text.
  assert.deepEqual(ends.at(-1), { text: 'Echo: a long one #ctx 60000', meta: { compaction: 'tokens' } });
  // No loop: the compaction's own end is not checked, and the next turns are under the threshold again.
  say(o.info.id, 'still there?');
  await until(() => o.info.lastResult === 'Echo: still there?' && o.info.status === 'idle', 'the next answer');
  await sleep(60);
  assert.equal(compactions.length, 1);
  assert.equal(auto.check(o.info.id), 'not due');
});

test('the dispatcher gets the same, with its own focus', async (t) => {
  const { store, compactions, make, say } = setup(t);
  const d = make('dispatcher');
  say(d.info.id, '[intake] five reports #ctx 70000');
  await until(() => compacted(store, d.info.id).length === 1, 'the compaction');
  assert.equal(compactions[0].focus, DISPATCHER_FOCUS);
});

test('a costly turn compacts it once the context is 100k or more', async (t) => {
  const { store, compactions, make, say } = setup(t, { compactAtTokens: 0, compactAtTurnUsd: 0.5 });
  const o = make();
  say(o.info.id, 'a costly turn at 80k #ctx 80000 #spend 0.6');
  await until(() => o.info.status === 'idle', 'the turn');
  await sleep(60);
  assert.ok(o.info.lastTurnCostUsd! >= 0.6, `the turn's cost is measured (${o.info.lastTurnCostUsd})`);
  assert.equal(compactions.length, 0, 'at 80,000 tokens a compaction would save too little');
  say(o.info.id, 'another at 120k #ctx 120000 #spend 0.6');
  await until(() => compacted(store, o.info.id).length === 1, 'the compaction');
  assert.equal(compactions[0].auto?.trigger, 'cost');
  assert.match(compacted(store, o.info.id)[0], /^Compacted: 120,000 → 18,000 tokens \(automatically: its last turn cost \$0\.6\d, \$0\.50 or more, with the context at 120,000 tokens\)/);
});

test("never ahead of a person's message: one that arrives as the turn ends is answered first, and the compaction follows that turn", async (t) => {
  const { store, compactions, make, say } = setup(t, { compactAtTokens: 50_000 }, 150);
  const o = make();
  say(o.info.id, 'big #ctx 60000');
  await until(() => o.info.status === 'idle', 'the first turn');
  // Within the settle time after the turn: the person writes again.
  say(o.info.id, 'and one more thing #slow');
  await sleep(200);
  assert.equal(compactions.length, 0, 'mid-turn: not compacted');
  assert.equal(o.info.status, 'running');
  await until(() => compacted(store, o.info.id).length === 1, 'the compaction after that turn', 15_000);
  const all = store.readTranscript(o.info.id).map((e) => ('text' in e ? e.text : ''));
  const answered = all.indexOf('Echo: and one more thing #slow');
  assert.ok(answered >= 0 && answered < all.findIndex((l) => l.startsWith('Compacted')), 'the reply came before the compaction');
});

test('a message that arrives while it compacts waits behind it and is answered after it', async (t) => {
  const { store, sessions, make, say } = setup(t);
  const o = make();
  // The person writes the moment the compaction has been sent.
  const compact = sessions.compact.bind(sessions);
  sessions.compact = (...args) => {
    const note = compact(...args);
    assert.equal(o.info.statusDetail, 'compacting the conversation');
    say(o.info.id, 'are you there?');
    return note;
  };
  say(o.info.id, 'big #ctx 60000');
  await until(() => o.info.lastResult === 'Echo: are you there?' && o.info.status === 'idle', 'the answer');
  const all = store.readTranscript(o.info.id).map((e) => ('text' in e ? e.text : ''));
  assert.ok(all.findIndex((l) => l.startsWith('Compacted')) >= 0);
  assert.equal(o.info.turns, 2);
});

test('compact_conversation: the orchestrator asks for it; it runs after the turn, with its focus, and not again within a few turns', async (t) => {
  const { store, auto, compactions, make, say } = setup(t);
  const o = make();
  say(o.info.id, 'hello');
  await until(() => o.info.status === 'idle', 'the first turn');
  assert.match(auto.request(o.info.id, 'keep the w530 numbers'), /compacted once this turn ends \(its context is 25,000 tokens now\)/);
  say(o.info.id, 'wrap up');
  await until(() => compacted(store, o.info.id).length === 1, 'the compaction');
  assert.deepEqual(compactions[0], { focus: 'keep the w530 numbers', auto: { trigger: 'self', reason: 'the orchestrator asked for it' } });
  assert.match(compacted(store, o.info.id)[0], /\(automatically: the orchestrator asked for it\)/);
  await until(() => o.info.lastCompaction?.trigger === 'self', 'the record');
  assert.throws(() => auto.request(o.info.id), /compacted 0 turn\(s\) ago \(30,000 → 18,000 tokens\)/);
  assert.throws(() => auto.request(o.info.id, 'x'.repeat(2001)), /2001 characters/);
});

test('an automatic compaction that fails says so and is not retried for half an hour', async (t) => {
  const { store, auto, make, say } = setup(t);
  const o = make();
  say(o.info.id, 'hello');
  await until(() => o.info.status === 'idle', 'the first turn');
  auto.request(o.info.id, '#fail');
  say(o.info.id, 'big #ctx 60000');
  await until(() => store.readTranscript(o.info.id).some((e) => e.kind === 'error'), 'the failure');
  await until(() => o.info.status === 'idle', 'idle');
  assert.equal(store.readTranscript(o.info.id).filter((e) => e.kind === 'error').at(-1)!.text, 'The automatic compaction failed: the summary request failed.');
  assert.equal(o.info.lastResult, 'Echo: big #ctx 60000');
  assert.match(auto.check(o.info.id), /did not finish/);
  assert.match(auto.check(o.info.id, Date.now() + RETRY_AFTER_MS + 1000), /^compacting: the context passed 50,000 tokens/);
  await until(() => compacted(store, o.info.id).length === 1, 'the retry');
});

test('a person\'s /compact (w518) still says so at once and when done, and counts as the last compaction', async (t) => {
  const { store, sessions, ends, make, say } = setup(t, { compactAtTokens: 0, compactAtTurnUsd: 0 });
  const o = make();
  say(o.info.id, 'hello');
  await until(() => o.info.status === 'idle', 'the first turn');
  sessions.compact(o.info.id, '', LOTHSAHN);
  await until(() => o.info.lastCompaction?.trigger === 'person', 'the record');
  assert.match(systemLines(store, o.info.id).find((l) => l.startsWith('Compacting'))!, /asked by Lothsahn/);
  assert.match(compacted(store, o.info.id)[0], /^Compacted: the context went from 25,000 tokens to 18,000 tokens/);
  assert.deepEqual(ends.at(-1)?.meta, { compaction: 'person' });
});
