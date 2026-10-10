import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { ContextMeter, toolKind, stripCd, listUsd, priceOf, zeroTok, type ModelTok, type TurnUsage } from '../shared/spend.ts';
import { SpendStore, aboutIds, attribute, buildReport, estimateTurn, kindOfWork, namedIdsIn, renderReport, renderRequest, servedAt, type SpendContext } from './spend.ts';
import { DATA_GUARD_DEFAULTS, dataGuardSettings, footprint, gzipFile, planGuard, runDataGuard, type TranscriptFile } from './dataGuard.ts';
import { Store } from './store.ts';
import type { Requester, SessionInfo, TranscriptEvent, WorkItem } from '../shared/types.ts';

/** What a request costs (w859): the categories of tool output, the context meter, attribution, the store, the backfill and the data guard. */

const BEN: Requester = { userId: 'ben', displayName: 'Ben' };
const T0 = Date.parse('2026-10-08T12:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();

const item = (id: string, patch: Partial<WorkItem> = {}): WorkItem =>
  ({ id, title: `Request ${id}`, brief: 'Do it.', priority: 'normal', keys: [], requestedBy: BEN, requesters: [BEN], humanAsked: true, status: 'active', createdAt: iso(T0), updatedAt: iso(T0), sessionIds: [], overlaps: [], asks: 0, log: [], ...patch }) as WorkItem;

const session = (id: string, patch: Partial<SessionInfo> = {}): SessionInfo =>
  ({ id, kind: 'worker', title: `w1: ${id}`, status: 'idle', permissionMode: 'default', createdAt: iso(T0), lastActivityAt: iso(T0), turns: 0, costUsd: 0, pendingPermissions: [], model: 'claude-sonnet-5-5', ...patch }) as SessionInfo;

const tok = (o: Partial<ModelTok[string]>) => ({ ...zeroTok(), ...o });

// ---------------------------------------------------------------------------------------------------------------------
// categories
// ---------------------------------------------------------------------------------------------------------------------

test('toolKind: the kinds of tool output the week showed', () => {
  assert.equal(toolKind('Read', { file_path: 'a/b.cs' }).cat, 'file-read');
  assert.equal(toolKind('Grep', { pattern: 'x' }).cat, 'search');
  assert.equal(toolKind('Edit', {}).cat, 'edit');
  assert.equal(toolKind('mcp__UnityMCP__run_tests', {}).cat, 'mcp-unity');
  assert.equal(toolKind('mcp__machine__read_work', {}).cat, 'mcp-machine');
  assert.equal(toolKind('mcp__machine__wake_me', {}).cat, 'ci-poll');
  assert.equal(toolKind('Agent', {}).cat, 'subagent');
  const bash = (command: string) => toolKind('Bash', { command }).cat;
  assert.equal(bash('cd /f/ffw/x && git status'), 'git');
  assert.equal(bash('cd /f/ffw/x && npx tsc -p .'), 'build-test');
});

test('toolKind: shell commands by what they do, behind the cd prefix', () => {
  const bash = (command: string) => toolKind('Bash', { command }).cat;
  assert.equal(stripCd('cd "/f/a b" && cd x; git log'), 'git log');
  assert.equal(bash('cd /f/x && sed -n "1,50p" server/a.ts'), 'file-read');
  assert.equal(bash('cat server/a.ts | head'), 'file-read');
  assert.equal(bash('grep -rn foo server | head'), 'search');
  assert.equal(bash('gh pr checks 12'), 'ci-poll');
  assert.equal(bash('until gh run view 5 --json status | grep done; do sleep 30; done'), 'ci-poll');
  assert.equal(bash('sleep 120'), 'ci-poll');
  assert.equal(bash('gh pr view 12'), 'git');
  assert.equal(bash('node --test server/a.test.ts'), 'build-test');
  assert.equal(bash('python scripts/x.py'), 'build-test');
  assert.equal(bash('curl https://example.com'), 'shell');
});

test('toolKind: the same range of a file is the same readKey, another range is not', () => {
  const a = toolKind('Bash', { command: "sed -n '10,20p' server/a.ts" });
  const b = toolKind('Bash', { command: "cd /x && sed -n '10,20p' server\\a.ts" });
  const c = toolKind('Bash', { command: "sed -n '30,40p' server/a.ts" });
  assert.equal(a.readKey, b.readKey);
  assert.notEqual(a.readKey, c.readKey);
  assert.equal(toolKind('Read', { file_path: 'x.cs', offset: 0, limit: 100 }).readKey, toolKind('Read', { file_path: 'X.cs', offset: 0, limit: 100 }).readKey);
});

// ---------------------------------------------------------------------------------------------------------------------
// the context meter
// ---------------------------------------------------------------------------------------------------------------------

const sumTok = (cats: Record<string, { tok: number }>) => Object.values(cats).reduce((a, c) => a + c.tok, 0);

test('ContextMeter: every call\'s real tokens are shared out, and the totals are exact', () => {
  const m = new ContextMeter();
  // call 1: the system prompt and the brief are new (10,000 tokens written)
  m.addUser(3500);
  m.call({ id: 'm1', model: 'claude-sonnet-5-5', in: 2, out: 100, cr: 0, cw: 9998 });
  m.addAssistant(350);
  m.addToolUse('t1', 'Read', { file_path: 'a.cs' }, 40);
  // call 2 sees the read result (about 7,000 tokens) and re-reads the 10,000 before it
  m.addToolResult('t1', 24_500);
  m.call({ id: 'm2', model: 'claude-sonnet-5-5', in: 3, out: 50, cr: 10_000, cw: 7_100 });
  const t = m.drain();
  assert.equal(t.calls, 2);
  // input-side tokens + output tokens of both calls
  assert.equal(Math.round(sumTok(t.cats)), 10_000 + 17_103 + 100 + 50);
  assert.ok(t.cats['file-read'].tok > 5_000 && t.cats['file-read'].tok < 7_200, `file-read ${t.cats['file-read'].tok}`);
  assert.ok(t.cats.base.tok > 5_000, 'what no content explains is the base');
  assert.ok(t.cats.assistant.usd > 0);
});

test('ContextMeter: blocks of one call are one call, and later ones only raise the output', () => {
  const m = new ContextMeter();
  m.call({ id: 'm1', in: 1, out: 10, cr: 0, cw: 1000 });
  m.call({ id: 'm1', in: 1, out: 40, cr: 0, cw: 1000 });
  const t = m.drain();
  assert.equal(t.calls, 1);
  assert.equal(t.cats.assistant.tok, 40);
});

test('ContextMeter: a context that shrinks is a compaction; reads after it are re-reads', () => {
  const m = new ContextMeter();
  m.addToolUse('t1', 'Read', { file_path: 'a.cs' }, 10);
  m.call({ id: 'm1', in: 1, out: 5, cr: 0, cw: 50_000 });
  m.addToolResult('t1', 7000);
  m.call({ id: 'm2', in: 1, out: 5, cr: 50_000, cw: 3000 });
  m.addToolUse('t2', 'Read', { file_path: 'a.cs' }, 10);
  m.addToolResult('t2', 7000);
  m.call({ id: 'm3', in: 1, out: 5, cr: 53_000, cw: 3000 }); // the same read again in the same context
  const t1 = m.drain();
  assert.equal(t1.reread?.n, 1);
  assert.equal(t1.reread?.afterCompact, 0);
  assert.ok(t1.cats.reread.tok > 0);
  // compaction: the next call's context is a fifth
  m.call({ id: 'm4', in: 1, out: 5, cr: 0, cw: 12_000 });
  const t2 = m.drain();
  assert.equal(t2.compacted, true);
  // the file read before the compaction is read again after it: the costly pattern, counted as such
  m.addToolUse('t4', 'Read', { file_path: 'a.cs' }, 10);
  m.addToolResult('t4', 7000);
  m.call({ id: 'm5', in: 1, out: 5, cr: 12_000, cw: 3000 });
  const t3 = m.drain();
  assert.equal(t3.reread?.n, 1);
  assert.equal(t3.reread?.afterCompact, 1);
  // and a second read in the new context is an ordinary re-read
  m.addToolUse('t5', 'Read', { file_path: 'a.cs' }, 10);
  m.addToolResult('t5', 7000);
  m.call({ id: 'm6', in: 1, out: 5, cr: 15_000, cw: 3000 });
  const t4 = m.drain();
  assert.equal(t4.reread?.n, 1);
  assert.equal(t4.reread?.afterCompact, 0);
});

// ---------------------------------------------------------------------------------------------------------------------
// attribution
// ---------------------------------------------------------------------------------------------------------------------

test('aboutIds: an [about] line that is never closed does not hang the portal (linear, w859 review)', () => {
  const ids = Array.from({ length: 40 }, (_, i) => `w${i + 1} "t${i}"`).join(', ');
  const t0 = Date.now();
  aboutIds([`[about ${ids}`]);
  assert.ok(Date.now() - t0 < 200, 'an unclosed list');
  assert.deepEqual(aboutIds([`[about ${ids}]\nx`]).length, 40);
});

test('aboutIds: the requests an [about] line names', () => {
  assert.deepEqual(aboutIds(['[about w12 "Fix the belt"]\nplease look']), ['w12']);
  assert.deepEqual(aboutIds(['[about w12 "Fix w99 belt", w13 "Other"]\nx']), ['w12', 'w13']);
  assert.deepEqual(aboutIds(['no line here, but w5 is named']), []);
});

test('namedIdsIn: ids in the first lines of a message, capped', () => {
  assert.deepEqual(namedIdsIn(['[work request] w859 "Portal spend"\nbrief mentions w1 later\n\n\nw2'], 4), ['w859', 'w1']);
  assert.deepEqual(namedIdsIn(['a w1 w2 w3 w4 w5 w6'], 3), ['w1', 'w2', 'w3']);
});

test('servedAt: the request the worker was last sent when the turn began, and those linked since', () => {
  const a = item('w1', { sessionIds: ['s1'], links: { s1: { at: iso(T0), how: 'sent' } } });
  const b = item('w2', { sessionIds: ['s1'], links: { s1: { at: iso(T0 + 3_600_000), how: 'sent' } } });
  const c = item('w3', { sessionIds: ['s1'], links: { s1: { at: iso(T0 + 3_600_000 + 1000), how: 'linked' } } });
  assert.deepEqual(servedAt('s1', [a, b, c], T0 + 1000), ['w1']);
  assert.deepEqual(servedAt('s1', [a, b, c], T0 + 2 * 3_600_000).sort(), ['w2', 'w3']);
  // before any record: the first one
  assert.deepEqual(servedAt('s1', [a, b], T0 - 10_000_000), ['w1']);
  assert.deepEqual(servedAt('nobody', [a], T0), []);
});

test('attribute: a worker goes to its [about] request, else the request it was sent, else its title, else nothing', () => {
  const a = item('w1', { sessionIds: ['s1'], links: { s1: { at: iso(T0), how: 'sent' } } });
  const b = item('w2');
  const w = session('s1', { title: 'w1: x' });
  assert.deepEqual(attribute(w, [a, b], ['[about w2 "t"]\nhi'], T0 + 1000), [{ id: 'w2', weight: 1, how: 'about' }]);
  assert.deepEqual(attribute(w, [a, b], [], T0 + 1000), [{ id: 'w1', weight: 1, how: 'link' }]);
  assert.deepEqual(attribute(session('s9', { title: 'w77: gone from the ledger' }), [a], [], T0), [{ id: 'w77', weight: 1, how: 'link' }]);
  assert.deepEqual(attribute(session('s9', { title: 'scratch' }), [a], [], T0), [{ id: '_unattributed', weight: 1, how: 'bucket' }]);
});

test('attribute: a turn on linked requests is split evenly; orchestrators by the requests their messages name', () => {
  const a = item('w1', { sessionIds: ['s1'], links: { s1: { at: iso(T0), how: 'sent' } } });
  const b = item('w2', { sessionIds: ['s1'], links: { s1: { at: iso(T0 + 1000), how: 'linked' } } });
  assert.deepEqual(attribute(session('s1'), [a, b], [], T0 + 5000).map((x) => [x.id, x.weight]), [['w1', 0.5], ['w2', 0.5]]);
  const disp = session('d', { kind: 'orchestrator', orchestratorRole: 'dispatcher', title: 'Dispatcher' });
  assert.deepEqual(attribute(disp, [a, b], ['[worker update] w1 "x" finished'], T0).map((x) => x.id), ['w1']);
  // a w-number the ledger does not hold is prose
  assert.deepEqual(attribute(disp, [a, b], ['[heartbeat] w9999 is a typo'], T0).map((x) => x.id), ['_dispatcher']);
  const mine = session('p', { kind: 'orchestrator', orchestratorRole: 'personal', requestedBy: BEN });
  assert.deepEqual(attribute(mine, [a], ['hello'], T0).map((x) => x.id), ['_personal:ben']);
  assert.deepEqual(attribute(session('o', { kind: 'ops' as never }), [a], ['do w1 now'], T0).map((x) => x.id), ['w1']);
  assert.deepEqual(attribute(session('o', { kind: 'ops' as never }), [a], ['look around'], T0).map((x) => x.id), ['_ops']);
  assert.deepEqual(attribute(session('g', { kind: 'standing', standingId: 'sentry' }), [a], [], T0).map((x) => x.id), ['_standing:sentry']);
});

test('kindOfWork: release, review, ops, bug fix, investigation, feature', () => {
  const k = (title: string, source?: WorkItem['source']) => kindOfWork({ title, brief: '', source });
  assert.equal(k('Release 0.50.0.93 through CI'), 'release');
  assert.equal(k('Review PR 1370 and merge'), 'review');
  assert.equal(k('Fix the belt desync on load'), 'bug fix');
  assert.equal(k('Investigate why tokens are high'), 'investigation');
  assert.equal(k('Add a spend page to the portal'), 'feature');
  assert.equal(k('Restart the daemon on m5'), 'ops');
  assert.equal(k('Something'), 'other');
  assert.equal(k('Nightly regression', { kind: 'nightly', untrusted: false } as WorkItem['source']), 'investigation');
});

// ---------------------------------------------------------------------------------------------------------------------
// the store
// ---------------------------------------------------------------------------------------------------------------------

function world(items: WorkItem[], sessions: SessionInfo[], results: Record<string, number> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spend-test-'));
  const now = { t: T0 + 10 * 60_000 };
  const ctx: SpendContext = { work: () => items, session: (id) => sessions.find((s) => s.id === id), priorResults: (id) => results[id] ?? 1, now: () => now.t };
  const spend = new SpendStore(dir, ctx);
  return { dir, spend, now, items, sessions };
}

let seq = 0;
const resultEvent = (t: number, usage: TurnUsage | undefined, costUsd: number, durationMs = 60_000): TranscriptEvent => ({ seq: ++seq, t: iso(t), kind: 'result', ok: true, text: 'done', costUsd, turns: 3, durationMs, ...(usage ? { usage } : {}) });
const userEvent = (t: number, text: string): TranscriptEvent => ({ seq: ++seq, t: iso(t), kind: 'user', text, from: 'orchestrator' });

test('a new session\'s first result is exact; the next is the difference of the cumulative totals', () => {
  const w = world([item('w1', { sessionIds: ['s1'], links: { s1: { at: iso(T0), how: 'sent' } } })], [session('s1')]);
  const c1: ModelTok = { 'claude-sonnet-5-5': tok({ in: 10, out: 1000, cr: 100_000, cw: 20_000, usd: 0.5 }) };
  w.spend.observe('s1', resultEvent(T0 + 60_000, { cum: c1 }, 0.5));
  assert.equal(w.spend.request('w1')!.total.usd, 0.5);
  assert.equal(w.spend.request('w1')!.estimated.usd, 0);
  const c2: ModelTok = { 'claude-sonnet-5-5': tok({ in: 15, out: 1800, cr: 260_000, cw: 25_000, usd: 0.9 }), 'claude-opus-5-5': tok({ in: 1, out: 200, cr: 0, cw: 5000, usd: 0.15 }) };
  w.spend.observe('s1', resultEvent(T0 + 120_000, { cum: c2 }, 1.05));
  const r = w.spend.request('w1')!;
  assert.ok(Math.abs(r.total.usd - 1.05) < 1e-9);
  assert.equal(r.models['claude-sonnet-5-5'].cr, 260_000);
  assert.equal(r.models['claude-opus-5-5'].cw, 5000);
  assert.equal(r.turns, 2);
  assert.equal(w.spend.session('s1')!.turns, 2);
  assert.deepEqual(Object.keys(r.sessions), ['s1']);
  assert.equal(r.days['2026-10-08'].usd, r.total.usd);
});

test('a session that ran before: the first sighting is the main loop\'s own usage, estimated; then exact differences', () => {
  const w = world([item('w1', { sessionIds: ['s1'], links: { s1: { at: iso(T0), how: 'sent' } } })], [session('s1')], { s1: 7 });
  const cum1: ModelTok = { 'claude-sonnet-5-5': tok({ in: 100, out: 90_000, cr: 9_000_000, cw: 400_000, usd: 8 }) };
  w.spend.observe('s1', resultEvent(T0 + 60_000, { cum: cum1, main: { in: 5, out: 2000, cr: 200_000, cw: 10_000 } }, 8));
  const r1 = w.spend.request('w1')!;
  const [usd1, est1] = [r1.total.usd, r1.estimated.usd];
  assert.ok(usd1 < 1, 'only this turn, not the eight dollars before it');
  assert.equal(est1, usd1);
  const cum2: ModelTok = { 'claude-sonnet-5-5': tok({ in: 110, out: 91_000, cr: 9_300_000, cw: 410_000, usd: 8.4 }) };
  w.spend.observe('s1', resultEvent(T0 + 120_000, { cum: cum2 }, 8.4));
  const r2 = w.spend.request('w1')!;
  assert.ok(Math.abs(r2.total.usd - usd1 - 0.4) < 1e-9);
  assert.equal(r2.estimated.usd, est1, 'the second turn is exact');
});

test('a daemon without usage: dollars from the cost totals, no tokens, estimated', () => {
  const w = world([item('w1', { sessionIds: ['s1'], links: { s1: { at: iso(T0), how: 'sent' } } })], [session('s1')]);
  w.spend.observe('s1', resultEvent(T0 + 60_000, undefined, 0.3));
  w.spend.observe('s1', resultEvent(T0 + 120_000, undefined, 0.8));
  const r = w.spend.request('w1')!;
  assert.ok(Math.abs(r.total.usd - 0.8) < 1e-9);
  assert.equal(r.total.cr, 0);
  assert.ok(Math.abs(r.estimated.usd - 0.8) < 1e-9);
});

test('cumulative totals that start again (a /clear) count in full', () => {
  const w = world([item('w1', { sessionIds: ['s1'], links: { s1: { at: iso(T0), how: 'sent' } } })], [session('s1')]);
  w.spend.observe('s1', resultEvent(T0 + 60_000, { cum: { m: tok({ in: 10, out: 100, cr: 1_000_000, cw: 50_000, usd: 3 }) } }, 3));
  w.spend.observe('s1', resultEvent(T0 + 120_000, { cum: { m: tok({ in: 2, out: 20, cr: 5000, cw: 8000, usd: 0.1 }) } }, 0.1));
  assert.ok(Math.abs(w.spend.request('w1')!.total.usd - 3.1) < 1e-9);
});

test('the turn goes to the request named by the message that began it, and a shared turn is split', () => {
  const a = item('w1', { sessionIds: ['s1'], links: { s1: { at: iso(T0), how: 'sent' } } });
  const b = item('w2', { sessionIds: ['s1'], links: { s1: { at: iso(T0 + 1000), how: 'linked' } } });
  const w = world([a, b], [session('s1')]);
  // an [about w1] message: w1 only
  w.spend.observe('s1', userEvent(T0 + 5000, '[about w1 "x"]\nfollow-up'));
  w.spend.observe('s1', resultEvent(T0 + 65_000, { cum: { m: tok({ usd: 1, cr: 1000 }) } }, 1));
  assert.equal(w.spend.request('w1')!.total.usd, 1);
  assert.equal(w.spend.request('w2'), undefined);
  // no message: both linked requests, half each
  w.spend.observe('s1', resultEvent(T0 + 125_000, { cum: { m: tok({ usd: 3, cr: 3000 }) } }, 3));
  assert.equal(w.spend.request('w1')!.total.usd, 2);
  assert.equal(w.spend.request('w2')!.total.usd, 1);
  assert.equal(w.spend.session('s1')!.total.usd, 3);
  assert.equal(w.spend.request('w2')!.sessions.s1.shared, 0.5);
});

test('the dispatcher\'s turn on a request is that request\'s; one that names none is its own bucket', () => {
  const w = world([item('w859')], [session('d', { kind: 'orchestrator', orchestratorRole: 'dispatcher', title: 'Dispatcher' })]);
  w.spend.observe('d', userEvent(T0, '[work request] w859 "Portal spend"'));
  w.spend.observe('d', resultEvent(T0 + 30_000, { cum: { m: tok({ usd: 0.2, cr: 500 }) } }, 0.2));
  w.spend.observe('d', userEvent(T0 + 60_000, '[heartbeat] all quiet'));
  w.spend.observe('d', resultEvent(T0 + 90_000, { cum: { m: tok({ usd: 0.5, cr: 900 }) } }, 0.5));
  assert.equal(w.spend.request('w859')!.total.usd, 0.2);
  assert.ok(Math.abs(w.spend.request('_dispatcher')!.total.usd - 0.3) < 1e-9);
  assert.equal(w.spend.request('w859')!.sessions.d.role, 'dispatcher');
});

test('a message that arrives mid-turn belongs to the next turn, not the one that is ending (the result answers uuids)', () => {
  const a = item('w1', { sessionIds: ['s1'], links: { s1: { at: iso(T0), how: 'sent' } } });
  const b = item('w2', { sessionIds: ['s1'], links: { s1: { at: iso(T0 + 20_000), how: 'sent' } } });
  const w = world([a, b], [session('s1')]);
  seq = 0;
  const first: TranscriptEvent = { ...userEvent(T0 + 2000, 'work on it'), uuid: 'u1' } as TranscriptEvent;
  const mid: TranscriptEvent = { ...userEvent(T0 + 30_000, '[about w2 "x"]\nlater'), uuid: 'u2' } as TranscriptEvent;
  w.spend.observe('s1', first);
  w.spend.observe('s1', mid); // arrives while turn 1 runs
  const r1 = resultEvent(T0 + 60_000, { cum: { m: tok({ usd: 1, cr: 1000 }) } }, 1);
  (r1 as { answers?: string[] }).answers = ['u1'];
  w.spend.observe('s1', r1);
  assert.equal(w.spend.request('w2'), undefined, 'the mid-turn message did not move turn 1');
  const r2 = resultEvent(T0 + 120_000, { cum: { m: tok({ usd: 3, cr: 3000 }) } }, 3);
  (r2 as { answers?: string[] }).answers = ['u2'];
  w.spend.observe('s1', r2);
  assert.equal(w.spend.request('w2')!.total.usd, 2, 'turn 2 goes to the request its message names');
});

test('a new agent process whose totals started again counts its first turn in full, even when the total passes half of the old one', () => {
  const w = world([item('w1', { sessionIds: ['s1'], links: { s1: { at: iso(T0), how: 'sent' } } })], [session('s1')]);
  w.spend.observe('s1', resultEvent(T0 + 60_000, { cum: { m: tok({ in: 10, out: 100, cr: 1_000_000, cw: 50_000, usd: 10 }) } }, 10));
  // the process restarted; the SDK did not carry the 10 dollars; this turn alone cost 6 (more than half of 10)
  w.spend.observe('s1', resultEvent(T0 + 120_000, { restarted: true, cum: { m: tok({ in: 5, out: 80, cr: 700_000, cw: 40_000, usd: 6 }) } }, 6));
  assert.ok(Math.abs(w.spend.request('w1')!.total.usd - 16) < 1e-9);
});

test('a compaction between turns costs nothing extra to record: the next result totals carry it', () => {
  const w = world([item('w1', { sessionIds: ['s1'], links: { s1: { at: iso(T0), how: 'sent' } } })], [session('s1')]);
  w.spend.observe('s1', resultEvent(T0 + 60_000, { cum: { m: tok({ usd: 1, cr: 1000 }) } }, 1));
  // (a /compact ran: 0.40 more in the totals, no result line of its own) then the next turn
  w.spend.observe('s1', resultEvent(T0 + 200_000, { cum: { m: tok({ usd: 1.9, cr: 2400 }) } }, 1.9));
  assert.ok(Math.abs(w.spend.request('w1')!.total.usd - 1.9) < 1e-9);
});

test('the context reading adds up per request and shows in the report', () => {
  const w = world([item('w1', { sessionIds: ['s1'], links: { s1: { at: iso(T0), how: 'sent' } } }), item('w2', { title: 'Fix a crash' })], [session('s1')]);
  const meter = { calls: 5, ctxMax: 90_000, ctxEnd: 90_000, cats: { 'file-read': { usd: 0.3, tok: 1000 }, base: { usd: 0.1, tok: 500 } }, reread: { n: 2, chars: 7000, afterCompact: 1 } };
  w.spend.observe('s1', resultEvent(T0 + 60_000, { cum: { 'claude-sonnet-5-5': tok({ usd: 2, cr: 5_000_000, out: 3000 }) }, meter }, 2));
  const rep = buildReport(w.spend, T0 + 3_600_000);
  assert.equal(rep.top[0].id, 'w1');
  assert.equal(rep.top[0].cats[0].cat, 'file-read');
  assert.ok(Math.abs(rep.top[0].cats[0].pct - 0.75) < 1e-9);
  assert.equal(rep.where[0].cat, 'file-read');
  assert.equal(rep.reread?.n, 2);
  assert.match(renderReport(rep), /Top 1 requests by cost/);
  assert.match(renderRequest(w.spend, 'w1', (sid) => `https://p/#/session/${sid}`, 7), /https:\/\/p\/#\/session\/s1/);
});

test('the record survives a restart and the ledger forgetting the request', () => {
  const items = [item('w1', { sessionIds: ['s1'], links: { s1: { at: iso(T0), how: 'sent' } }, title: 'Fix a crash' })];
  const w = world(items, [session('s1')]);
  w.spend.observe('s1', resultEvent(T0 + 60_000, { cum: { m: tok({ usd: 1, cr: 1000 }) } }, 1));
  w.spend.syncWork();
  assert.equal(w.spend.request('w1')!.kind, 'bug fix');
  w.spend.flush();
  items.length = 0; // pruned from the ledger
  const again = new SpendStore(w.dir, { work: () => items, session: () => undefined, priorResults: () => 1 });
  again.syncWork();
  const r = again.request('w1')!;
  assert.equal(r.total.usd, 1);
  assert.equal(r.title, 'Fix a crash');
  assert.ok(r.closedAt, 'a request the ledger dropped was closed');
  assert.equal(again.session('s1')!.total.usd, 1);
});

test('protectedUntil: open requests keep their transcripts, closed ones 7 days after the close, chats always', () => {
  const open = item('w1', { sessionIds: ['s1'], links: { s1: { at: iso(T0), how: 'sent' } } });
  const w = world([open], [session('s1'), session('s2'), session('d', { kind: 'orchestrator', orchestratorRole: 'dispatcher' })]);
  w.spend.observe('s1', resultEvent(T0 + 60_000, { cum: { m: tok({ usd: 1, cr: 1000 }) } }, 1));
  w.spend.observe('d', userEvent(T0, 'hi'));
  w.spend.observe('d', resultEvent(T0 + 60_000, { cum: { m: tok({ usd: 0.1, cr: 100 }) } }, 0.1));
  assert.equal(w.spend.protectedUntil('s1', 7), Infinity);
  assert.equal(w.spend.protectedUntil('d', 7), Infinity);
  assert.equal(w.spend.protectedUntil('unknown', 7), undefined);
  open.status = 'done';
  open.updatedAt = iso(T0 + 3_600_000);
  w.spend.syncWork();
  assert.equal(w.spend.protectedUntil('s1', 7), T0 + 3_600_000 + 7 * 86_400_000);
  open.status = 'active';
  w.spend.syncWork();
  assert.equal(w.spend.protectedUntil('s1', 7), Infinity, 'a reopened request keeps them again');
});

// ---------------------------------------------------------------------------------------------------------------------
// backfill
// ---------------------------------------------------------------------------------------------------------------------

test('estimateTurn: tokens from dollars, labelled by the caller; the dollars are kept', () => {
  const t = estimateTurn('claude-sonnet-5-5', 0.5, 7000, 35_000);
  assert.equal(t.usd, 0.5);
  assert.ok(t.out > 5000 && t.out < 5500);
  assert.ok(t.cr > 0);
  // the dollars add back up at list prices
  assert.ok(Math.abs(listUsd('claude-sonnet-5-5', t) - 0.5) < 0.02);
  // dollars too small for the characters: scaled down, nothing read
  const small = estimateTurn('claude-sonnet-5-5', 0.001, 70_000, 350_000);
  assert.equal(small.cr, 0);
  assert.ok(Math.abs(listUsd('claude-sonnet-5-5', small) - 0.001) < 1e-6);
});

test('backfillSession: dollars from the recorded cost totals, per turn, tied to the request, all estimated; never twice', () => {
  const a = item('w1', { sessionIds: ['s1'], links: { s1: { at: iso(T0), how: 'sent' } } });
  const b = item('w2', { sessionIds: ['s1'], links: { s1: { at: iso(T0 + 3_600_000), how: 'sent' } } });
  const w = world([a, b], [session('s1', { costUsd: 3 })]);
  seq = 0;
  const events: TranscriptEvent[] = [
    userEvent(T0 + 1000, 'start'),
    { seq: ++seq, t: iso(T0 + 2000), kind: 'assistant', text: 'x'.repeat(3500) },
    { seq: ++seq, t: iso(T0 + 3000), kind: 'tool_result', toolUseId: 't', isError: false, text: 'y'.repeat(7000) },
    resultEvent(T0 + 600_000, undefined, 1),
    userEvent(T0 + 3_700_000, 'next'),
    resultEvent(T0 + 4_200_000, undefined, 3),
  ];
  const r = w.spend.backfillSession('s1', events, w.sessions[0]);
  assert.equal(r.turns, 2);
  assert.ok(Math.abs(r.usd - 3) < 1e-9);
  assert.equal(w.spend.request('w1')!.total.usd, 1);
  assert.equal(w.spend.request('w2')!.total.usd, 2);
  assert.equal(w.spend.request('w2')!.estimated.usd, 2);
  assert.ok(w.spend.request('w1')!.total.cr > 0);
  assert.equal(w.spend.request('w1')!.sessions.s1.how.backfill, 1);
  // again: nothing
  assert.deepEqual(w.spend.backfillSession('s1', events, w.sessions[0]), { turns: 0, usd: 0 });
  assert.equal(w.spend.session('s1')!.total.usd, 3);
});

test('backfillSession: only the events before the first live one', () => {
  const a = item('w1', { sessionIds: ['s1'], links: { s1: { at: iso(T0), how: 'sent' } } });
  const w = world([a], [session('s1', { costUsd: 3 })], { s1: 1 });
  seq = 0;
  const old = resultEvent(T0 + 600_000, undefined, 1);
  const live = resultEvent(T0 + 900_000, { cum: { m: tok({ usd: 2, cr: 1000 }) } }, 2);
  w.spend.observe('s1', live);
  const r = w.spend.backfillSession('s1', [old, live], w.sessions[0]);
  assert.equal(r.turns, 1);
  assert.ok(Math.abs(w.spend.request('w1')!.total.usd - 3) < 1e-9, 'the old turn once, the live turn once');
});

// ---------------------------------------------------------------------------------------------------------------------
// the data guard
// ---------------------------------------------------------------------------------------------------------------------

const GB = 1024 ** 3;
const file = (id: string, gb: number, ageDays: number, gz = false): TranscriptFile => ({ id, bytes: gb * GB, mtimeMs: T0 - ageDays * 86_400_000, gz });
const C = DATA_GUARD_DEFAULTS;

test('planGuard: nothing below the first threshold', () => {
  const p = planGuard([file('a', 1, 30)], { usedBytes: 19 * GB, totalBytes: 100 * GB }, () => undefined, T0, C);
  assert.equal(p.level, 'ok');
  assert.deepEqual([p.gzip, p.prune], [[], []]);
});

test('planGuard: from half full, idle transcripts are compressed (protected ones too: it loses nothing)', () => {
  const p = planGuard([file('a', 1, 30), file('b', 1, 0.1), file('c', 1, 3, true), file('open', 2, 5)], { usedBytes: 55 * GB, totalBytes: 100 * GB }, (id) => (id === 'open' ? Infinity : undefined), T0, C);
  assert.equal(p.level, 'gzip');
  assert.deepEqual(p.gzip, ['open', 'a']);
  assert.deepEqual(p.prune, []);
});

test('planGuard: from three quarters, only transcripts past their retention go, oldest first, only as many as needed', () => {
  const files = [file('old1', 2, 30), file('old2', 2, 20), file('recent', 5, 2), file('open', 5, 40)];
  const until: Record<string, number> = { old1: T0 - 20 * 86_400_000, old2: T0 - 10 * 86_400_000, recent: T0 + 5 * 86_400_000, open: Infinity };
  const p = planGuard(files, { usedBytes: 78 * GB, totalBytes: 100 * GB }, (id) => until[id], T0, C);
  assert.equal(p.level, 'prune');
  // it must get to 70% (75 - 5 points): 8 GB; the two expired ones hold 4 GB, so both go and it says so
  assert.deepEqual(p.prune, ['old1', 'old2']);
  assert.equal(p.protectedBytes, 10 * GB);
});

test('planGuard: past 90% with only protected transcripts left it says so and deletes nothing inside the window', () => {
  const files = [file('open', 30, 40), file('recent', 20, 2)];
  const p = planGuard(files, { usedBytes: 93 * GB, totalBytes: 100 * GB }, (id) => (id === 'open' ? Infinity : T0 + 5 * 86_400_000), T0, C);
  assert.equal(p.level, 'alert');
  assert.deepEqual(p.prune, []);
  assert.match(p.alert!, /inside their 7-day retention/);
});

test('planGuard: a transcript with no record is kept 7 days from its last write', () => {
  const p = planGuard([file('stray', 1, 3), file('stray2', 1, 9)], { usedBytes: 90 * GB, totalBytes: 100 * GB }, () => undefined, T0, C);
  assert.deepEqual(p.prune, ['stray2']);
});

test('dataGuardSettings: defaults, clamping and the order of the steps', () => {
  assert.deepEqual(dataGuardSettings(undefined), DATA_GUARD_DEFAULTS);
  const g = dataGuardSettings({ dataGuard: { gzipAtUsedPercent: 80, pruneAtUsedPercent: 60, alertAtUsedPercent: 50, retainDays: 0 } });
  assert.equal(g.retainDays, 1);
  assert.ok(g.pruneAtUsedPercent >= g.gzipAtUsedPercent && g.alertAtUsedPercent >= g.pruneAtUsedPercent);
});

test('gzipFile: a transcript compressed and read back; a file that grew meanwhile is left alone', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-test-'));
  const f = path.join(dir, 's.jsonl');
  const text = '{"seq":1,"kind":"system","text":"' + 'hello '.repeat(500) + '"}\n';
  fs.writeFileSync(f, text);
  const r = (await gzipFile(f))!;
  assert.ok(r.to < r.from / 5);
  assert.ok(!fs.existsSync(f));
  assert.equal(zlib.gunzipSync(fs.readFileSync(`${f}.gz`)).toString('utf8'), text);
});

test('the store reads a compressed transcript, and writes to it again after unzipping it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-gz-'));
  const store = new Store(dir);
  store.append('s1', { kind: 'system', text: 'one' });
  store.append('s1', { kind: 'result', ok: true, text: 'done', costUsd: 1, turns: 1, durationMs: 1 });
  const t = path.join(dir, 'transcripts', 's1.jsonl');
  assert.ok(await gzipFile(t));
  store.noteCompressed('s1'); // what the data guard does after it compresses one
  assert.ok(store.hasTranscript('s1'));
  assert.equal(store.readTranscript('s1').length, 2);
  assert.equal(store.countResults('s1'), 1);
  const e = store.append('s1', { kind: 'system', text: 'two' });
  assert.equal(e.seq, 3);
  assert.ok(fs.existsSync(t) && !fs.existsSync(`${t}.gz`));
  assert.equal(store.readTranscript('s1').length, 3);
  store.deleteTranscript('s1');
  assert.ok(!store.hasTranscript('s1'));
});

