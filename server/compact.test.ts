import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { COMPACTING, SessionManager, compactCommand, compactedLine, setQueryForTesting, type SessionHandle } from './sessions.ts';
import { Store } from './store.ts';
import type { Config } from './config.ts';
import type { Requester, SessionInfo } from '../shared/types.ts';
import { fakeQuery } from '../e2e/fakeAgent.ts';

/**
 * w518: `/compact [focus]` in an orchestrator's chat compacts its conversation with Claude Code's own /compact, against
 * the scripted fake SDK (e2e/fakeAgent.ts answers "/compact" as the CLI did in a measured run: compacting, a
 * compact_boundary, a result of no turns). Between turns only; what arrives meanwhile is answered after it.
 */

const seen: { options: Options }[] = [];
const fake = fakeQuery({ stepMs: 1 });
setQueryForTesting(((args: { prompt: never; options: Options }) => {
  seen.push({ options: args.options });
  return fake(args);
}) as never);

const LOTHSAHN: Requester = { userId: 'lothsahn', displayName: 'Lothsahn' };

function setup(t: { after: (fn: () => void | Promise<void>) => void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-compact-'));
  const store = new Store(dir);
  t.after(async () => {
    sessions.stopAll();
    await new Promise((r) => setTimeout(r, 50));
    store.flush();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  const sessions = new SessionManager({ limits: { maxSessions: 6 } } as Config, store);
  const make = (kind: SessionInfo['kind'] = 'orchestrator') =>
    sessions.create({ kind, title: 'o', permissionMode: 'default', options: () => ({ model: 'opus' }), ...(kind === 'orchestrator' ? { orchestratorRole: 'personal' as const, requestedBy: LOTHSAHN } : {}) });
  const turnEnds: string[] = [];
  sessions.events.on('turnEnd', (_h: SessionHandle, text: string) => turnEnds.push(text));
  return { store, sessions, make, turnEnds };
}

async function until(pred: () => boolean, what: string, ms = 3000) {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const texts = (store: Store, id: string) => store.readTranscript(id).map((e) => ('text' in e ? e.text : ''));
const lines = (store: Store, id: string, kind: string) => store.readTranscript(id).filter((e) => e.kind === kind).map((e) => ('text' in e ? e.text : ''));

/** An orchestrator that has had one turn, idle. */
async function talked(t: Parameters<typeof setup>[0]) {
  const env = setup(t);
  const o = env.make();
  env.sessions.send(o.info.id, 'hello', 'human', undefined, { requestedBy: LOTHSAHN });
  await until(() => o.info.status === 'idle', 'the first turn');
  return { ...env, o };
}

test('compactCommand: /compact alone or with a focus; anything else is a message', () => {
  assert.equal(compactCommand('/compact'), '');
  assert.equal(compactCommand('  /compact  '), '');
  assert.equal(compactCommand('/compact keep the w518 notes\n and the PR numbers'), 'keep the w518 notes and the PR numbers');
  assert.equal(compactCommand('/compactly'), undefined);
  assert.equal(compactCommand('please /compact'), undefined);
  assert.equal(compactCommand('/clear'), undefined);
  assert.equal(compactCommand('compact'), undefined);
});

test('compactedLine: the measured context before and after; without an after, the summary size, said as such', () => {
  assert.equal(compactedLine(412_300, { total: 41_200, max: 1_000_000 }, 2_000, 48_400), 'Compacted: the context went from 412,300 tokens to 41,200 tokens (of 1,000,000 tokens), in 48 s, as Claude Code measured it before and after.');
  assert.match(compactedLine(412_300, undefined, 2_000, undefined), /context was 412,300 tokens; the summary that replaces it is 2,000 tokens \(the context after it could not be measured\)\.$/);
});

test("an idle orchestrator compacts: the command goes as Claude Code's own /compact, progress and the measured sizes go to the chat, the last report stays", async (t) => {
  const { store, sessions, o, turnEnds } = await talked(t);
  const report = o.info.lastResult;
  const turns = o.info.turns;
  const note = sessions.compact(o.info.id, 'keep the open requests', LOTHSAHN);
  assert.match(note, /Compacting/);
  assert.equal(o.info.status, 'running');
  assert.equal(o.info.statusDetail, COMPACTING);
  assert.match(lines(store, o.info.id, 'system').at(-1)!, /^Compacting this conversation \(asked by Lothsahn\), with the focus: keep the open requests\./);
  await until(() => o.info.status === 'idle' && lines(store, o.info.id, 'system').some((l) => l.startsWith('Compacted:')), 'the compaction');
  // The fake only compacts a message that IS the command (no "[from …]" line before it): the context went 25,000 -> 18,000.
  assert.equal(lines(store, o.info.id, 'system').at(-1), 'Compacted: the context went from 25,000 tokens to 18,000 tokens (of 200,000 tokens), in 2 s, as Claude Code measured it before and after.');
  assert.equal(o.info.statusDetail, undefined);
  // No reply, no user message in the transcript, and the last report is the turn before.
  assert.equal(store.readTranscript(o.info.id).filter((e) => e.kind === 'result').length, 1);
  assert.equal(store.readTranscript(o.info.id).filter((e) => e.kind === 'user').length, 1);
  assert.equal(o.info.lastResult, report);
  assert.equal(o.info.turns, turns);
  // The turn's end (push notification, timers held for it) says it compacted, not the old reply again.
  assert.equal(turnEnds.at(-1), 'Compacted the conversation (the context was 25,000 tokens).');
  // It goes on with its history afterwards.
  sessions.send(o.info.id, 'still there?', 'human', undefined, { requestedBy: LOTHSAHN });
  await until(() => texts(store, o.info.id).includes('Echo: still there?'), 'the next answer');
});

test('mid-turn it is refused with why, and nothing is sent; it works once the turn has ended', async (t) => {
  const { store, sessions, o } = await talked(t);
  sessions.send(o.info.id, 'take your time #slow', 'human', undefined, { requestedBy: LOTHSAHN });
  assert.throws(() => sessions.compact(o.info.id), /mid-turn \(running\); \/compact runs between turns/);
  assert.equal(o.info.statusDetail, undefined);
  await until(() => o.info.status === 'idle', 'the slow turn', 15_000);
  assert.ok(!texts(store, o.info.id).some((l) => l.startsWith('Compacting')));
  sessions.compact(o.info.id);
  assert.throws(() => sessions.compact(o.info.id), /compacting already/);
  await until(() => lines(store, o.info.id, 'system').some((l) => l.startsWith('Compacted:')), 'the compaction');
});

test('a wake_me or timer message that arrives during the compaction waits, and is answered after it', async (t) => {
  const { store, sessions, o, turnEnds } = await talked(t);
  sessions.compact(o.info.id);
  sessions.send(o.info.id, '[wake_me] Time is up. Your note: check w518 CI', 'system');
  await until(() => texts(store, o.info.id).includes('Echo: [wake_me] Time is up. Your note: check w518 CI'), 'the wake answered');
  await until(() => o.info.status === 'idle', 'idle');
  const all = texts(store, o.info.id);
  assert.ok(all.findIndex((l) => l.startsWith('Compacted')) >= 0);
  assert.ok(all.indexOf('Echo: [wake_me] Time is up. Your note: check w518 CI') > all.findIndex((l) => l.startsWith('Compacting')));
  assert.equal(o.info.lastResult, 'Echo: [wake_me] Time is up. Your note: check w518 CI');
  assert.equal(turnEnds.at(-1), 'Echo: [wake_me] Time is up. Your note: check w518 CI');
});

test('a stopped orchestrator resumes its conversation to compact it', async (t) => {
  const { store, sessions, o } = await talked(t);
  const sdk = o.info.sdkSessionId;
  o.stop();
  assert.equal(o.live, false);
  sessions.compact(o.info.id);
  assert.equal(o.live, true);
  assert.equal(seen.at(-1)!.options.resume, sdk);
  await until(() => lines(store, o.info.id, 'system').some((l) => l.startsWith('Compacted:')), 'the compaction');
});

test('a failed compaction says so, and the turn ends saying it', async (t) => {
  const { store, sessions, o, turnEnds } = await talked(t);
  sessions.compact(o.info.id, '#fail');
  await until(() => o.info.status === 'idle' && turnEnds.length === 2, 'the end of the compaction');
  assert.equal(lines(store, o.info.id, 'error').at(-1), 'The compaction failed: the summary request failed.');
  assert.equal(turnEnds.at(-1), 'The compaction failed: the summary request failed.');
  assert.equal(o.info.statusDetail, undefined);
  // It can be tried again.
  sessions.compact(o.info.id);
  await until(() => lines(store, o.info.id, 'system').some((l) => l.startsWith('Compacted:')), 'the second try');
});

test('refused: a conversation never started, and workers (the command is for the orchestrators)', async (t) => {
  const { sessions, make } = setup(t);
  const fresh = make();
  assert.throws(() => sessions.compact(fresh.info.id), /no conversation to compact yet/);
  assert.equal(fresh.live, false);
  const w = make('worker');
  assert.throws(() => sessions.compact(w.info.id), /orchestrators' chats/);
});
