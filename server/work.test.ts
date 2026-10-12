import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LIMITS,
  MAX_ASKS,
  STRONG,
  decisionProblem,
  dispatchNotice,
  findOverlaps,
  handoffNote,
  ledgerOrder,
  limitProblem,
  limitsFor,
  normalizeTitle,
  overlapOf,
  pruneIds,
  relatedKeys,
  repeatOf,
  requestNotice,
  textKeys,
  updateProblem,
  type PoolEntry,
} from './work.ts';
import { parseNotice } from '../shared/notices.ts';
import type { Requester, WorkItem } from '../shared/types.ts';

/** The ledger's rules (server/work.ts, docs/orchestrators.md): keys, overlaps, limits, status changes, the lines people read. */

const BEN: Requester = { userId: 'ben', displayName: 'Ben' };
const LOTH: Requester = { userId: 'lothsahn', displayName: 'Lothsahn' };
const T0 = Date.parse('2026-09-28T12:00:00Z');

function item(id: string, patch: Partial<WorkItem> = {}): WorkItem {
  return {
    id,
    title: `Request ${id}`,
    brief: 'Do it.',
    priority: 'normal',
    keys: [],
    requestedBy: BEN,
    requesters: [BEN],
    humanAsked: true,
    status: 'new',
    createdAt: new Date(T0).toISOString(),
    updatedAt: new Date(T0).toISOString(),
    sessionIds: [],
    overlaps: [],
    asks: 0,
    log: [],
    ...patch,
  };
}

test('keys: specs, PRs and known branches, whatever way they are written', () => {
  assert.deepEqual(textKeys('Fix the belt desync from spec 98').sort(), ['spec:098']);
  assert.deepEqual(textKeys('see specs/098-belt-splitter/plan.md').sort(), ['spec:098']);
  assert.deepEqual(textKeys('continue on 098-belt-splitter').sort(), ['spec:098']);
  assert.deepEqual(textKeys('PR #412, pull request 413 and /pull/414').sort(), ['pr:412', 'pr:413', 'pr:414']);
  // A bare "#N" may be an issue, a bug or a colour: a reference, not a PR.
  assert.deepEqual(textKeys('Bug #1 again, colour #123456').sort(), ['ref:1', 'ref:123456']);
  assert.deepEqual(textKeys('PR #7 (#7)'), ['pr:7']);
  assert.deepEqual(textKeys('rebase sandbox/shader-dissolve on develop', ['sandbox/shader-dissolve', 'develop']), ['branch:sandbox/shader-dissolve']);
  // A branch name inside a longer word is not a mention; develop/main are never keys; nor is a branch named like a plain word.
  assert.deepEqual(textKeys('the shader-dissolved look', ['shader-dissolve']), []);
  assert.deepEqual(textKeys('merge develop into main', ['develop', 'main']), []);
  assert.deepEqual(textKeys('update the docs and the audio', ['docs', 'audio']), []);
});

test('keys: a Discord thread by its link or bare id is discord:<thread>, never a watched channel; a report id is report:<id>', () => {
  const DEV = '1012843817981976686';
  const channels = new Set([DEV]);
  assert.deepEqual(textKeys('see https://discord.com/channels/530867164866150410/1554582984567562253'), ['discord:1554582984567562253']);
  assert.deepEqual(textKeys('https://discord.com/channels/530867164866150410/1554582984567562253/1554582984567562299'), ['discord:1554582984567562253'], 'a message inside a thread names the thread');
  assert.deepEqual(textKeys(`https://discord.com/channels/530867164866150410/${DEV}/1554500000000000001`, [], channels), ['discord:1554500000000000001'], 'a message in #dev-chat: its root message, not the channel');
  assert.deepEqual(textKeys('#bug-reports threads 1554582984567562253 and 1554588033704005712').sort(), ['discord:1554582984567562253', 'discord:1554588033704005712']);
  assert.deepEqual(textKeys(`posted in #dev-chat (${DEV})`, [], channels), [], 'the channel itself is not a piece of work');
  assert.deepEqual(textKeys('build 12345678901234 and sha abc1554582984567562253def'), [], 'not a snowflake: too short, or inside a word');
  assert.deepEqual(textKeys('report 20260927T090000Z-desync-3a9f01c2d4 again'), ['report:20260927T090000Z-desync-3a9f01c2d4']);
  // Shared, they are the same work.
  assert.equal(overlapOf({ keys: ['discord:1554582984567562253'], title: 'x' }, { ref: 'w50', kind: 'work', title: 'y', keys: ['discord:1554582984567562253'] })?.score, 1);
});

