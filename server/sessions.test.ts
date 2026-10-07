import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionManager, setQueryForTesting } from './sessions.ts';
import { fakeQuery } from '../e2e/fakeAgent.ts';
import { Store } from './store.ts';
import type { Config } from './config.ts';

test('agent titles: one line, trimmed, at most 80 characters, and stored', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-sessions-'));
  const store = new Store(dir);
  t.after(() => {
    store.flush();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const sessions = new SessionManager({ limits: { maxSessions: 6 } } as Config, store);
  const s = sessions.create({ kind: 'worker', title: 'Fix the null reference in BeltSystem when splitting', permissionMode: 'default', options: () => ({}) });
  assert.equal(sessions.setTitle(s.info.id, '  Belt splitter\n fix  (spec 098) '), 'Belt splitter fix (spec 098)');
  assert.equal(store.sessions.get(s.info.id)!.title, 'Belt splitter fix (spec 098)');
  assert.throws(() => sessions.setTitle(s.info.id, '   '), /empty/);
  assert.throws(() => sessions.setTitle(s.info.id, 'x'.repeat(81)), /80/);
  assert.throws(() => sessions.setTitle('nope', 'x'), /no session/);
});

test('turnFrom (w607): a message folded into a turn keeps its starter; a queued one answered in a turn of its own is that turn\'s starter', async (t) => {
  // A scripted CLI: the test says when each message is answered, and whether the turn goes on.
  const seen: { uuid: string; text: string }[] = [];
  const out: unknown[] = [];
  let wake: (() => void) | undefined;
  const emit = (m: unknown) => {
    out.push(m);
    wake?.();
  };
  setQueryForTesting((({ prompt }: { prompt: AsyncIterable<{ uuid: string; message: { content: unknown } }> }) => {
    void (async () => {
      for await (const m of prompt) seen.push({ uuid: m.uuid, text: String(m.message.content) });
    })();
    return (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'scripted', model: 'm', uuid: 'init' };
      for (;;) {
        while (!out.length) await new Promise<void>((r) => (wake = r));
        yield out.shift();
      }
    })();
  }) as never);
  t.after(() => setQueryForTesting(fakeQuery() as never));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-turnfrom-'));
  const store = new Store(dir);
  const sessions = new SessionManager({} as Config, store);
  const s = sessions.create({ kind: 'orchestrator', title: 'Lothsahn', permissionMode: 'bypassPermissions', options: () => ({}) });
  const state = (st: string) => emit({ type: 'system', subtype: 'session_state_changed', state: st, session_id: 'scripted', uuid: `st-${Math.random()}` });
  const result = (uuids: string[]) => emit({ type: 'result', subtype: 'success', is_error: false, result: 'ok', total_cost_usd: 0, num_turns: 1, duration_ms: 1, user_message_uuids: uuids, session_id: 'scripted', uuid: `r-${Math.random()}` });
  const settle = () => new Promise((r) => setTimeout(r, 30));
  const person = sessions.send(s.info.id, 'Please drain and install on BEAST and m5', 'human');
  state('running');
  await settle();
  const update = sessions.send(s.info.id, '[worker update] w602 finished a turn', 'system');
  assert.equal(s.turnFrom, 'human', 'delivered mid-turn: the turn stays the person\'s');
  // The CLI answers the person's message alone; the update waited and gets a turn of its own: the harness's.
  result([person]);
  await settle();
  assert.equal(s.turnFrom, 'system');
  result([update]);
  state('idle');
  await settle();
  // No turn now: the last sender, as before.
  assert.equal(s.turnFrom, 'system');
  // Folded: a person's message and an update answered by one result keep the person's turn to the end.
  const go = sessions.send(s.info.id, 'go', 'human');
  state('running');
  await settle();
  const later = sessions.send(s.info.id, '[dispatch] w596 started', 'system');
  assert.equal(s.turnFrom, 'human');
  result([go, later]);
  await settle();
  assert.equal(s.turnFrom, 'human');
  state('idle');
  await settle();
  assert.equal(seen.length, 4);
});
