import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Requester, WorkItem } from '../shared/types.ts';
import { isMine, ledgerOrder, STATUS_RANK } from '../shared/workOrder.ts';

const BEN: Requester = { userId: 'ben', displayName: 'Ben' };
const LOTH: Requester = { userId: 'lothsahn', displayName: 'Lothsahn' };

/** A request; `age` orders createdAt (lower is older) and updatedAt (higher is newer). */
function item(status: WorkItem['status'], people: Requester[], age: number, priority: WorkItem['priority'] = 'normal'): WorkItem {
  const at = new Date(Date.UTC(2026, 9, 1, 0, age)).toISOString();
  const title = `${status} ${priority === 'normal' ? '' : `${priority} `}${people.map((p) => p.userId).join('+')} ${age}`;
  return { id: `w${age}`, title, status, priority, requesters: people, createdAt: at, updatedAt: at } as WorkItem;
}

const titles = (xs: WorkItem[]) => xs.map((w) => w.title);

// Every status group, each with Lothsahn's older request and Ben's newer one, and one of both of theirs in "new".
const LEDGER = [
  item('active', [LOTH], 1),
  item('active', [BEN], 2),
  item('new', [LOTH], 3),
  item('new', [BEN], 4),
  item('new', [LOTH, BEN], 5),
  item('question', [LOTH], 6),
  item('question', [BEN], 7),
  item('queued', [LOTH], 8),
  item('queued', [BEN], 9),
  item('done', [BEN], 10),
  item('merged', [LOTH], 11),
  item('cancelled', [BEN], 12),
  item('rejected', [LOTH], 13),
];

test('the status groups keep their order for every viewer: question, new, queued, active, then the closed ones', () => {
  const groups = (viewer: string | undefined) => ledgerOrder(LEDGER, viewer).map((w) => STATUS_RANK[w.status]);
  for (const viewer of [undefined, 'ben', 'lothsahn', 'nobody']) {
    const g = groups(viewer);
    assert.deepEqual(g, [...g].sort((a, b) => a - b), String(viewer));
    assert.deepEqual([...new Set(g)], [0, 1, 2, 3, 4], String(viewer));
  }
  assert.deepEqual(Object.entries(STATUS_RANK).map(([s, r]) => `${s}:${r}`), ['question:0', 'new:1', 'queued:2', 'active:3', 'done:4', 'merged:4', 'rejected:4', 'cancelled:4']);
});

test('within each status group the viewer’s requests come first: Ben sees his first, Lothsahn his', () => {
  assert.deepEqual(titles(ledgerOrder(LEDGER, 'ben')), [
    'question ben 7',
    'question lothsahn 6',
    // Both of these are his (he is one of the people of the second); among his own, oldest first.
    'new ben 4',
    'new lothsahn+ben 5',
    'new lothsahn 3',
    'queued ben 9',
    'queued lothsahn 8',
    'active ben 2',
    'active lothsahn 1',
    // Closed: his first, each part newest first.
    'cancelled ben 12',
    'done ben 10',
    'rejected lothsahn 13',
    'merged lothsahn 11',
  ]);
  assert.deepEqual(titles(ledgerOrder(LEDGER, 'lothsahn')), [
    'question lothsahn 6',
    'question ben 7',
    'new lothsahn 3',
    'new lothsahn+ben 5',
    'new ben 4',
    'queued lothsahn 8',
    'queued ben 9',
    'active lothsahn 1',
    'active ben 2',
    'rejected lothsahn 13',
    'merged lothsahn 11',
    'cancelled ben 12',
    'done ben 10',
  ]);
});

test('priority comes before "yours": an urgent request of someone else’s is above your normal one, yours first within a priority', () => {
  const work = [
    item('new', [BEN], 1, 'low'),
    item('new', [LOTH], 2, 'normal'),
    item('new', [BEN], 3, 'normal'),
    item('new', [LOTH], 4, 'urgent'),
    item('new', [LOTH], 5, 'high'),
    item('new', [BEN], 6, 'high'),
    item('new', [BEN], 7, 'urgent'),
  ];
  assert.deepEqual(titles(ledgerOrder(work, 'ben')), ['new urgent ben 7', 'new urgent lothsahn 4', 'new high ben 6', 'new high lothsahn 5', 'new ben 3', 'new lothsahn 2', 'new low ben 1']);
  assert.deepEqual(titles(ledgerOrder(work, 'lothsahn')), ['new urgent lothsahn 4', 'new urgent ben 7', 'new high lothsahn 5', 'new high ben 6', 'new lothsahn 2', 'new ben 3', 'new low ben 1']);
});

test('without a viewer (or one with no requests) the order is the ledger’s as before: priority, then oldest first; closed newest first', () => {
  const before = ['question lothsahn 6', 'question ben 7', 'new lothsahn 3', 'new ben 4', 'new lothsahn+ben 5', 'queued lothsahn 8', 'queued ben 9', 'active lothsahn 1', 'active ben 2', 'rejected lothsahn 13', 'cancelled ben 12', 'merged lothsahn 11', 'done ben 10'];
  assert.deepEqual(titles(ledgerOrder(LEDGER, undefined)), before);
  assert.deepEqual(titles(ledgerOrder(LEDGER, 'nobody')), before);
});

test('yours: any of the item’s people, whatever the case of the login', () => {
  const shared = item('new', [LOTH, BEN], 1);
  assert.equal(isMine(shared, 'ben'), true);
  assert.equal(isMine(shared, 'Lothsahn'), true);
  assert.equal(isMine(shared, 'someone'), false);
  assert.equal(isMine(shared, undefined), false);
});