test('keys: related ids resolve to what they are, and the rest is read as text', () => {
  const known = { work: (id: string) => id === 'w3', session: (id: string) => id === 'ab12cd34', delegation: (id: string) => id === 'd1', sandbox: (id: string) => id === 'alpha', machine: (id: string) => id.toLowerCase() === 'm3' };
  assert.deepEqual(relatedKeys(['w3', 'ab12cd34', 'd1', 'alpha', 'M3', '098', 'PR 412', '099-new-thing', 'desync'], known).sort(), [
    'branch:099-new-thing',
    'delegation:d1',
    'machine:m3',
    'pr:412',
    'sandbox:alpha',
    'session:ab12cd34',
    'spec:098',
    'spec:099',
    'work:w3',
  ]);
});

test('overlaps: a shared request, worker, PR or branch is the same work; a shared spec needs a similar title to be strong', () => {
  const req = { keys: ['spec:098', 'pr:412'], title: 'Fix the belt splitter desync' };
  const e = (ref: string, title: string, keys: string[]): PoolEntry => ({ ref, kind: 'work', title, keys });
  assert.deepEqual(overlapOf(req, e('w1', 'Anything at all', ['pr:412'])), { ref: 'w1', kind: 'work', title: 'Anything at all', score: 1, why: 'same PR #412' });
  assert.equal(overlapOf(req, e('w2', 'Belt splitter desync on load', ['spec:098']))?.score, STRONG);
  assert.equal(overlapOf(req, e('w2', 'Belt splitter desync on load', ['spec:098']))?.why, 'same spec 098, similar title');
  // A shared bare "#N" is like a shared spec: strong only with a similar title.
  assert.equal(overlapOf({ keys: ['ref:1'], title: 'Crash on load' }, e('w7', 'Tutorial text is wrong', ['ref:1']))?.score, 0.5);
  // Same spec, different job: listed for the dispatcher, not strong.
  const playtest = overlapOf(req, e('w3', 'Playtest the tutorial', ['spec:098']));
  assert.equal(playtest?.score, 0.5);
  assert.equal(playtest?.why, 'same spec 098');
  // Nothing shared, similar words: by similarity; identical titles are strong.
  assert.equal(overlapOf({ keys: [], title: 'Fix the belt splitter desync' }, e('w4', 'fix belt splitter desync!', []))?.score, 1);
  assert.equal(overlapOf({ keys: [], title: 'Fix the belt splitter desync' }, e('w5', 'Shader bloom looks washed out', [])), undefined);
  // A sandbox is a place, not a piece of work.
  assert.equal(overlapOf({ keys: ['sandbox:alpha'], title: 'Playtest' }, e('w6', 'Refactor inventory', ['sandbox:alpha'])), undefined);
});

test('overlaps: the five strongest, strongest first', () => {
  // w1..w7 add 1..7 words of their own to the same title; w5 also names the same PR.
  const extra = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf'];
  const pool: PoolEntry[] = Array.from({ length: 7 }, (_, i) => ({ ref: `w${i + 1}`, kind: 'work' as const, title: `Fix belt splitter desync ${extra.slice(0, i + 1).join(' ')}`, keys: i === 4 ? ['pr:9'] : [] }));
  const found = findOverlaps({ keys: ['pr:9'], title: 'Fix belt splitter desync' }, pool);
  assert.deepEqual(found.map((o) => o.ref), ['w5', 'w1', 'w2', 'w3', 'w4']);
  assert.deepEqual(found.map((o) => o.score), [1, 0.8, 0.67, 0.57, 0.5]);
});

