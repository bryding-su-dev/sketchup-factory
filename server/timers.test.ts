import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TIMER_LIMITS, Timers, nextDaily, type TimerHost } from './timers.ts';

const T0 = Date.parse('2026-10-04T12:00:00Z');
const MIN = 60_000;

/** A clock, a host with two orchestrators ("orch", "other") whose busy flag a test sets, and the messages delivered. */
function setup(t: { after: (fn: () => void) => void }, dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-timers-'))) {
  const file = path.join(dir, 'timers.json');
  const sent: { id: string; text: string }[] = [];
  const busy = new Set<string>();
  const clock = { now: T0 };
  let refuse = false;
  const host: TimerHost = {
    exists: (id) => id === 'orch' || id === 'other',
    busy: (id) => busy.has(id),
    deliver: (id, text) => {
      if (refuse) throw new Error('the agent limit');
      sent.push({ id, text });
    },
  };
  const make = () => {
    const ts = new Timers(host, file);
    ts.now = () => clock.now;
    ts.random = () => 0.5;
    return ts;
  };
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { make, sent, busy, clock, file, dir, setRefuse: (v: boolean) => (refuse = v), advance: (ms: number) => (clock.now += ms) };
}

test('timers: every N minutes fires again and again, untouched by anything but cancel', (t) => {
  const { make, sent, advance } = setup(t);
  const ts = make();
  const timer = ts.create('orch', { title: 'FFBox desync scan', note: 'Check FFBox for new desync PRs.', schedule: { every_minutes: 60 } }, 'lothsahn');
  assert.match(timer.id, /^t-[0-9a-f]{8}$/);
  assert.equal(timer.nextFireAt, new Date(T0 + 60 * MIN).toISOString());
  ts.tick();
  assert.equal(sent.length, 0, 'not before its time');
  for (let i = 1; i <= 3; i++) {
    advance(60 * MIN);
    ts.tick();
    assert.equal(sent.length, i, `fire ${i}`);
  }
  assert.match(sent[0].text, /^\[timer t-[0-9a-f]{8} "FFBox desync scan"\] Check FFBox for new desync PRs\./);
  assert.match(sent[0].text, /carries no one's authority/);
  assert.equal(ts.list('orch')[0].fires, 3);
  ts.cancel('orch', timer.id);
  advance(120 * MIN);
  ts.tick();
  assert.equal(sent.length, 3, 'cancelled: no more');
  assert.equal(ts.list('orch')[0].state, 'ended');
});

test('timers: a fire while the orchestrator is mid-turn waits for the turn, and fires that pile up are coalesced', (t) => {
  const { make, sent, busy, advance } = setup(t);
  const ts = make();
  ts.create('orch', { title: 'scan', note: 'scan it', schedule: { every_minutes: 10 } }, 'ben');
  ts.create('orch', { title: 'tidy', note: 'tidy up', schedule: { every_minutes: 10 } }, 'ben');
  busy.add('orch');
  advance(10 * MIN);
  ts.tick();
  advance(10 * MIN);
  ts.tick();
  assert.equal(sent.length, 0, 'never into a running turn');
  assert.deepEqual(ts.list('orch').map((x) => x.pending), [2, 2]);
  busy.delete('orch');
  ts.turnEnded('orch');
  assert.equal(sent.length, 1, 'one message after the turn, for both timers');
  assert.match(sent[0].text, /\[timer t-\w+ "scan"\] scan it\n\(fired 2 times since it was last delivered\)/);
  assert.match(sent[0].text, /\[timer t-\w+ "tidy"\] tidy up/);
  ts.turnEnded('orch');
  assert.equal(sent.length, 1, 'never twice');
  // skip_if_busy: a fire during a turn is skipped, not delivered after it.
  const skip = ts.create('other', { title: 'pulse', note: 'p', schedule: { every_minutes: 5 }, skip_if_busy: true }, 'ben');
  busy.add('other');
  advance(5 * MIN);
  ts.tick();
  busy.delete('other');
  ts.turnEnded('other');
  assert.equal(sent.filter((m) => m.id === 'other').length, 0);
  assert.equal(ts.list('other').find((x) => x.id === skip.id)!.skipped, 1);
});

test('timers: survive a restart, and what came due while FF Factory was down is delivered once with the missed count', (t) => {
  const s = setup(t);
  const before = s.make();
  const every = before.create('orch', { title: 'hourly', note: 'look', schedule: { every_minutes: 60 } }, 'ben');
  const once = before.create('orch', { title: 'once', note: 'one shot', schedule: { at: new Date(T0 + 30 * MIN).toISOString() } }, 'ben');
  before.stop();
  // Down for five hours.
  s.advance(5 * 60 * MIN + 5 * MIN);
  const after = s.make();
  assert.equal(after.start(), 2, 'both loaded from data/timers.json');
  after.stop();
  assert.equal(s.sent.length, 1, 'one message for everything that came due');
  assert.match(s.sent[0].text, /"hourly"\] look\n\(5 fire\(s\) missed while FF Factory was down\)/);
  assert.match(s.sent[0].text, /"once"\] one shot\n\(1 fire\(s\) missed while FF Factory was down; its one fire: it has ended\)/);
  const list = after.list('orch');
  const h = list.find((x) => x.id === every.id)!;
  assert.equal(h.state, 'active');
  assert.ok(Date.parse(h.nextFireAt!) > s.clock.now, 'the next fire is in the future, not a burst of the missed ones');
  assert.equal(list.find((x) => x.id === once.id)!.state, 'ended');
  // The file is the durable writer's: a third start reads the same timers.
  const third = s.make();
  assert.equal(third.start(), 2);
  third.stop();
});

