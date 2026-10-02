import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  clearPendingRestart,
  mayRecoverUnclean,
  describeUncleanStop,
  readAlive,
  restartSummary,
  resumeMessage,
  takePendingRestart,
  writeAlive,
  writePendingRestart,
  type ResumeEntry,
  type ResumeFile,
} from './restart.ts';

const T = (s: string) => Date.parse(s);

test('unclean stop: a machine that booted after the last heartbeat went down; otherwise only the server did', () => {
  const down = describeUncleanStop({ lastAliveAt: T('2026-09-24T23:13:10Z'), bootAt: T('2026-09-24T23:23:06Z'), host: 'BEAST' });
  assert.match(down, /^BEAST went down unexpectedly \(lost power, was hard-reset or crashed\) after .+, and booted again at .+$/);
  const crash = describeUncleanStop({ lastAliveAt: T('2026-09-24T23:13:10Z'), bootAt: T('2026-09-20T08:00:00Z'), host: 'BEAST' });
  assert.match(crash, /^the SketchUp Factory server stopped without a clean stop \(a crash or a forced kill\) after .+; BEAST itself kept running$/);
  assert.match(describeUncleanStop({ bootAt: 0, host: 'x' }), /without a clean stop/);
});

test('unclean stop: the heartbeat and a pending update survive on disk; a clean handover clears the update', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unclean-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(readAlive(dir), undefined);
  writeAlive(dir, T('2026-09-24T23:13:10Z'));
  assert.deepEqual(readAlive(dir), { at: T('2026-09-24T23:13:10Z') });
  const req = { drain: true, drainMinutes: 10, reason: 'update (request_app_update)', update: true, hold: false } as const;
  writePendingRestart(dir, { ...req, update: false });
  assert.equal(takePendingRestart(dir), undefined, 'only updates are worth retrying');
  writePendingRestart(dir, req);
  const p = takePendingRestart(dir);
  assert.equal(p?.reason, 'update (request_app_update)');
  assert.equal(takePendingRestart(dir), undefined, 'taken once');
  writePendingRestart(dir, req);
  clearPendingRestart(dir);
  assert.equal(takePendingRestart(dir), undefined);
  writePendingRestart(dir, req);
  assert.equal(takePendingRestart(dir, Date.now() + 25 * 3_600_000), undefined, 'a day old: stale');
});

test('unclean stop: agents are told what happened, and whether their editor is coming back', () => {
  const cause = 'BEAST went down unexpectedly (lost power, was hard-reset or crashed) after 9/24/2026, 5:13:10 PM, and booted again at 9/24/2026, 5:23:06 PM';
  const f: ResumeFile = { version: 1, reason: cause, cause, update: false, at: '2026-09-24T23:13:10Z', sessions: [], orchestratorBusy: true, editors: ['sb1'] };
  const e = (over: Partial<ResumeEntry>): ResumeEntry => ({ id: 'w1', kind: 'worker', title: 't', why: 'mid-turn', unanswered: [{ text: 'do the thing', from: 'orchestrator' }], lastFrom: 'orchestrator', ...over });
  const withEditor = resumeMessage(e({ sandboxId: 'sb1' }), f);
  assert.match(withEditor, /^BEAST went down unexpectedly.*\. The app is back and resumes you now\..*your Unity editor is being started again: wait for it \(mcp__sandbox__wait_for_unity/);
  assert.match(withEditor, /do the thing/);
  assert.match(resumeMessage(e({ sandboxId: 'sb2' }), f), /your Unity editor was not running/);
  assert.doesNotMatch(resumeMessage(e({ machineId: 'm5' }), f), /Unity editor/);
  const sum = restartSummary(f, [{ id: 'w1', title: 't', sandboxId: 'sb1', ok: true }], undefined, { head: 'abc', version: '0.1.0' });
  assert.match(sum, /^\[app restarted\] SketchUp Factory restarted WITHOUT a clean stop: BEAST went down unexpectedly/);
  assert.match(sum, /Unity editors that were up: sb1 \(started again before their agents resumed\)/);
  assert.match(sum, /Resumed automatically: "t" \(w1 in sb1\)/);
  const upd = restartSummary({ ...f, update: true, reason: 'update (request_app_update)' }, [], { ok: true, at: '', headBefore: 'aaaaaaaaaa', headAfter: 'bbbbbbbbbb' }, { head: 'bbb', version: '0.1.0' });
  assert.match(upd, /The update that was pending then \(update \(request_app_update\)\) was retried\..*Update OK \(aaaaaaaaa → bbbbbbbbb\)/);
});

test('unclean stop: the crash-loop guard lets one recovery through per 30 minutes', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unclean-loop-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const now = T('2026-09-24T23:25:00Z');
  assert.equal(mayRecoverUnclean(dir, now), true);
  assert.equal(mayRecoverUnclean(dir, now + 10 * 60_000), false);
  assert.equal(mayRecoverUnclean(dir, now + 31 * 60_000), true);
});