test('limits: people are never capped; standing agents and the intake are, each configurable', () => {
  const now = T0;
  const many = (n: number) => Array.from({ length: n }, (_, i) => item(`x${i}`, { requestedBy: BEN, createdAt: new Date(now - 60_000).toISOString() }));
  assert.equal(limitsFor('person'), undefined);
  assert.equal(limitsFor('person', { standing: { perHour: 1 } }), undefined, 'config caps only the automated sources');
  assert.equal(limitProblem(many(500), BEN, now, limitsFor('person')), undefined, 'a person filing 500 in a minute is not stopped');
  assert.deepEqual(limitsFor('standing'), { perHour: 10, perDay: 40 });
  assert.deepEqual(limitsFor('intake', { intake: { perHour: 3 } }), { perHour: 3, perDay: 40 });
  assert.deepEqual(limitsFor('standing', { intake: { perHour: 3 } }), { perHour: 10, perDay: 40 }, "one source's setting is its own");
  assert.match(limitProblem(many(3), BEN, now, limitsFor('intake', { intake: { perHour: 3 } }))!, /3 requests in the last hour/);
});

test('limits: an automated source per requester per hour and per day; a repeat of an open request is found by its title', () => {
  const now = T0;
  const recent = (n: number, who: Requester, agoMin: number) => Array.from({ length: n }, (_, i) => item(`x${i}`, { requestedBy: who, createdAt: new Date(now - agoMin * 60_000).toISOString() }));
  assert.equal(limitProblem(recent(LIMITS.perHour - 1, BEN, 5), BEN, now, LIMITS), undefined);
  assert.match(limitProblem(recent(LIMITS.perHour, BEN, 5), BEN, now, LIMITS)!, /10 requests in the last hour/);
  assert.equal(limitProblem(recent(LIMITS.perHour, LOTH, 5), BEN, now, LIMITS), undefined, "someone else's filings do not count");
  assert.match(limitProblem(recent(LIMITS.perDay, BEN, 120), BEN, now, LIMITS)!, /40 requests today/);
  const open = item('w1', { title: 'Fix the Belt desync!' });
  assert.equal(repeatOf([open], BEN, 'fix the belt   desync')?.id, 'w1');
  assert.equal(repeatOf([open], LOTH, 'fix the belt desync'), undefined);
  assert.equal(repeatOf([{ ...open, status: 'done' }], BEN, 'fix the belt desync'), undefined);
  assert.equal(normalizeTitle('  Fix: the belt—desync! '), 'fix the belt desync');
});

test('decisions: merge only into another open request, at most three questions, nothing on a closed one', () => {
  const w = item('w2');
  assert.match(decisionProblem(w, 'merge')!, /needs into/);
  assert.match(decisionProblem(w, 'merge', w)!, /itself/);
  assert.match(decisionProblem(w, 'merge', item('w1', { status: 'done' }))!, /only into an open request/);
  assert.match(decisionProblem(w, 'merge', item('w1', { status: 'merged', mergedInto: 'w0' }))!, /merge into w0/);
  assert.equal(decisionProblem(w, 'merge', item('w1', { status: 'active' })), undefined);
  assert.match(decisionProblem({ ...w, asks: MAX_ASKS }, 'ask')!, /already 3 questions/);
  assert.match(decisionProblem({ ...w, status: 'rejected' }, 'queue')!, /w2 is rejected/);
  assert.equal(decisionProblem({ ...w, status: 'active' }, 'link'), undefined);
  assert.match(decisionProblem({ ...w, status: 'active' }, 'merge', item('w1'))!, /w2 is active/);
});

test('updates: reopen only a closed request within a week; a merged one points to where it went', () => {
  const now = T0 + 3 * 86_400_000;
  assert.equal(updateProblem(item('w1', { status: 'done' }), { reopen: true }, now), undefined);
  assert.match(updateProblem(item('w1', { status: 'done' }), { reopen: true }, T0 + 8 * 86_400_000)!, /more than 7 days/);
  assert.match(updateProblem(item('w1'), { reopen: true }, now)!, /only a done, rejected or cancelled/);
  assert.match(updateProblem(item('w1', { status: 'merged', mergedInto: 'w0' }), { close: 'cancelled' }, now)!, /update w0/);
  assert.equal(updateProblem(item('w1', { status: 'question' }), { close: 'cancelled' }, now), undefined);
});