test('timers: caps, schedules and what is refused', (t) => {
  const { make, advance } = setup(t);
  const ts = make();
  assert.throws(() => ts.create('orch', { title: 'x', note: 'y', schedule: { every_minutes: 4 } }, 'ben'), /at least|from 5/);
  assert.throws(() => ts.create('orch', { title: 'x', note: 'y', schedule: {} }, 'ben'), /exactly one of/);
  assert.throws(() => ts.create('orch', { title: 'x', note: 'y', schedule: { every_minutes: 10, daily: '09:00' } }, 'ben'), /exactly one of/);
  assert.throws(() => ts.create('orch', { title: 'x', note: 'y', schedule: { at: '2026-10-04T11:00:00Z' } }, 'ben'), /passed/);
  assert.throws(() => ts.create('orch', { title: 'x', note: 'y', schedule: { daily: '25:00' } }, 'ben'), /HH:MM/);
  assert.throws(() => ts.create('orch', { title: 'x', note: 'y', schedule: { daily: '09:00', tz: 'Mars/Olympus' } }, 'ben'), /IANA/);
  assert.throws(() => ts.create('orch', { title: '', note: 'y', schedule: { every_minutes: 10 } }, 'ben'), /title/);
  assert.throws(() => ts.create('nobody', { title: 'x', note: 'y', schedule: { every_minutes: 10 } }, 'ben'), /no such orchestrator/);
  for (let i = 0; i < TIMER_LIMITS.activePerOwner; i++) ts.create('orch', { title: `t${i}`, note: 'n', schedule: { every_minutes: 60 } }, 'ben');
  assert.throws(() => ts.create('orch', { title: 'one too many', note: 'n', schedule: { every_minutes: 60 } }, 'ben'), /at most 20 are active/);
  // Ownership: another orchestrator can neither see nor touch them.
  const mine = ts.list('orch')[0];
  assert.equal(ts.list('other').length, 0);
  assert.throws(() => ts.cancel('other', mine.id), /no timer .* of yours/);
  assert.throws(() => ts.update('other', mine.id, { enabled: false }), /no timer .* of yours/);
  // A daily time in a zone: the next 09:30 in New York after 12:00Z on 2026-10-04 is 13:30Z the same day (EDT).
  assert.equal(new Date(nextDaily('09:30', 'America/New_York', T0)).toISOString(), '2026-10-04T13:30:00.000Z');
  assert.equal(new Date(nextDaily('09:30', 'Europe/Berlin', T0)).toISOString(), '2026-10-05T07:30:00.000Z');
  // max_fires and until end it.
  const capped = make();
  const two = capped.create('other', { title: 'twice', note: 'n', schedule: { every_minutes: 5 }, max_fires: 2 }, 'ben');
  const until = capped.create('other', { title: 'until', note: 'n', schedule: { every_minutes: 5 }, until: new Date(T0 + 12 * MIN).toISOString() }, 'ben');
  for (let i = 0; i < 4; i++) {
    advance(5 * MIN);
    capped.tick();
  }
  const l = capped.list('other');
  assert.deepEqual([l.find((x) => x.id === two.id)!.endReason, l.find((x) => x.id === two.id)!.fires], ['max_fires', 2]);
  assert.equal(l.find((x) => x.id === until.id)!.endReason, 'until');
});

