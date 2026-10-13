import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Config } from './config.ts';
import { ROUTINE_MODEL_DEFAULT, TurnModels, messageTag, turnKind } from './turnModel.ts';

const cfg = (o: Partial<Config['orchestrator']> = {}) => ({ orchestrator: { model: 'opus', ...o } }) as Pick<Config, 'orchestrator'>;
const personal = { id: 'p1', kind: 'orchestrator' as const, orchestratorRole: 'personal' as const };
const dispatcher = { id: 'd1', kind: 'orchestrator' as const, orchestratorRole: 'dispatcher' as const };

test('a message tag is read from the first bracket', () => {
  assert.equal(messageTag('[work request] w1 …'), 'work request');
  assert.equal(messageTag('[timer t-1 "x"] go'), 'timer t-1');
  assert.equal(messageTag('no tag'), undefined);
});

test('a person turns run on the coordinator, decisions on its own model, the rest is routine', () => {
  assert.equal(turnKind('personal', 'human', 'hi'), 'person');
  assert.equal(turnKind('dispatcher', 'system', '[work request] w5'), 'own');
  assert.equal(turnKind('dispatcher', 'system', '[ledger] capacity'), 'own');
  assert.equal(turnKind('personal', 'system', '[reaction] 👍'), 'own');
  assert.equal(turnKind('personal', 'system', '[worker update] done'), 'routine');
  assert.equal(turnKind('dispatcher', 'system', '[reaction] x'), 'routine');
});

test('routine turns go to Sonnet, a person keeps Opus, and a routine turn shortly after Opus stays on it', () => {
  let t = 1_000_000;
  const m = new TurnModels(() => cfg(), () => t);
  assert.deepEqual(m.pick(personal, 'system', '[worker update] done', true), { model: ROUTINE_MODEL_DEFAULT, kind: 'routine' });
  assert.deepEqual(m.pick(personal, 'human', 'hello', true), { model: 'opus', kind: 'person' });
  t += 10 * 60_000;
  assert.equal(m.pick(personal, 'system', '[worker update] done', true)?.model, 'opus', 'inside the 60 minute window');
  t += 61 * 60_000;
  assert.equal(m.pick(personal, 'system', '[worker update] done', true)?.model, ROUTINE_MODEL_DEFAULT);
});

test('a message joining a running turn changes nothing, except a person\'s', () => {
  const m = new TurnModels(() => cfg());
  assert.equal(m.pick(dispatcher, 'system', '[ledger] x', false), undefined);
  assert.equal(m.pick(dispatcher, 'system', '[worker update] x', false), undefined);
  assert.deepEqual(m.pick(dispatcher, 'human', 'hi', false), { model: 'opus', kind: 'person' });
});

test('routineModel "off" keeps every turn on the coordinator model; workers are never touched', () => {
  const m = new TurnModels(() => cfg({ routineModel: 'off' }));
  assert.equal(m.pick(personal, 'system', '[worker update] done', true)?.model, 'opus');
  assert.equal(m.pick({ id: 'w', kind: 'worker' }, 'system', '[x] y', true), undefined);
});
