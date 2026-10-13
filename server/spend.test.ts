import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { ContextMeter, toolKind, stripCd, listUsd, priceOf, zeroTok, type ModelTok, type TurnUsage } from '../shared/spend.ts';
import { SpendStore, aboutIds, attribute, buildReport, costLine, estimateTurn, kindOfWork, namedIdsIn, renderReport, renderRequest, renderSession, servedAt, type SpendContext } from './spend.ts';
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
  assert.deepEqual(attribute(session('o', { kind: 'ops' }), [a], ['do w1 now'], T0).map((x) => x.id), ['w1']);
  assert.deepEqual(attribute(session('o', { kind: 'ops' }), [a], ['look around'], T0).map((x) => x.id), ['_ops']);
  assert.deepEqual(attribute(session('g', { kind: 'standing', standingId: 'sentry' }), [a], [], T0).map((x) => x.id), ['_standing:sentry']);
});

test('kindOfWork: release, review, ops, bug fix, investigation, feature', () => {
  const k = (title: string, source?: WorkItem['source']) => kindOfWork({ title, brief: '', source, delegation: undefined });
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

test('a resumed process that carries its saved totals counts only the rise, even when flagged restarted (w1161)', () => {
  // The dispatcher's first turn after each portal restart, 2026-10-07..12: the CLI resumed from its saved running total, the
  // portal before w1161 flagged it restarted, and the whole total ($200 and more) was counted again each time.
  const w = world([item('w1')], [session('d', { kind: 'orchestrator', orchestratorRole: 'dispatcher', title: 'Dispatcher' })]);
  w.spend.observe('d', userEvent(T0, '[work request] w1 "x"'));
  w.spend.observe('d', resultEvent(T0 + 60_000, { cum: { m: tok({ in: 900, out: 400_000, cr: 400_000_000, cw: 9_000_000, usd: 200 }) } }, 200));
  const before = w.spend.session('d')!.total.usd;
  w.spend.observe('d', userEvent(T0 + 120_000, '[app restarted] FF Factory restarted'));
  w.spend.observe('d', resultEvent(T0 + 180_000, { restarted: true, cum: { m: tok({ in: 901, out: 400_500, cr: 401_000_000, cw: 9_010_000, usd: 200.5 }) } }, 200.5));
  const s = w.spend.session('d')!;
  assert.ok(Math.abs(s.total.usd - before - 0.5) < 1e-9, `the turn added ${s.total.usd - before}`);
  assert.equal(s.total.cr, 401_000_000, 'cache reads: only the 1M this turn read');
  assert.equal(s.turns, 2);
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
  assert.match(renderReport(rep), /Top 1 requests by the workers' own cost/);
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

test('w1159: renderSession lists the top 20 requests by cost and counts the rest; requests asks for more', () => {
  const ids = Array.from({ length: 30 }, (_, i) => `w${100 + i}`);
  const items = ids.map((id) => item(id, { sessionIds: ['d'], links: { d: { at: iso(T0), how: 'sent' } } }));
  const w = world(items, [session('d', { kind: 'orchestrator', orchestratorRole: 'dispatcher', title: 'Dispatcher' })]);
  // One turn per request, each [about wNNN]: request 100+i costs i+1 dollars.
  ids.forEach((id, i) => {
    w.spend.observe('d', userEvent(T0 + i * 200_000 + 1000, `[about ${id} "x"]\nhello`));
    w.spend.observe('d', resultEvent(T0 + i * 200_000 + 60_000, { cum: { m: tok({ usd: ((i + 1) * (i + 2)) / 2, cr: 1000 * (i + 1) }) } }, i + 1));
  });
  const link = (sid: string) => 'https://p/#/session/' + sid;
  const small = renderSession(w.spend, 'd', link);
  const line = small.split('\n').find((l) => l.startsWith('Coordination it billed'))!;
  assert.ok(line.includes('(a turn naming several is split evenly, an estimate; 30 requests, the top 20 by cost): w129 $30.00, w128 $29.00'), line);
  assert.ok(line.includes('w110 $11.00'), 'the 20th is listed');
  assert.ok(!line.includes('w109 '), 'the 21st is not');
  assert.ok(line.includes('and 10 more, $55.00 together (spend_report session with requests: 30 lists them all)'), line);
  const all = renderSession(w.spend, 'd', link, 2000);
  const full = all.split('\n').find((l) => l.startsWith('Coordination it billed'))!;
  assert.ok(full.includes('an estimate): w129'), full);
  assert.ok(full.includes('w100 $1.00') && !full.includes('more'), full);
  assert.ok(all.length > small.length);
  // A session with 20 or fewer is listed whole, as before.
  const few = renderSession(w.spend, 'd', link, 40).split('\n').find((l) => l.startsWith('Coordination it billed'))!;
  assert.ok(few.includes('an estimate): w129'));
});

// ---------------------------------------------------------------------------------------------------------------------
// coordination billed apart from the workers' own cost (w1160)
// ---------------------------------------------------------------------------------------------------------------------

const DISPATCHER = (): SessionInfo => session('d', { kind: 'orchestrator', orchestratorRole: 'dispatcher', title: 'Dispatcher', requestedBy: undefined });
const ORCH = (): SessionInfo => session('o', { kind: 'orchestrator', orchestratorRole: 'personal', title: 'Lothsahn orchestrator', requestedBy: { userId: 'lothsahn', displayName: 'Lothsahn' } });
const OPS = (): SessionInfo => session('ops', { kind: 'ops', title: 'Ops worker' });
const DAY = 86_400_000;

/** A coordinator turn: the message that began it and what the turn cost (the session's cumulative total goes up by it). */
function coordTurn(w: ReturnType<typeof world>, sid: string, at: number, message: string, usd: number) {
  const cum = (w.spend.session(sid)?.cum?.m?.usd ?? 0) + usd;
  w.spend.observe(sid, userEvent(at, message));
  w.spend.observe(sid, resultEvent(at + 30_000, { cum: { m: tok({ usd: cum, cr: Math.round(cum * 1000) }) } }, cum));
}

test("coordination: a coordinator turn is the request's coordination, not the workers' own cost; a turn naming two requests splits evenly", () => {
  const a = item('w1', { sessionIds: ['s1'], links: { s1: { at: iso(T0), how: 'sent' } } });
  const b = item('w2');
  const w = world([a, b], [session('s1'), DISPATCHER()]);
  w.spend.observe('s1', resultEvent(T0 + 60_000, { cum: { m: tok({ usd: 2, cr: 2000 }) } }, 2));
  coordTurn(w, 'd', T0 + 100_000, '[worker update] w1 and w2 "x"', 1);
  coordTurn(w, 'd', T0 + 200_000, '[work request] w2 "y"', 0.5);
  const s1 = w.spend.splitOf(w.spend.request('w1')!);
  const s2 = w.spend.splitOf(w.spend.request('w2')!);
  assert.equal(s1.workers.usd, 2);
  assert.ok(Math.abs(s1.coordination.usd - 0.5) < 1e-9, 'half of the turn that named w1 and w2');
  assert.equal(s2.workers.usd, 0);
  assert.ok(Math.abs(s2.coordination.usd - 1) < 1e-9, 'the other half and the turn that named only w2');
  assert.deepEqual(s2.coordination.by.map((x) => x.who), ['dispatcher']);
  // nothing is counted twice: a request's whole spend is its workers' plus its coordination
  assert.ok(Math.abs(w.spend.request('w1')!.total.usd - (s1.workers.usd + s1.coordination.usd)) < 1e-9);
  assert.ok(Math.abs(w.spend.request('w2')!.total.usd - (s2.workers.usd + s2.coordination.usd)) < 1e-9);
  assert.ok(Math.abs(w.spend.session('d')!.total.usd - (s1.coordination.usd + s2.coordination.usd)) < 1e-9, "the dispatcher's own total is its coordination on the requests");
  assert.equal(w.spend.request('w1')!.sessions.d.shared, 0.5);
});

test("coordination: a coordinator turn that names no request stays in its bucket, not in any request's coordination", () => {
  const w = world([item('w1')], [DISPATCHER()]);
  coordTurn(w, 'd', T0, '[heartbeat] all quiet', 0.4);
  assert.ok(Math.abs(w.spend.request('_dispatcher')!.total.usd - 0.4) < 1e-9);
  assert.equal(w.spend.request('w1'), undefined);
  assert.equal(w.spend.request('_dispatcher')!.coordDays, undefined, 'a bucket is not a request');
  const rep = buildReport(w.spend, T0 + 600_000);
  assert.equal(rep.coordination.usd, 0);
  assert.equal(rep.buckets[0].id, '_dispatcher');
});

test("coordination: the report ranks by the workers' own cost and the totals add up with no double counting", () => {
  const sessions = [session('s1'), session('s2'), DISPATCHER(), ORCH(), OPS()];
  const items = [item('w1', { sessionIds: ['s1'], links: { s1: { at: iso(T0), how: 'sent' } } }), item('w2', { sessionIds: ['s2'], links: { s2: { at: iso(T0), how: 'sent' } } }), item('w3'), item('w4')];
  const w = world(items, sessions);
  w.spend.observe('s1', resultEvent(T0 + 60_000, { cum: { m: tok({ usd: 3, cr: 1 }) } }, 3));
  w.spend.observe('s2', resultEvent(T0 + 60_000, { cum: { m: tok({ usd: 1, cr: 1 }) } }, 1));
  coordTurn(w, 'd', T0 + 100_000, '[worker update] w3 "x"', 50); // a request with no worker cost and a lot of coordination
  coordTurn(w, 'o', T0 + 110_000, '[work request] w1 "x"', 2);
  coordTurn(w, 'ops', T0 + 120_000, '[job] w1 w4', 1);
  coordTurn(w, 'd', T0 + 130_000, '[heartbeat] nothing', 0.7);
  const rep = buildReport(w.spend, T0 + 3_600_000, { days: 1, top: 10 });
  assert.deepEqual(rep.top.map((t) => t.id).slice(0, 2), ['w1', 'w2'], 'w3 took 50 of coordination but its workers cost nothing');
  assert.equal(rep.top[0].usd, 3);
  assert.ok(Math.abs(rep.top[0].coordination.usd - 2.5) < 1e-9);
  assert.deepEqual(rep.top[0].coordination.by.map((x) => x.who), ["Lothsahn's orchestrator", 'ops worker']);
  assert.equal(rep.topCoordination[0].id, 'w3');
  assert.ok(Math.abs(rep.workers.usd - 4) < 1e-9);
  assert.ok(Math.abs(rep.coordination.usd - 53) < 1e-9);
  const loose = rep.buckets.reduce((a, b) => a + b.usd, 0);
  assert.ok(Math.abs(rep.workers.usd + rep.coordination.usd + loose - rep.total.usd) < 1e-9, "workers + coordination + not-any-request's = the total");
  assert.ok(Math.abs(rep.top.reduce((a, t) => a + t.usd + t.coordination.usd, 0) - (rep.total.usd - loose)) < 1e-9, 'the rows add up too');
  assert.ok(Math.abs(rep.kinds.reduce((a, k) => a + k.usd + k.coordination, 0) - (rep.total.usd - loose)) < 1e-9);
  const text = renderReport(rep);
  assert.match(text, /workers' own cost on requests \$4\.00; coordination on requests \$53\.00/);
  assert.match(text, /split evenly/);
  assert.match(text, /1\. w1 workers \$3\.00, coordination \$2\.50 \(Lothsahn's orchestrator \$2\.00, ops worker \$0\.50\)/);
  assert.match(text, /Most coordination on a request[^]*- w3 coordination \$50\.00 \(dispatcher \$50\.00\), workers \$0\.00/);
});

test('coordination: a window takes the coordination of its own days only', () => {
  const w = world([item('w1', { sessionIds: ['s1'], links: { s1: { at: iso(T0), how: 'sent' } } })], [session('s1'), DISPATCHER()]);
  w.spend.observe('s1', resultEvent(T0 + 60_000, { cum: { m: tok({ usd: 5, cr: 1 }) } }, 5));
  coordTurn(w, 'd', T0 + 2 * DAY, '[worker update] w1 "x"', 20);
  const r = w.spend.request('w1')!;
  const day0 = '2026-10-08';
  const day2 = '2026-10-10';
  assert.equal(w.spend.windowSplit(r, day0, day0, r.days[day0]).coordination.usd, 0);
  assert.equal(w.spend.windowSplit(r, day0, day0, r.days[day0]).workers.usd, 5);
  assert.equal(w.spend.windowSplit(r, day2, day2, r.days[day2]).coordination.usd, 20);
  assert.equal(w.spend.windowSplit(r, day2, day2, r.days[day2]).workers.usd, 0);
  const rep = buildReport(w.spend, T0 + 2 * DAY + 600_000, { days: 1 });
  assert.equal(rep.top[0].usd, 0);
  assert.equal(rep.coordination.usd, 20);
  const all = buildReport(w.spend, T0 + 2 * DAY + 600_000, { days: 7 });
  assert.equal(all.top[0].usd, 5);
  assert.equal(all.top[0].coordination.usd, 20);
});

test('coordination: the request view, the session view and the cost line show the two apart', () => {
  const w = world([item('w1', { sessionIds: ['s1'], links: { s1: { at: iso(T0), how: 'sent' } } }), item('w2')], [session('s1'), DISPATCHER()]);
  w.spend.observe('s1', resultEvent(T0 + 60_000, { cum: { m: tok({ usd: 2, cr: 2000 }) } }, 2));
  coordTurn(w, 'd', T0 + 100_000, '[worker update] w1 w2 "x"', 3);
  coordTurn(w, 'd', T0 + 200_000, '[heartbeat] nothing', 0.25);
  const req = renderRequest(w.spend, 'w1', (sid) => `#/session/${sid}`, 7);
  assert.match(req, /workers' own cost \$2\.00[^;]*; coordination \$1\.50 \(dispatcher \$1\.50\); all together \$3\.50/);
  assert.match(req, /split evenly/);
  assert.match(req, /By UTC day \(workers \/ coordination\)[^]*2026-10-08 \$2\.00 \/ \$1\.50/);
  assert.ok(req.indexOf('- s1 worker') < req.indexOf('- d coordination (dispatcher)'), 'workers listed before coordinators');
  const sess = renderSession(w.spend, 'd', (sid) => `#/session/${sid}`);
  assert.match(sess, /dispatcher \(its cost is coordination\)/);
  assert.match(sess, /Coordination it billed to requests[^]*w1 \$1\.50, w2 \$1\.50/);
  assert.match(sess, /Not any request's: _dispatcher \$0\.25/);
  assert.match(renderSession(w.spend, 's1', () => ''), /Requests it served \(the workers' own cost\): w1 \$2\.00/);
  assert.match(costLine(w.spend, 'w1'), /Cost so far: \$2\.00 \(1 session\(s\)[^)]*\)\. Coordination[^:]*: \$1\.50\./);
  assert.match(costLine(w.spend, 'w2'), /Cost so far: \$0\.00/);
});

test('coordination: split by coordinator, and the record keeps the days through a restart', () => {
  const w = world([item('w1')], [DISPATCHER(), ORCH()]);
  coordTurn(w, 'd', T0, '[worker update] w1', 1);
  coordTurn(w, 'o', T0 + DAY, '[work request] w1', 2);
  w.spend.flush();
  const again = new SpendStore(w.dir, { work: () => w.items, session: () => undefined, priorResults: () => 1 });
  const r = again.request('w1')!;
  assert.deepEqual(Object.keys(r.coordDays!).sort(), ['d', 'o'], 'the days are kept per coordinator session');
  const win = again.windowSplit(r, '2026-10-09', '2026-10-09', r.days['2026-10-09']);
  assert.ok(Math.abs(win.coordination.usd - 2) < 1e-9);
  assert.deepEqual(win.coordination.by.map((b) => b.who), ["Lothsahn's orchestrator"]);
  assert.equal(again.session('d')!.coordV, 2, 'a session first seen by this code has nothing to rebuild');
});

/** What the store held before coordination had days: coordinator sessions without them, as an older portal wrote them. */
function makeLegacy(w: ReturnType<typeof world>, ids: string[]) {
  for (const r of w.spend.requests.values()) r.coordDays = undefined;
  for (const id of ids) {
    const s = w.spend.session(id)!;
    s.legacyRequests = Object.fromEntries(Object.entries(s.requests).filter(([k]) => !k.startsWith('_')));
    s.coordV = undefined;
    s.coordFrom = undefined;
  }
}

/** A dispatcher whose turns are observed one by one and kept as the transcript a rebuild reads. */
function recorded(w: ReturnType<typeof world>) {
  const events: TranscriptEvent[] = [];
  const push = (e: TranscriptEvent) => {
    events.push(e);
    w.spend.observe('d', e);
  };
  const turn = (at: number, text: string, cum: number) => {
    push(userEvent(at, text));
    push(resultEvent(at + 30_000, { cum: { m: tok({ usd: cum, cr: 1 }) } }, cum));
  };
  return { events, push, turn };
}

test('coordination: turns recorded before days existed get their days from the transcript, and the totals do not move', () => {
  const w = world([item('w1', { sessionIds: ['s1'], links: { s1: { at: iso(T0), how: 'sent' } } }), item('w2')], [session('s1'), DISPATCHER()]);
  seq = 0;
  const { events, turn } = recorded(w);
  w.spend.observe('s1', resultEvent(T0 + 60_000, { cum: { m: tok({ usd: 4, cr: 1 }) } }, 4));
  turn(T0 + 100_000, '[worker update] w1', 1);
  turn(T0 + DAY, '[worker update] w1 w2', 4); // 3 dollars: 1.5 each, a day later
  turn(T0 + 2 * DAY, '[worker update] w1', 4.5);
  const before = { w1: w.spend.request('w1')!.total.usd, w2: w.spend.request('w2')!.total.usd, d: w.spend.session('d')!.total.usd };
  makeLegacy(w, ['d']);
  assert.equal(w.spend.splitOf(w.spend.request('w1')!).coordination.usd, 3, 'the all-time split never needed the days');
  assert.equal(w.spend.windowSplit(w.spend.request('w1')!, '2026-10-08', '2026-10-12', w.spend.request('w1')!.total).coordination.usd, 0, 'but a window finds none before the rebuild');
  const given = w.spend.rebuildCoordination('d', events, w.sessions[1]);
  assert.ok(Math.abs(given - 4.5) < 1e-9);
  assert.equal(w.spend.session('d')!.coordV, 2);
  const r1 = w.spend.request('w1')!;
  const day = (d: string) => w.spend.windowSplit(r1, d, d, r1.days[d] ?? { in: 0, out: 0, cr: 0, cw: 0, usd: 0 }).coordination.usd;
  assert.ok(Math.abs(day('2026-10-08') - 1) < 1e-9);
  assert.ok(Math.abs(day('2026-10-09') - 1.5) < 1e-9);
  assert.ok(Math.abs(day('2026-10-10') - 0.5) < 1e-9);
  assert.ok(Math.abs(w.spend.windowSplit(w.spend.request('w2')!, '2026-10-09', '2026-10-09', w.spend.request('w2')!.days['2026-10-09']).coordination.usd - 1.5) < 1e-9);
  // the totals did not move, and it does not run twice
  assert.equal(w.spend.request('w1')!.total.usd, before.w1);
  assert.equal(w.spend.request('w2')!.total.usd, before.w2);
  assert.equal(w.spend.session('d')!.total.usd, before.d);
  assert.equal(w.spend.rebuildCoordination('d', events, w.sessions[1]), 0);
});

test('coordination: w605 — an old turn billed to a request by a citation keeps the day it was spent, not the days of the real mentions (the first rebuild scaled the wrong shape)', () => {
  // Recorded by the old rules: the restart notice cites (w605), so the dispatcher's expensive turn on 10-11 was billed to it.
  const notice = '[app restarted] The portal restarted. Could not resume: x waits for the daemon (an update available is no reason to wait; only a protocol this portal no longer drives is, w605); resumed after that';
  const w = world([item('w605', { status: 'done', sessionIds: ['s1'], links: { s1: { at: iso(T0), how: 'sent' } } })], [session('s1'), DISPATCHER()]);
  w.spend.observe('s1', resultEvent(T0 + 60_000, { cum: { m: tok({ usd: 2, cr: 1 }) } }, 2));
  seq = 0;
  const { events, turn } = recorded(w);
  turn(T0 + 100_000, '[worker update] w605 "x"', 1); // 10-08: a real mention
  w.spend.observe('d', userEvent(T0 + 3 * DAY, '[work request] w605')); // stands in for the notice: the old rule billed it to w605
  w.spend.observe('d', resultEvent(T0 + 3 * DAY + 30_000, { cum: { m: tok({ usd: 101, cr: 1 }) } }, 101));
  events.push(userEvent(T0 + 3 * DAY, notice), resultEvent(T0 + 3 * DAY + 30_000, { cum: { m: tok({ usd: 101, cr: 1 }) } }, 101));
  makeLegacy(w, ['d']);
  w.spend.rebuildCoordination('d', events, w.sessions[1]);
  const r = w.spend.request('w605')!;
  const day = (d: string) => w.spend.windowSplit(r, d, d, r.days[d] ?? { in: 0, out: 0, cr: 0, cw: 0, usd: 0 });
  assert.ok(Math.abs(day('2026-10-11').coordination.usd - 100) < 1e-9, 'the 100 stays on the day it was spent');
  assert.equal(day('2026-10-11').workers.usd, 0, 'and is not worker cost in a window that holds that day');
  assert.ok(Math.abs(day('2026-10-08').coordination.usd - 1) < 1e-9);
  assert.ok(Math.abs(day('2026-10-08').workers.usd - 2) < 1e-9);
  const rep = buildReport(w.spend, T0 + 3 * DAY + 3_600_000, { days: 2 });
  assert.equal(rep.top.find((t) => t.id === 'w605')?.usd ?? 0, 0);
  assert.ok(Math.abs(rep.coordination.usd - 100) < 1e-9);
});

test('coordination: no day holds more coordination than the request spent that day; what the replay misses goes where there is room', () => {
  const w = world([item('w1', { sessionIds: ['s1'], links: { s1: { at: iso(T0), how: 'sent' } } })], [session('s1'), DISPATCHER()]);
  seq = 0;
  const { events, turn } = recorded(w);
  w.spend.observe('s1', resultEvent(T0 + 60_000, { cum: { m: tok({ usd: 1, cr: 1 }) } }, 1));
  turn(T0 + 2 * DAY, '[worker update] w1', 10); // recorded on 10-10: the request spent 11 that day, 1 on 10-08
  makeLegacy(w, ['d']);
  // a transcript that puts the turn on the wrong day (10-12, a day the request never spent on): it cannot be placed there
  const wrong = [userEvent(T0 + 4 * DAY, '[worker update] w1'), resultEvent(T0 + 4 * DAY + 30_000, { cum: { m: tok({ usd: 10, cr: 1 }) } }, 10)];
  w.spend.rebuildCoordination('d', wrong, w.sessions[1]);
  const r = w.spend.request('w1')!;
  for (const [d, t] of Object.entries(r.days)) {
    const c = Object.values(r.coordDays!).reduce((a, days) => a + (days[d]?.usd ?? 0), 0);
    assert.ok(c <= t.usd + 1e-9, `${d}: ${c} of coordination in ${t.usd}`);
  }
  const all = Object.values(r.coordDays!.d).reduce((a, t) => a + t.usd, 0);
  assert.ok(Math.abs(all - 10) < 1e-9, 'the whole recorded 10 is placed, on the days with room');
  assert.equal(events.length, 2);
});

test('coordination: a turn recorded by the current code before the rebuild runs is not counted twice', () => {
  const w = world([item('w1', { sessionIds: ['s1'], links: { s1: { at: iso(T0), how: 'sent' } } })], [DISPATCHER()]);
  seq = 0;
  const { events, turn } = recorded(w);
  turn(T0, '[worker update] w1', 2);
  makeLegacy(w, ['d']);
  // the portal is back up with the new code: the next turn is recorded live, with its day, before the old ones are rebuilt
  turn(T0 + DAY, '[worker update] w1', 5);
  assert.equal(w.spend.session('d')!.coordFrom, events[3].seq);
  w.spend.rebuildCoordination('d', events, w.sessions[0]);
  const r = w.spend.request('w1')!;
  const total = Object.values(r.coordDays!.d).reduce((a, t) => a + t.usd, 0);
  assert.ok(Math.abs(total - 5) < 1e-9, '2 from before + 3 live, each once');
  assert.ok(Math.abs(r.coordDays!.d['2026-10-08'].usd - 2) < 1e-9);
  assert.ok(Math.abs(r.coordDays!.d['2026-10-09'].usd - 3) < 1e-9);
});

test("coordination: with no transcript left the coordination takes the days with room: the request's own", () => {
  const w = world([item('w1', { sessionIds: ['s1'], links: { s1: { at: iso(T0), how: 'sent' } } })], [session('s1'), DISPATCHER()]);
  w.spend.observe('s1', resultEvent(T0 + 60_000, { cum: { m: tok({ usd: 3, cr: 1 }) } }, 3));
  coordTurn(w, 'd', T0 + DAY, '[worker update] w1', 3);
  makeLegacy(w, ['d']);
  assert.equal(w.spend.rebuildCoordination('d', undefined, w.sessions[1]), 3);
  const r = w.spend.request('w1')!;
  // the request spent 3 on day one and 3 on day two: the 3 of coordination is spread 1.5 and 1.5
  assert.ok(Math.abs(r.coordDays!.d['2026-10-08'].usd - 1.5) < 1e-9);
  assert.ok(Math.abs(r.coordDays!.d['2026-10-09'].usd - 1.5) < 1e-9);
});

test('coordination: a record from the first version (days keyed by "dispatcher") loses them and its coordinators are rebuilt', () => {
  const w = world([item('w1')], [DISPATCHER(), session('s1')]);
  coordTurn(w, 'd', T0, '[worker update] w1', 1);
  w.spend.flush();
  const file = path.join(w.dir, 'spend.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  raw.requests.w1.coordDays = { dispatcher: raw.requests.w1.coordDays.d }; // how the first version wrote them
  delete raw.sessions.d.coordV;
  raw.sessions.d.coordSplit = true;
  raw.sessions.d.legacyRequests = { w1: 1 };
  raw.sessions.d.coordFrom = 99;
  fs.writeFileSync(file, JSON.stringify(raw));
  const again = new SpendStore(w.dir, { work: () => w.items, session: () => undefined, priorResults: () => 1 });
  assert.equal(again.request('w1')!.coordDays?.dispatcher, undefined, 'the wrong days are dropped');
  assert.equal(again.session('d')!.coordV, undefined, 'and the session waits for its rebuild');
  assert.equal(again.rebuildCoordination('d', [userEvent(T0, '[worker update] w1'), resultEvent(T0 + 30_000, { cum: { m: tok({ usd: 1, cr: 1 }) } }, 1)], undefined), 1);
  assert.equal(again.request('w1')!.coordDays!.d['2026-10-08'].usd, 1);
});

test('namedIdsIn: a request cited in parentheses by a harness notice is not what the turn is about (w1161: the restart notices billed the dispatcher to w605)', () => {
  const machines = "[machines] beast's daemon has an update available (0.9.1 behind 0.9.2). It keeps taking, starting and resuming agents meanwhile; a verified portal deploy updates it by itself (docs/ops-worker.md, \"After a verified deploy\"); if it stays behind, ops_worker machine_update does it now. No drain or wait is needed: agents run on through an update (w605).";
  const restarted = "[app restarted] The portal restarted. Could not resume: x waits for beast's daemon to be connected (an update available is no reason to wait; only a protocol this portal no longer drives is, w605); resumed after that, and you get a message";
  assert.equal(machines.indexOf('w605') < 400, true, 'the id sits inside the 400 characters the attribution reads');
  assert.deepEqual(namedIdsIn([machines]), []);
  assert.deepEqual(namedIdsIn([restarted]), []);
  assert.deepEqual(namedIdsIn(["[app restarted] Resumed w12 and w13 (see w605)"]), ['w12', 'w13'], 'ids that are the notice\'s own subject still count');
  assert.deepEqual(namedIdsIn(['[work request] w859 "Spend (like w605)"']), ['w859', 'w605'], 'only harness notices are read this way');
  const w = world([item('w605')], [DISPATCHER()]);
  coordTurn(w, 'd', T0, machines, 0.3);
  assert.equal(w.spend.request('w605'), undefined);
  assert.ok(Math.abs(w.spend.request('_dispatcher')!.total.usd - 0.3) < 1e-9);
});

test('w1159: a worker session that served more than 20 requests lists the top 20 as well', () => {
  const ids = Array.from({ length: 25 }, (_, i) => `w${300 + i}`);
  const items = ids.map((id) => item(id, { sessionIds: ['s1'], links: { s1: { at: iso(T0), how: 'sent' } } }));
  const w = world(items, [session('s1')]);
  w.spend.observe('s1', resultEvent(T0 + 60_000, { cum: { m: tok({ usd: 25, cr: 1000 }) } }, 25));
  const link = (sid: string) => 'https://p/#/session/' + sid;
  const line = renderSession(w.spend, 's1', link).split('\n').find((l) => l.startsWith('Requests it served'))!;
  assert.ok(line.startsWith("Requests it served (the workers' own cost; 25 requests, the top 20 by cost): "), line);
  assert.ok(line.includes('and 5 more, $5.00 together (spend_report session with requests: 25 lists them all)'), line);
  const all = renderSession(w.spend, 's1', link, 2000).split('\n').find((l) => l.startsWith('Requests it served'))!;
  assert.ok(all.startsWith("Requests it served (the workers' own cost): ") && !all.includes('more'), all);
});

// ---------------------------------------------------------------------------------------------------------------------
// the attribution audit (w1209)
// ---------------------------------------------------------------------------------------------------------------------

test('audit: a worker keeping a closed request linked spends the turn on the open one; reopened, it shares again', () => {
  const closed = item('w1', { sessionIds: ['s1'], status: 'done', updatedAt: iso(T0 - 5000), links: { s1: { at: iso(T0), how: 'sent' } } });
  const open = item('w2', { sessionIds: ['s1'], links: { s1: { at: iso(T0 + 500), how: 'linked' } } });
  const w = world([closed, open], [session('s1')]);
  w.spend.observe('s1', resultEvent(T0 + 60_000, { cum: { m: tok({ usd: 2, cr: 1 }) } }, 2));
  assert.equal(w.spend.request('w1'), undefined, 'nothing on the request that closed before the turn began');
  assert.equal(w.spend.request('w2')!.total.usd, 2);
  closed.status = 'active'; // reopened
  w.spend.observe('s1', resultEvent(T0 + 120_000, { cum: { m: tok({ usd: 6, cr: 1 }) } }, 6));
  assert.equal(w.spend.request('w1')!.total.usd, 2);
  assert.equal(w.spend.request('w2')!.total.usd, 4);
  // every linked request closed: they still share it, the money has to go somewhere
  closed.status = 'done';
  open.status = 'done';
  open.updatedAt = iso(T0 + 1000);
  w.spend.observe('s1', resultEvent(T0 + 180_000, { cum: { m: tok({ usd: 8, cr: 1 }) } }, 8));
  assert.equal(w.spend.request('w1')!.total.usd, 3);
  assert.equal(w.spend.request('w2')!.total.usd, 5);
});

test("audit: a coordinator whose session the store no longer holds is still a coordinator, never a worker's turn", () => {
  const w = world([item('w1')], [DISPATCHER()]);
  coordTurn(w, 'd', T0, '[worker update] w1', 1);
  // the store forgets the session (the record keeps its role)
  w.sessions.length = 0;
  w.spend.observe('d', userEvent(T0 + 10_000, '[worker update] w1'));
  w.spend.observe('d', resultEvent(T0 + 40_000, { cum: { m: tok({ usd: 3, cr: 3000 }) } }, 3));
  assert.equal(w.spend.session('d')!.role, 'dispatcher');
  assert.equal(w.spend.request('_unattributed'), undefined, 'not billed through the worker rules');
  assert.equal(w.spend.splitOf(w.spend.request('w1')!).workers.usd, 0);
  assert.equal(w.spend.splitOf(w.spend.request('w1')!).coordination.usd, 3);
});

test("audit: ContextMeter — a resumed conversation's unexplained cache read is carried over, not base (w1209, w1163's measurement)", () => {
  const read = (resumed: boolean) => {
    const m = new ContextMeter();
    if (resumed) m.carry();
    m.addUser(2000);
    m.call({ id: 'a', model: 'claude-sonnet-5-5', in: 1, out: 50, cr: 300_000, cw: 3000 });
    m.addToolResult('x', 100);
    m.call({ id: 'b', model: 'claude-sonnet-5-5', in: 1, out: 50, cr: 303_000, cw: 500 });
    return m.drain().cats;
  };
  const resumed = read(true);
  const fresh = read(false);
  assert.ok(resumed.carried.tok > 590_000, 'both calls read the carried context');
  assert.ok((resumed.base?.tok ?? 0) < 5000, 'and it is not base');
  assert.equal(fresh.carried, undefined);
  assert.ok(fresh.base.tok > 590_000, 'a session the meter built itself keeps counting the unexplained read as base');
  const total = (c: typeof resumed) => Object.values(c).reduce((a, x) => a + x.usd, 0);
  assert.ok(Math.abs(total(resumed) - total(fresh)) < 1e-9, 'the dollars are the same either way');
});

test('audit: whatever the mix of turns, workers + coordination + not-any-request-s = the total and the requests add up to the sessions', () => {
  const sessions = [session('s1'), session('s2', { title: 'w3: x' }), session('s3', { title: 'no id' }), DISPATCHER(), ORCH(), OPS(), session('st', { kind: 'standing', standingId: 'sentry' })];
  const items = [
    item('w1', { sessionIds: ['s1'], links: { s1: { at: iso(T0), how: 'sent' } } }),
    item('w2', { sessionIds: ['s1'], links: { s1: { at: iso(T0 + 1), how: 'linked' } } }),
    item('w3'),
    item('w4', { status: 'done', updatedAt: iso(T0) }),
    item('w5'),
    item('w6'),
    item('w7'),
  ];
  const w = world(items, sessions);
  const msgs = ['[worker update] w1', '[work request] w2 and w3 w4 w5 w6 w7', '[heartbeat] quiet', '[app restarted] x (w1)', '[machines] y (w2)', '[ops worker] w3', 'hello'];
  let n = 7;
  const cum: Record<string, number> = {};
  for (let i = 0; i < 120; i++) {
    const sid = ['s1', 's2', 's3', 'd', 'o', 'ops', 'st'][(i * 7 + (i >> 2)) % 7];
    const usd = ((i * 37) % 11) / 10 + 0.05;
    cum[sid] = (cum[sid] ?? 0) + usd;
    const at = T0 + i * 7 * 3_600_000;
    if (sid !== 's1' && sid !== 's2' && sid !== 's3' && sid !== 'st') w.spend.observe(sid, userEvent(at, msgs[(i * 5) % msgs.length]));
    w.spend.observe(sid, resultEvent(at + 30_000, { cum: { m: tok({ usd: cum[sid], cr: 1 }) } }, cum[sid]));
    n++;
  }
  const grand = Object.values(cum).reduce((a, x) => a + x, 0);
  const fromSessions = [...w.spend.sessions.values()].reduce((a, s) => a + s.total.usd, 0);
  const fromRequests = [...w.spend.requests.values()].reduce((a, r) => a + r.total.usd, 0);
  assert.ok(Math.abs(fromSessions - grand) < 1e-6, 'every dollar a session spent is in its record');
  assert.ok(Math.abs(fromRequests - grand) < 1e-6, 'and in exactly one share of requests and buckets');
  const rep = buildReport(w.spend, T0 + 120 * 7 * 3_600_000, { days: 120, top: 50 });
  const loose = rep.buckets.reduce((a, b) => a + b.usd, 0);
  assert.ok(Math.abs(rep.workers.usd + rep.coordination.usd + loose - rep.total.usd) < 1e-6);
  assert.ok(Math.abs(rep.total.usd - grand) < 1e-6);
  assert.ok(rep.coordination.usd > 0 && rep.workers.usd > 0 && loose > 0);
  assert.equal(w.spend.request('w4')?.sessions?.s1, undefined, 'the closed request got no worker turn');
  void n;
});

// ---------------------------------------------------------------------------------------------------------------------
// correcting history (w1209)
// ---------------------------------------------------------------------------------------------------------------------

/** A live-recorded session as the old portal left it: fixV not set, the cost rule and the notice rule of before 2026-10-13. */
function legacyOf(w: ReturnType<typeof world>, sid: string) {
  const s = w.spend.session(sid)!;
  s.fixV = undefined;
  return s;
}

test('correctHistory: a restart that counted the CLI\'s whole running total as one turn is recorded again as the turn it was', () => {
  const w = world([item('w1', { sessionIds: ['s1'], links: { s1: { at: iso(T0), how: 'sent' } } })], [session('s1')]);
  seq = 0;
  const e1u = userEvent(T0, 'start');
  const e1 = resultEvent(T0 + 60_000, { cum: { m: tok({ usd: 10, cr: 1000 }) } }, 10);
  const e2u = userEvent(T0 + 3_600_000, 'go on');
  // the process restarted and resumed: its totals continue from the saved ones (10 → 10.5), and the flag says restarted
  const e2 = resultEvent(T0 + 3_660_000, { restarted: true, cum: { m: tok({ usd: 10.5, cr: 1100 }) } }, 10.5);
  for (const e of [e1u, e1]) w.spend.observe('s1', e);
  const s = legacyOf(w, 's1');
  // what the old portal recorded for the second turn: the whole 10.5
  w.spend.add({ s, at: e2.t, models: { m: tok({ usd: 10.5, cr: 1100 }) }, total: tok({ usd: 10.5, cr: 1100 }), estimated: false, allocs: [{ id: 'w1', weight: 1, how: 'link' }] });
  assert.ok(Math.abs(w.spend.request('w1')!.total.usd - 20.5) < 1e-9);
  const r = w.spend.correctHistory('s1', [e1u, e1, e2u, e2], w.sessions[0]);
  assert.equal(r.skipped, undefined);
  assert.equal(r.turns, 1);
  assert.ok(Math.abs(r.removedUsd - 10) < 1e-9);
  assert.ok(Math.abs(w.spend.request('w1')!.total.usd - 10.5) < 1e-9, 'the request holds the 10 and the 0.5');
  assert.ok(Math.abs(w.spend.session('s1')!.total.usd - 10.5) < 1e-9);
  assert.ok(Math.abs(w.spend.request('w1')!.models.m.usd - 10.5) < 1e-9);
  assert.ok(Math.abs(w.spend.request('w1')!.days['2026-10-08'].usd - 10.5) < 1e-9);
  assert.equal(w.spend.session('s1')!.turns, 2, 'the turn count did not move');
  // once
  assert.equal(w.spend.correctHistory('s1', [e1u, e1, e2u, e2], w.sessions[0]).turns, 0);
});

test("correctHistory: a request a notice only cited loses the turns billed to it; they are in the coordinator's own bucket, and the totals add up", () => {
  const notice = '[app restarted] The portal restarted. Could not resume: x waits for the daemon (an update available is no reason to wait; only a protocol this portal no longer drives is, w605); resumed after that';
  const w = world([item('w605', { status: 'done' }), item('w9')], [DISPATCHER()]);
  seq = 0;
  coordTurn(w, 'd', T0, '[worker update] w9', 1); // creates the session; billed to w9
  const s = legacyOf(w, 'd');
  const u = userEvent(T0 + DAY, notice);
  const e = resultEvent(T0 + DAY + 30_000, { cum: { m: tok({ usd: 101, cr: 100_000 }) } }, 101);
  // what the old portal recorded: billed to w605
  w.spend.add({ s, at: e.t, models: { m: tok({ usd: 100, cr: 99_000 }) }, total: tok({ usd: 100, cr: 99_000 }), estimated: false, allocs: [{ id: 'w605', weight: 1, how: 'message' }] });
  s.cum = { m: tok({ usd: 101, cr: 100_000 }) };
  const first = [userEvent(T0, '[worker update] w9'), resultEvent(T0 + 30_000, { cum: { m: tok({ usd: 1, cr: 1000 }) } }, 1)];
  const events = [...first, u, e];
  const grand = w.spend.session('d')!.total.usd;
  assert.ok(Math.abs(w.spend.request('w605')!.total.usd - 100) < 1e-9);
  const r = w.spend.correctHistory('d', events, w.sessions[0]);
  assert.equal(r.skipped, undefined, r.skipped ?? "");
  assert.ok(Math.abs(r.movedUsd - 100) < 1e-9);
  assert.ok(Math.abs(w.spend.request('w605')!.total.usd) < 1e-9, 'nothing left on the request that was only cited');
  assert.ok(Math.abs(w.spend.request('_dispatcher')!.total.usd - 100) < 1e-9, "and it is the dispatcher's own");
  assert.ok(Math.abs(w.spend.session('d')!.total.usd - grand) < 1e-9, 'the session spent what it spent');
  const sumReq = [...w.spend.requests.values()].reduce((a, x) => a + x.total.usd, 0);
  assert.ok(Math.abs(sumReq - grand) < 1e-9, 'requests and buckets still add up to the session');
  // its days are rebuilt from the corrected record
  assert.equal(w.spend.session('d')!.coordV, undefined);
  w.spend.rebuildCoordination('d', events, w.sessions[0]);
  assert.equal(w.spend.request('w605')!.coordDays?.d, undefined);
  const rep = buildReport(w.spend, T0 + 2 * DAY, { days: 7 });
  assert.ok(Math.abs(rep.workers.usd + rep.coordination.usd + rep.buckets.reduce((a, b) => a + b.usd, 0) - rep.total.usd) < 1e-9);
  assert.ok(Math.abs(rep.coordination.usd - 1) < 1e-9, 'only the real mention is coordination');
});

test('correctHistory: a record the replay does not explain is left as it was, with the reason', () => {
  const w = world([item('w1', { sessionIds: ['s1'], links: { s1: { at: iso(T0), how: 'sent' } } })], [session('s1')]);
  seq = 0;
  const e1u = userEvent(T0, 'start');
  const e1 = resultEvent(T0 + 60_000, { cum: { m: tok({ usd: 10, cr: 1000 }) } }, 10);
  const e2u = userEvent(T0 + 3_600_000, 'go on');
  const e2 = resultEvent(T0 + 3_660_000, { restarted: true, cum: { m: tok({ usd: 10.5, cr: 1100 }) } }, 10.5);
  for (const e of [e1u, e1]) w.spend.observe('s1', e);
  const s = legacyOf(w, 's1');
  w.spend.add({ s, at: e2.t, models: { m: tok({ usd: 10.5 }) }, total: tok({ usd: 10.5 }), estimated: false, allocs: [{ id: 'w1', weight: 1, how: 'link' }] });
  s.total = tok({ usd: 50 }); // the record holds far more than the transcript explains (a transcript that lost its first half, say)
  const r = w.spend.correctHistory('s1', [e1u, e1, e2u, e2], w.sessions[0]);
  assert.match(r.skipped!, /replay reads \$20\.50 where the record holds \$50\.00/);
  assert.equal(r.turns, 0);
  assert.ok(Math.abs(w.spend.request('w1')!.total.usd - 20.5) < 1e-9, 'untouched');
});

test('correctHistory: turns the current code recorded are not touched, and a session first seen by it has nothing to correct', () => {
  const w = world([item('w1', { sessionIds: ['s1'], links: { s1: { at: iso(T0), how: 'sent' } } })], [session('s1')]);
  w.spend.observe('s1', userEvent(T0, 'start'));
  w.spend.observe('s1', resultEvent(T0 + 60_000, { cum: { m: tok({ usd: 1, cr: 1000 }) } }, 1));
  assert.equal(w.spend.session('s1')!.fixV, 2);
  assert.equal(w.spend.correctHistory('s1', [], w.sessions[0]).turns, 0);
});

test("spend_report: a bucket's request view says it is no request's and shows one figure per day; a long session list is cut", () => {
  const w = world([item('w1')], [DISPATCHER()]);
  for (let i = 0; i < 3; i++) coordTurn(w, 'd', T0 + i * DAY, '[heartbeat] quiet', 2);
  const text = renderRequest(w.spend, '_dispatcher', (sid) => `#/session/${sid}`, 7);
  assert.match(text, /\[not any request's\]: \$6\.00[^\n]*from coordinators/);
  assert.match(text, /By UTC day, newest first: 2026-10-10 \$2\.00; 2026-10-09 \$2\.00; 2026-10-08 \$2\.00/);
  assert.doesNotMatch(text, /workers \/ coordination/);
  // many worker sessions in one bucket
  const many = world([], Array.from({ length: 40 }, (_, i) => session(`u${i}`, { title: `none ${i}` })));
  for (let i = 0; i < 40; i++) many.spend.observe(`u${i}`, resultEvent(T0 + i * 1000, { cum: { m: tok({ usd: 1 + i / 100, cr: 1 }) } }, 1 + i / 100));
  const big = renderRequest(many.spend, '_unattributed', () => '', 7);
  assert.equal((big.match(/^- u\d+ /gm) ?? []).length, 25);
  assert.match(big, /and 15 more session\(s\), \$/);
});

test("correctHistory: the turns it puts back keep the session's accounts: none goes below zero, and they add up to what the session holds", () => {
  const w = world([item('w1', { sessionIds: ['s1'], links: { s1: { at: iso(T0), how: 'sent' } } })], [session('s1', { ranAs: 'vault A' })]);
  seq = 0;
  const e1u = userEvent(T0, 'start');
  const e1 = resultEvent(T0 + 60_000, { cum: { m: tok({ usd: 10, cr: 1000 }) } }, 10);
  const e2u = userEvent(T0 + 3_600_000, 'go on');
  const e2 = resultEvent(T0 + 3_660_000, { restarted: true, cum: { m: tok({ usd: 10.5, cr: 1100 }) } }, 10.5);
  for (const e of [e1u, e1]) w.spend.observe('s1', e);
  w.sessions[0].ranAs = 'vault B';
  const s = legacyOf(w, 's1');
  w.spend.add({ s, at: e2.t, models: { m: tok({ usd: 10.5, cr: 1100 }) }, total: tok({ usd: 10.5, cr: 1100 }), estimated: false, allocs: [{ id: 'w1', weight: 1, how: 'link' }], account: 'vault B' });
  assert.equal(w.spend.correctHistory('s1', [e1u, e1, e2u, e2], w.sessions[0]).turns, 1);
  const accs = w.spend.session('s1')!.accounts!;
  assert.ok(Object.values(accs).every((t) => t.usd >= 0), JSON.stringify(accs));
  assert.ok(Math.abs(Object.values(accs).reduce((a, t) => a + t.usd, 0) - w.spend.session('s1')!.total.usd) < 1e-9);
  const racc = w.spend.request('w1')!.accounts!;
  assert.ok(Object.values(racc).every((t) => t.usd >= 0), JSON.stringify(racc));
  assert.ok(Math.abs(Object.values(racc).reduce((a, t) => a + t.usd, 0) - w.spend.request('w1')!.total.usd) < 1e-9);
});

test('repairAccounts: a corrected session gets the accounts it had before, scaled to what it holds; a request gets them spread from its sessions', () => {
  const w = world([item('w1', { sessionIds: ['s1'], links: { s1: { at: iso(T0), how: 'sent' } } })], [session('s1', { ranAs: 'vault A' })]);
  w.spend.observe('s1', userEvent(T0, 'start'));
  w.spend.observe('s1', resultEvent(T0 + 60_000, { cum: { m: tok({ usd: 4, cr: 1000 }) } }, 4));
  // what the first release left: corrected (fixApplied), total now 4, accounts with a negative one
  const s = w.spend.session('s1')!;
  s.fixApplied = true;
  s.accounts = { 'vault A': tok({ usd: 14, cr: 1000 }), 'vault B': tok({ usd: -10 }) };
  w.spend.request('w1')!.accounts = { 'vault A': tok({ usd: 14 }), 'vault B': tok({ usd: -10 }) };
  // the copy of the record from before the correction: 60 on A, 40 on B
  const before = JSON.parse(JSON.stringify({ version: 1, requests: {}, sessions: { s1: { ...s, accounts: { 'vault A': tok({ usd: 60 }), 'vault B': tok({ usd: 40 }) } } } }));
  fs.writeFileSync(path.join(w.dir, 'spend.json.pre-w1209'), JSON.stringify(before));
  const r = w.spend.repairAccounts();
  assert.deepEqual(r, { sessions: 1, requests: 1 });
  const a = w.spend.session('s1')!.accounts!;
  assert.ok(Math.abs(a['vault A'].usd - 2.4) < 1e-9 && Math.abs(a['vault B'].usd - 1.6) < 1e-9, JSON.stringify(a));
  const ra = w.spend.request('w1')!.accounts!;
  assert.ok(Math.abs(ra['vault A'].usd - 2.4) < 1e-9 && Math.abs(ra['vault B'].usd - 1.6) < 1e-9, JSON.stringify(ra));
  assert.deepEqual(w.spend.repairAccounts(), { sessions: 0, requests: 0 }, 'once');
});

test("correctHistory: a backfilled restart turn (the portal's own total doubled, so the turn read as the whole running total again) is recorded as what it cost", () => {
  const w = world([item('w1', { sessionIds: ['s1'], links: { s1: { at: iso(T0), how: 'sent' } } })], [session('s1', { costUsd: 500 })]);
  seq = 0;
  const events: TranscriptEvent[] = [];
  // the portal's lifetime total after each turn: 10, 30 (a turn of 20), then a restart: 2 × 30 + a 2 dollar turn = 62, then 64.5
  let t = T0;
  for (const cost of [10, 30, 62, 64.5]) {
    events.push(userEvent((t += 60_000), 'go'), resultEvent((t += 60_000), undefined, cost));
  }
  const r0 = w.spend.backfillSession('s1', events, w.sessions[0]);
  assert.ok(Math.abs(r0.usd - 64.5) < 1e-9);
  assert.ok(Math.abs(w.spend.request('w1')!.total.usd - 64.5) < 1e-9);
  w.spend.session('s1')!.fixV = undefined;
  const r = w.spend.correctHistory('s1', events, w.sessions[0]);
  assert.equal(r.skipped, undefined, r.skipped ?? '');
  assert.equal(r.turns, 1);
  assert.ok(Math.abs(r.removedUsd - 30) < 1e-9, 'the 32 of the restart turn was 2 of turn and 30 of the old total');
  assert.ok(Math.abs(w.spend.request('w1')!.total.usd - 34.5) < 1e-9);
  assert.ok(Math.abs(w.spend.session('s1')!.total.usd - 34.5) < 1e-9);
  assert.ok(Math.abs(w.spend.request('w1')!.estimated.usd - 34.5) < 1e-9, 'still all estimated');
  assert.equal(w.spend.session('s1')!.fixApplied, undefined, 'only the live-recorded turns make the record read by the current rules');
  assert.equal(w.spend.correctHistory('s1', events, w.sessions[0]).turns, 0, 'once');
});

test('correctHistory: a real big turn in a backfilled session is not a restart (under $20 so far, or less than the running total)', () => {
  const w = world([item('w1', { sessionIds: ['s1'], links: { s1: { at: iso(T0), how: 'sent' } } })], [session('s1', { costUsd: 500 })]);
  seq = 0;
  const events: TranscriptEvent[] = [];
  let t = T0;
  // 3 → 9 (a turn of 6 against 3 so far: the session is young), 9 → 60 (a turn of 51 against 9: under $20 so far), 60 → 100 (40 against 60)
  for (const cost of [3, 9, 60, 100]) events.push(userEvent((t += 60_000), 'go'), resultEvent((t += 60_000), undefined, cost));
  w.spend.backfillSession('s1', events, w.sessions[0]);
  w.spend.session('s1')!.fixV = undefined;
  assert.equal(w.spend.correctHistory('s1', events, w.sessions[0]).turns, 0);
  assert.ok(Math.abs(w.spend.request('w1')!.total.usd - 100) < 1e-9);
});

test('correctHistory: a session the first release already corrected (live turns done) gets only its backfilled restart turns corrected now', () => {
  const w = world([item('w1', { sessionIds: ['s1'], links: { s1: { at: iso(T0), how: 'sent' } } })], [session('s1', { costUsd: 500 })]);
  seq = 0;
  const back: TranscriptEvent[] = [];
  let t = T0;
  for (const cost of [10, 30, 62, 64.5]) back.push(userEvent((t += 60_000), 'go'), resultEvent((t += 60_000), undefined, cost));
  w.spend.backfillSession('s1', back, w.sessions[0]);
  // then the live-recorded turns, already by the current rules
  const live = [userEvent((t += 60_000), 'on'), resultEvent((t += 60_000), { cum: { m: tok({ usd: 5, cr: 1000 }) } }, 70), userEvent((t += 60_000), 'again'), resultEvent((t += 60_000), { restarted: true, cum: { m: tok({ usd: 5.5, cr: 1100 }) } }, 70.5)];
  for (const e of live) w.spend.observe('s1', e);
  const s = w.spend.session('s1')!;
  s.fixV = 1;
  s.fixApplied = true;
  assert.ok(Math.abs(s.total.usd - 70) < 1e-9, '64.5 backfilled + 5 + 0.5');
  const r = w.spend.correctHistory('s1', [...back, ...live], w.sessions[0]);
  assert.equal(r.skipped, undefined, r.skipped ?? '');
  assert.ok(Math.abs(r.removedUsd - 30) < 1e-9);
  assert.ok(Math.abs(w.spend.session('s1')!.total.usd - 40) < 1e-9);
  assert.ok(Math.abs(w.spend.request('w1')!.total.usd - 40) < 1e-9);
});