test('timers: pause and resume; resumed it counts on from now, owing nothing for the pause', (t) => {
  const { make, sent, advance, clock } = setup(t);
  const ts = make();
  const x = ts.create('orch', { title: 'p', note: 'n', schedule: { every_minutes: 10 } }, 'ben');
  ts.update('orch', x.id, { enabled: false });
  advance(60 * MIN);
  ts.tick();
  assert.equal(sent.length, 0, 'paused: nothing');
  ts.update('orch', x.id, { enabled: true });
  assert.equal(ts.list('orch')[0].nextFireAt, new Date(clock.now + 10 * MIN).toISOString());
  advance(10 * MIN);
  ts.tick();
  assert.equal(sent.length, 1);
  assert.doesNotMatch(sent[0].text, /missed/);
});

test('timers: the budget holds fires past 96 messages a day, coalesced, and the next message says so; a refused delivery is tried again', (t) => {
  const { make, sent, advance, setRefuse } = setup(t);
  const ts = make();
  ts.create('orch', { title: 'fast', note: 'n', schedule: { every_minutes: 5 } }, 'ben');
  for (let i = 0; i < TIMER_LIMITS.deliveriesPerDay; i++) {
    advance(5 * MIN);
    ts.tick();
  }
  assert.equal(sent.length, TIMER_LIMITS.deliveriesPerDay);
  advance(5 * MIN);
  ts.tick();
  advance(5 * MIN);
  ts.tick();
  assert.equal(sent.length, TIMER_LIMITS.deliveriesPerDay, 'held by the budget');
  assert.equal(ts.list('orch')[0].pending, 2, 'coalesced, not dropped');
  // The window moves on: the oldest message leaves it.
  advance(24 * 60 * MIN - 2 * 5 * MIN - 5 * MIN + 1);
  setRefuse(true);
  ts.tick();
  assert.equal(sent.length, TIMER_LIMITS.deliveriesPerDay, 'the agent limit: not delivered, still pending');
  setRefuse(false);
  ts.tick();
  const last = sent.at(-1)!.text;
  assert.match(last, /waited for the timer budget/);
});

test('timers: a new conversation keeps them (rehome to the new session)', (t) => {
  const { make } = setup(t);
  const ts = make();
  const x = ts.create('orch', { title: 'keep me', note: 'n', schedule: { every_minutes: 30 } }, 'ben');
  assert.equal(ts.rehome('orch', 'other'), 1);
  assert.deepEqual(ts.list('other').map((v) => v.id), [x.id]);
  assert.equal(ts.list('orch').length, 0);
  assert.equal(ts.rehome('nobody', 'orch'), 0);
});