test('ledger order and pruning: questions first, then by priority and age; every open request is kept', () => {
  const list = [
    item('w1', { status: 'active' }),
    item('w2', { status: 'new', priority: 'low' }),
    item('w3', { status: 'new', priority: 'urgent' }),
    item('w4', { status: 'question' }),
    item('w5', { status: 'done', updatedAt: new Date(T0 + 5000).toISOString() }),
    item('w6', { status: 'merged', updatedAt: new Date(T0 + 9000).toISOString() }),
  ];
  assert.deepEqual([...list].sort(ledgerOrder).map((w) => w.id), ['w4', 'w3', 'w2', 'w1', 'w6', 'w5']);
  const closed = Array.from({ length: 5 }, (_, i) => item(`c${i}`, { status: 'done', updatedAt: new Date(T0 + i * 1000).toISOString() }));
  assert.deepEqual(pruneIds([...closed, item('open')], 3).sort(), ['c0', 'c1']);
});

test('lines: the dispatcher reads the request and the overlap check; people see the decision as a notice', () => {
  const w = item('w13', { title: 'Fix belt desync', priority: 'high', requestedBy: LOTH, requesters: [LOTH], overlaps: [{ ref: 'w11', kind: 'work', title: 'Belt desync', score: 0.8, why: 'same spec 098, similar title' }] });
  const notice = requestNotice(w);
  assert.match(notice, /^\[work request\] w13 from Lothsahn \(high\): "Fix belt desync"/);
  assert.match(notice, /w11 "Belt desync" \(same spec 098, similar title, strong\)/);
  assert.match(notice, /start_agent with work_id "w13"/);
  const n = parseNotice(notice);
  assert.equal(n.kind, 'work-request');
  assert.equal(n.summary, 'Lothsahn asks: “Fix belt desync”');
  assert.equal(n.workId, 'w13');

  const merged = parseNotice(dispatchNotice(w, 'merged into w11 "Belt desync" (active: worker ab12 "Belt" in alpha), which Ben and Lothsahn will hear about', 'Same fix. Ben started it an hour ago.'));
  assert.equal(merged.kind, 'dispatch');
  assert.equal(merged.workId, 'w13');
  assert.equal(merged.attention, false);
  assert.equal(merged.summary, 'Merged into w11: “Fix belt desync”');
  assert.equal(merged.body, 'w13: merged into w11 "Belt desync" (active: worker ab12 "Belt" in alpha), which Ben and Lothsahn will hear about.\nSame fix. Ben started it an hour ago.');
  const asked = parseNotice(dispatchNotice(w, 'a question', 'Which save shows it?'));
  assert.equal(asked.attention, true);
  assert.equal(asked.summary, 'The dispatcher asks about “Fix belt desync”');
  assert.equal(asked.body, 'Which save shows it?');
});

test('w28: the handoff a fresh worker gets names the earlier work: status, last word, PRs, branches and workers; nothing named, nothing added', () => {
  assert.equal(handoffNote([]), '');
  const note = handoffNote(
    [
      { item: { id: 'w20', title: 'Mac updater', status: 'done', outcome: 'PR 3 merged.\nDetails below', keys: ['pr:3', 'branch:w20-mac-updater', 'spec:020'] }, workers: ['worker ab12 "Mac updater" in decks, branch sandbox/decks'] },
      { item: { id: 'w9', title: 'Upstream port', status: 'active', keys: [] }, workers: [] },
    ],
    ['worker cd34 "Sign-in" in alpha (stopped)'],
  );
  assert.equal(
    note,
    [
      '\n\n---\nHandoff (added by the harness): the earlier work this request names. You start in a fresh session without its conversation; this is what carries over.',
      '- w20 "Mac updater" (done); last word: PR 3 merged. Details below; PR 3, branch w20-mac-updater; worked on by worker ab12 "Mac updater" in decks, branch sandbox/decks',
      '- w9 "Upstream port" (active)',
      '- worker cd34 "Sign-in" in alpha (stopped)',
    ].join('\n'),
  );
});