test('runDataGuard: compresses, prunes past retention, keeps the cost record, leaves running sessions and protected ones', async () => {
  const items = [item('w1', { status: 'done', updatedAt: iso(T0 - 30 * 86_400_000), sessionIds: ['old'], links: { old: { at: iso(T0 - 31 * 86_400_000), how: 'sent' } } }), item('w2', { sessionIds: ['openS'], links: { openS: { at: iso(T0 - 40 * 86_400_000), how: 'sent' } } })];
  const sessions = [session('old', { status: 'stopped' }), session('openS', { status: 'stopped' }), session('busy', { status: 'running' })];
  const w = world(items, sessions);
  const tdir = path.join(w.dir, 'transcripts');
  fs.mkdirSync(tdir, { recursive: true });
  for (const id of ['old', 'openS', 'busy']) {
    fs.writeFileSync(path.join(tdir, `${id}.jsonl`), `{"seq":1,"kind":"system","text":"${'z'.repeat(2000)}"}\n`);
    fs.utimesSync(path.join(tdir, `${id}.jsonl`), (T0 - 40 * 86_400_000) / 1000, (T0 - 40 * 86_400_000) / 1000);
  }
  w.spend.observe('old', resultEvent(T0 - 30 * 86_400_000, { cum: { m: tok({ usd: 2, cr: 100 }) } }, 2));
  w.spend.observe('openS', resultEvent(T0 - 30 * 86_400_000, { cum: { m: tok({ usd: 1, cr: 100 }) } }, 1));
  w.spend.syncWork();
  const store = { sessions: new Map(sessions.map((s) => [s.id, s])) };
  const run = await runDataGuard({ dir: tdir, spend: w.spend, store, config: DATA_GUARD_DEFAULTS, now: T0, disk: () => ({ usedBytes: 80 * GB, totalBytes: 100 * GB }) });
  assert.equal(run.level, 'prune');
  assert.ok(!fs.existsSync(path.join(tdir, 'old.jsonl')) && !fs.existsSync(path.join(tdir, 'old.jsonl.gz')), 'past its retention');
  assert.ok(fs.existsSync(path.join(tdir, 'openS.jsonl.gz')), 'its request is open: compressed, kept');
  assert.ok(fs.existsSync(path.join(tdir, 'busy.jsonl')), 'running: untouched');
  assert.equal(w.spend.session('old')!.transcript?.state, 'pruned');
  assert.equal(w.spend.request('w1')!.total.usd, 2, 'the cost record outlives the transcript');
  const fp = footprint(tdir, T0);
  assert.equal(fp.gzFiles, 1);
  assert.equal(fp.files, 1);
});

test('priceOf: the models in use, an alias, an unknown one', () => {
  assert.equal(priceOf('claude-opus-5-5').out, 20);
  assert.equal(priceOf('claude-sonnet-5-5').in, 2);
  assert.equal(priceOf('claude-haiku-5-5').cr, 0.01);
  assert.equal(priceOf('opus').out, 20);
  assert.equal(priceOf('mystery').in, 2);
});
