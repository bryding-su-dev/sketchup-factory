import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { StandingAgents, type SessionLike, type SessionPort } from './standing.ts';
import { normalizeAutoApprove, DEFAULT_AUTO } from './schedule.ts';
import { Store } from './store.ts';
import type { Config } from './config.ts';
import type { GitStatus, Machine, Sandbox, SessionInfo } from '../shared/types.ts';

const now0 = new Date('2026-09-24T03:00:00');

function setup(t: { after: (fn: () => void) => void }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-auto-'));
  const cfg = {
    dataDir: path.join(tmp, 'data'),
    sandboxRoot: path.join(tmp, 'sb'),
    standingRoot: path.join(tmp, 'sb', '_agents'),
    protectedPaths: [],
    repo: { url: 'x', basePath: path.join(tmp, 'sb', '_base') },
    limits: { maxSessions: 6 },
    models: ['opus', 'sonnet'],
    defaultModel: 'opus',
    worker: { permissionMode: 'bypassPermissions', effort: 'high' },
  } as unknown as Config;
  const store = new Store(cfg.dataDir);
  const events = new EventEmitter();
  const infos = new Map<string, SessionInfo>();
  const port: SessionPort = {
    events,
    create: (o) => {
      const info = { id: `s${infos.size + 1}`, kind: o.kind, title: o.title, status: 'stopped', permissionMode: o.permissionMode, standingId: o.standingId, createdAt: '', lastActivityAt: '', turns: 0, costUsd: 0, pendingPermissions: [] } as SessionInfo;
      infos.set(info.id, info);
      return { info, live: false, stop() {} } as SessionLike;
    },
    get: (id) => ({ info: infos.get(id)!, live: false, stop() {} }),
    send: () => 'u',
    liveAgents: () => 0,
    remove: () => undefined,
  };
  const sandboxes: Sandbox[] = [];
  const machines: Machine[] = [];
  const started: { where: string; model?: string; effort?: string; prompt: string }[] = [];
  const notes: string[] = [];
  const clock = { now: now0 };
  const st = new StandingAgents({
    cfg,
    store,
    sessions: port,
    notify: (x) => notes.push(x),
    sandboxes: { list: () => sandboxes, setPurpose: (id, p) => Object.assign(sandboxes.find((s) => s.id === id)!, { purpose: p }) },
    machines: {
      list: () => machines,
      setPurpose: (id, p) => Object.assign(machines.find((m) => m.id === id)!, { purpose: p }),
      get: (id) => machines.find((m) => m.id === id),
      isOnline: (id) => !!machines.find((m) => m.id === id)?.online,
      liveCount: () => 0,
      createSession: () => ({ info: {} as SessionInfo, live: false, stop() {} }),
    },
    startWorker: (req) => {
      const id = `w${started.length + 1}`;
      started.push({ where: req.sandbox ?? `machine:${req.machine}`, model: req.model, effort: req.effort, prompt: req.prompt });
      const info = { id, kind: 'worker', title: req.title ?? '', status: 'running', permissionMode: 'bypassPermissions', createdAt: '', lastActivityAt: '', turns: 0, costUsd: 0, pendingPermissions: [] } as SessionInfo;
      store.sessions.set(id, info);
      return { info };
    },
    now: () => clock.now,
  });
  const sandbox = (id: string, purpose = 'unused'): Sandbox => {
    const s = { id, name: id, branch: `sandbox/${id}`, base: 'origin/develop', path: path.join(tmp, id), purpose, status: 'ready', createdAt: '', unity: { state: 'stopped' }, sessionIds: [] } as Sandbox;
    sandboxes.push(s);
    return s;
  };
  const machine = (id: string, git: Partial<GitStatus> = { dirty: 0 }): Machine => {
    const m = { id, host: id, purpose: 'unused', status: 'ready', online: true, repoPath: '/r', home: '/h', portalUrl: '', maxSessions: 3, sessionIds: [], createdAt: '', git: { branch: 'develop', untracked: 0, at: '', ...git } } as Machine;
    machines.push(m);
    return m;
  };
  const agent = st.create({
    name: 'Nightly sentry',
    charter: 'Triage develop.',
    trigger: { kind: 'manual' },
    tools: ['delegate'],
    autoApprove: { enabled: true },
  });
  t.after(() => {
    store.flush();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  return { st, store, sandbox, machine, started, notes, agent, clock, events };
}

test('auto-approve: defaults are Sonnet, high effort, 3 per run and per day, never mp-r2', () => {
  const a = normalizeAutoApprove({ enabled: true }, undefined, ['opus', 'sonnet']);
  assert.deepEqual(a, { ...DEFAULT_AUTO, enabled: true });
  assert.equal(a.model, 'sonnet');
  assert.equal(a.effort, 'high');
  assert.deepEqual(a.exclude, ['mp-r2']);
  assert.throws(() => normalizeAutoApprove({ effort: 'extreme' as never }, undefined, ['opus', 'sonnet']), /effort/);
  assert.throws(() => normalizeAutoApprove({ model: 'gpt' }, undefined, ['opus', 'sonnet']), /model/);
  assert.equal(normalizeAutoApprove({ maxPerRun: 9, maxPerDay: 2 }, undefined, ['opus', 'sonnet']).maxPerRun, 2, 'per run never above per day');
});

test('auto-approve: starts at once on an unused sandbox, with the safety brief, model and effort; skips mp-r2 and labelled ones', (t) => {
  const { st, sandbox, started, notes, agent } = setup(t);
  sandbox('mp-r2');
  sandbox('busy', 'spec 098 work');
  const free = sandbox('sb3');
  const d = st.requestDelegation(agent.id, 'Verify 1a2b3c', 'Check commit 1a2b3c.');
  assert.equal(d.status, 'approved');
  assert.equal(d.autoApproved, true);
  assert.equal(d.sandboxId, 'sb3');
  assert.deepEqual([started[0].where, started[0].model, started[0].effort], ['sb3', 'sonnet', 'high']);
  assert.match(started[0].prompt, /Do NOT push to develop directly/);
  assert.match(started[0].prompt, /pull request into develop only\. Never merge it/);
  assert.match(free.purpose, /Verify 1a2b3c/);
  assert.match(d.log!.join('\n'), /auto-approved: worker w1 started in sandbox sb3/);
  assert.match(notes.at(-1)!, /^\[auto-delegation\] Started worker w1 in sandbox sb3/);
});

test('auto-approve: no free target queues it; it starts when one frees, on an idle machine too, and expires by morning', (t) => {
  const { st, store, sandbox, machine, started, notes, agent, clock } = setup(t);
  const d1 = st.requestDelegation(agent.id, 'A', 'task a');
  assert.equal(d1.status, 'pending');
  assert.equal(d1.auto, 'queued');
  assert.match(d1.log!.at(-1)!, /no free target yet/);

  machine('m3', { dirty: 2 }); // dirty tree: not a target
  clock.now = new Date(now0.getTime() + 10 * 60_000);
  st.tick();
  assert.equal(store.delegations.get(d1.id)!.status, 'pending');
  machine('m5', { dirty: 0 });
  st.tick();
  assert.equal(store.delegations.get(d1.id)!.machineId, 'm5');
  assert.equal(started[0].where, 'machine:m5');

  const d2 = st.requestDelegation(agent.id, 'B', 'task b');
  assert.equal(d2.auto, 'queued');
  clock.now = new Date(now0.getTime() + 9 * 3600_000); // past the 8 h expiry
  st.tick();
  assert.equal(store.delegations.get(d2.id)!.status, 'expired');
  assert.match(notes.at(-1)!, /expired: no free sandbox or machine/);
  sandbox('sb9');
  st.tick();
  assert.equal(started.length, 1, 'an expired request never starts');
});

test('auto-approve: the per-day limit leaves the rest for the user; finishing wakes the orchestrator once', (t) => {
  const { st, sandbox, started, notes, agent, events, store } = setup(t);
  for (const id of ['a', 'b', 'c', 'd']) sandbox(id);
  const ds = ['1', '2', '3', '4'].map((n) => st.requestDelegation(agent.id, `T${n}`, `task ${n}`));
  assert.deepEqual(
    ds.map((d) => d.status),
    ['approved', 'approved', 'approved', 'pending'],
  );
  assert.equal(ds[3].auto, undefined);
  assert.match(ds[3].log!.at(-1)!, /not auto-approved: already 3 today; waiting for the user/);
  assert.match(notes.at(-1)!, /waits for the user's approval/);
  assert.equal(started.length, 3);

  const worker = { info: store.sessions.get('w1')! };
  events.emit('turnEnd', worker, '## Verified: 1a2b3c is fine\nDetails');
  events.emit('turnEnd', worker, 'another turn');
  const fin = notes.filter((x) => x.includes('finished:'));
  assert.equal(fin.length, 1);
  assert.match(fin[0], /Worker w1 \(sandbox a\) for "Nightly sentry" finished: Verified: 1a2b3c is fine/);
});

test('manual approval can use an idle machine too', (t) => {
  const { st, machine, started, store } = setup(t);
  const a = st.create({ name: 'Manual one', charter: 'x', trigger: { kind: 'manual' }, tools: ['delegate'] });
  const d = st.requestDelegation(a.id, 'Do it', 'task');
  assert.equal(d.status, 'pending');
  assert.throws(() => st.approveDelegation(d.id), /no ready sandbox or machine/);
  machine('m5');
  st.approveDelegation(d.id, { model: 'sonnet', effort: 'max' });
  assert.equal(store.delegations.get(d.id)!.machineId, 'm5');
  assert.deepEqual([started[0].model, started[0].effort], ['sonnet', 'max']);
});
