import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from './store.ts';
import { SessionManager } from './sessions.ts';
import { SandboxManager } from './sandboxes.ts';
import { MachineManager } from './machines.ts';
import { Agents } from './agents.ts';
import { Identity } from './identity.ts';
import { StandingAgents, type SessionPort } from './standing.ts';
import { BedrockBackend } from './bedrockBackend.ts';
import { HOST_LOGIN, tokenKey, type UsageEntry } from './usage.ts';
import type { Config } from './config.ts';
import type { Requester, Sandbox, SessionInfo } from '../shared/types.ts';

/** The Bedrock backend wired into the option factories of this host's agents (w38): orchestrator, worker, standing agent. */

const HOST_TOKEN = 'sk-ant-oat01-hosttoken' + 'H'.repeat(40);
const LOTH_TOKEN = 'sk-ant-oat01-lothsahn' + 'L'.repeat(40);
const SERVER_TOKEN = 'sk-ant-oat01-servertok' + 'S'.repeat(40);
const AWS_SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
const LOTH: Requester = { userId: 'lothsahn', displayName: 'Lothsahn' };
const BEN: Requester = { userId: 'ben', displayName: 'Ben' };
const tick = () => new Promise<void>((r) => setImmediate(r));

/** The server's own environment, with the credentials a Bedrock process must not inherit. */
function pollute(t: { after: (fn: () => void) => void }) {
  const names = ['CLAUDE_CODE_OAUTH_TOKEN', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'AWS_PROFILE', 'AWS_REGION', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL'];
  const saved = Object.fromEntries(names.map((n) => [n, process.env[n]]));
  for (const n of names) delete process.env[n];
  Object.assign(process.env, { CLAUDE_CODE_OAUTH_TOKEN: SERVER_TOKEN, AWS_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE', AWS_SECRET_ACCESS_KEY: AWS_SECRET, AWS_SESSION_TOKEN: 'FwoGZXIvYXdzEXAMPLE' });
  t.after(() => {
    for (const n of names) {
      if (saved[n] === undefined) delete process.env[n];
      else process.env[n] = saved[n];
    }
  });
}

function rig(t: { after: (fn: () => Promise<void> | void) => void }, over: Partial<Config> = {}) {
  pollute(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-bedrock-wiring-'));
  const cfg = {
    dataDir: dir,
    sandboxRoot: dir,
    standingRoot: path.join(dir, '_agents'),
    repo: { url: path.join(dir, 'base'), basePath: path.join(dir, 'base') },
    defaultBase: 'origin/develop',
    models: ['opus', 'sonnet', 'haiku'],
    defaultModel: 'sonnet',
    protectedPaths: [],
    limits: { maxSessions: 30, maxUnity: 2, maxSandboxes: 4, minFreeGB: 0, minFreeRamGB: 0 },
    orchestrator: { model: 'opus', effort: 'low', notifyOnWorkerEvents: false },
    worker: { permissionMode: 'bypassPermissions', effort: 'low' },
    unity: {},
    claudeEnv: { CLAUDE_CODE_OAUTH_TOKEN: HOST_TOKEN },
    userClaudeEnv: { lothsahn: { CLAUDE_CODE_OAUTH_TOKEN: LOTH_TOKEN } },
    bedrock: { profile: 'sketchup-bedrock' },
    ...over,
  } as unknown as Config;
  const store = new Store(dir);
  const sessions = new SessionManager(cfg, store);
  const machines = new MachineManager(cfg, store, sessions);
  const agents = new Agents(cfg, store, new SandboxManager(cfg, store), sessions, machines, new Identity(cfg, () => []));
  const sb = { id: 'sb1', name: 'sb1', branch: 'sandbox/sb1', base: 'origin/develop', path: path.join(dir, 'sb1'), createdAt: '2026-10-05T00:00:00Z', status: 'ready', purpose: 'unused', sessionIds: [], unity: { state: 'stopped' } } as unknown as Sandbox;
  store.sandboxes.set(sb.id, sb);
  const entries = new Map<string, UsageEntry>();
  const ctl = new BedrockBackend({ cfg: cfg as never, usage: () => entries, notify: () => undefined, probe: async () => ({ ok: true }), log: () => undefined });
  agents.backend = ctl;
  const port = new (class implements SessionPort {
    readonly events = new EventEmitter();
    create(opts: Parameters<SessionPort['create']>[0]) {
      return { info: { id: 's1', kind: opts.kind, standingId: opts.standingId } as SessionInfo, live: false, stop: () => undefined };
    }
    get() {
      return { info: {} as SessionInfo, live: false, stop: () => undefined };
    }
    send() {
      return 'u';
    }
    liveAgents() {
      return 0;
    }
    remove() {}
  })();
  const standing = new StandingAgents({ cfg, store, sessions: port, systemPayer: () => BEN, notify: () => undefined, sandboxes: { list: () => [], setPurpose: () => ({}) as never }, startWorker: () => ({ info: {} as SessionInfo }), now: () => new Date('2026-09-28T10:00:00') });
  standing.backend = ctl;
  t.after(async () => {
    ctl.stop();
    agents.orchestrators.close();
    sessions.stopAll();
    await new Promise((r) => setTimeout(r, 60));
    store.flush();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  const info = (o: Partial<SessionInfo> = {}) => ({ id: 's1', kind: 'worker', title: 't', status: 'idle', permissionMode: 'bypassPermissions', createdAt: '', lastActivityAt: '', turns: 0, costUsd: 0, pendingPermissions: [], sandboxId: 'sb1', ...o }) as SessionInfo;
  const plan = (percent: number) => entries.set(tokenKey(HOST_TOKEN), { kind: 'token', usage: { available: true, asOf: new Date().toISOString(), session: { label: 'Session', percent, resetsAt: new Date(Date.now() + 3_600_000).toISOString() }, models: [] } });
  const agent = standing.create({ name: 'Triager', charter: 'Triage.', trigger: { kind: 'interval', minutes: 30 }, tools: ['delegate'] });
  return { cfg, agents, standing, agent, ctl, info, plan, entries };
}

const PINS = { ANTHROPIC_DEFAULT_OPUS_MODEL: 'us.anthropic.claude-opus-5-5', ANTHROPIC_DEFAULT_SONNET_MODEL: 'us.anthropic.claude-sonnet-5-5', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'us.anthropic.claude-haiku-5-5' };
const bedrockOnly = (env: Record<string, string | undefined> | undefined, what: string) => {
  assert.equal(env?.CLAUDE_CODE_USE_BEDROCK, '1', `${what}: Bedrock`);
  assert.equal(env?.AWS_PROFILE, 'sketchup-bedrock');
  assert.equal(env?.AWS_REGION, 'us-west-2');
  for (const [k, v] of Object.entries(PINS)) assert.equal(env?.[k], v, `${what}: ${k}`);
  for (const k of ['CLAUDE_CODE_OAUTH_TOKEN', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'ANTHROPIC_API_KEY']) assert.equal(env?.[k], undefined, `${what}: no ${k}, though the server has one`);
  assert.doesNotMatch(JSON.stringify(env), /sk-ant-oat01|AKIA|wJalr|FwoGZ/, `${what}: no secret`);
};

test('on the plan: workers, orchestrators and standing agents are as before (token, w33 pins), nothing of Bedrock', async (t) => {
  const { agents, standing, agent, plan, info } = rig(t);
  plan(40);
  const w = agents.workerOptions(info()).env!;
  assert.equal(w.CLAUDE_CODE_OAUTH_TOKEN, HOST_TOKEN);
  assert.equal(w.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'claude-haiku-5-5', "w33's pin");
  assert.equal(w.CLAUDE_CODE_USE_BEDROCK, undefined);
  assert.equal(agents.orchestratorOptions(info({ kind: 'orchestrator', sandboxId: undefined })).env?.CLAUDE_CODE_USE_BEDROCK, undefined);
  assert.equal(standing.options({ id: 'x', kind: 'standing', standingId: agent.id } as SessionInfo).env?.CLAUDE_CODE_USE_BEDROCK, undefined);
});

test('on Bedrock: each role gets the profile, the region and the three ids, and none of the server\'s credentials', async (t) => {
  const { agents, standing, agent, ctl, plan, info } = rig(t);
  plan(95);
  agents.workerOptions(info());
  await tick();
  bedrockOnly(agents.workerOptions(info()).env, 'worker');
  bedrockOnly(agents.orchestratorOptions(info({ kind: 'orchestrator', sandboxId: undefined })).env, 'orchestrator');
  bedrockOnly(standing.options({ id: 'x', kind: 'standing', standingId: agent.id } as SessionInfo).env, 'standing agent');
  // w33's roles are unchanged: the aliases stay, the pins now point at the Bedrock ids.
  const w = agents.workerOptions(info({ model: 'sonnet' }));
  assert.deepEqual(Object.fromEntries(Object.entries(w.agents ?? {}).map(([k, v]) => [k, v.model])), { planner: 'opus', reviewer: 'opus', scout: 'haiku' });
  assert.equal(w.env?.MCP_TIMEOUT, '120000');
  assert.equal(w.env?.FF_SANDBOX_ID, 'sb1', 'the rest of the worker env stays');
  assert.equal(ctl.status().active, 'bedrock');
});

test("a person's own token keeps the plan on every role, even with Bedrock wanted", async (t) => {
  const { agents, plan, info } = rig(t);
  plan(99);
  agents.workerOptions(info());
  await tick();
  assert.equal(agents.workerOptions(info()).env?.CLAUDE_CODE_USE_BEDROCK, '1', 'the others are on Bedrock');
  const own = agents.workerOptions(info({ requestedBy: LOTH })).env!;
  assert.equal(own.CLAUDE_CODE_OAUTH_TOKEN, LOTH_TOKEN);
  assert.equal(own.CLAUDE_CODE_USE_BEDROCK, undefined);
  assert.equal(own.AWS_PROFILE, undefined);
  // A person without one is on Bedrock.
  assert.equal(agents.workerOptions(info({ requestedBy: BEN })).env?.CLAUDE_CODE_USE_BEDROCK, '1');
});

test('the orchestrator on the login and the workers on the token decide on their own meters', async (t) => {
  const { agents, plan, info, entries } = rig(t, { claudeAccounts: { orchestrator: 'login' } });
  plan(96);
  entries.set(HOST_LOGIN, { kind: 'login', usage: { available: true, asOf: new Date().toISOString(), session: { label: 'Session', percent: 30, resetsAt: new Date(Date.now() + 3_600_000).toISOString() }, models: [] } });
  agents.workerOptions(info());
  await tick();
  assert.equal(agents.workerOptions(info()).env?.CLAUDE_CODE_USE_BEDROCK, '1');
  assert.equal(agents.orchestratorOptions(info({ kind: 'orchestrator', sandboxId: undefined })).env?.CLAUDE_CODE_USE_BEDROCK, undefined);
});

test('a machine agent never gets Bedrock: the Mac keeps its own login or token', async (t) => {
  const { standing, plan } = rig(t);
  plan(99);
  const place = (standing as unknown as { place(a: unknown): { env: Record<string, string> } }).place({ id: 'm', machineId: 'mac1', name: 'x' });
  assert.equal(place.env.CLAUDE_CODE_USE_BEDROCK, undefined);
});

test('a server started from a Bedrock shell: plan processes (mode plan, a person with a token) carry none of it, and the haiku pin holds', async (t) => {
  const { agents, standing, agent, plan, info } = rig(t, { bedrock: { profile: 'sketchup-bedrock', mode: 'plan' } });
  Object.assign(process.env, { CLAUDE_CODE_USE_BEDROCK: '1', AWS_PROFILE: 'shell-profile', AWS_REGION: 'eu-west-1', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'shell.haiku', ANTHROPIC_DEFAULT_SONNET_MODEL: 'shell.sonnet', ANTHROPIC_DEFAULT_OPUS_MODEL: 'shell.opus' });
  plan(99);
  const clean = (env: Record<string, string | undefined> | undefined, what: string) => {
    for (const k of ['CLAUDE_CODE_USE_BEDROCK', 'AWS_PROFILE', 'AWS_REGION', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL']) assert.equal(env?.[k], undefined, `${what}: ${k}`);
    assert.equal(env?.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'claude-haiku-5-5', `${what}: the pin, not the shell's id`);
  };
  clean(agents.workerOptions(info()).env, 'worker');
  clean(agents.orchestratorOptions(info({ kind: 'orchestrator', sandboxId: undefined })).env, 'orchestrator');
  clean(standing.options({ id: 'x', kind: 'standing', standingId: agent.id } as SessionInfo).env, 'standing agent (the env buildOptions makes)');
  clean(agents.workerOptions(info({ requestedBy: LOTH })).env, 'a person with their own token');
});

test('a fable worker stays on the plan even when Bedrock is wanted', async (t) => {
  const { agents, plan, info } = rig(t);
  plan(99);
  agents.workerOptions(info());
  await tick();
  assert.equal(agents.workerOptions(info({ model: 'sonnet' })).env?.CLAUDE_CODE_USE_BEDROCK, '1');
  const fable = agents.workerOptions(info({ model: 'fable' })).env!;
  assert.equal(fable.CLAUDE_CODE_USE_BEDROCK, undefined);
  assert.equal(fable.CLAUDE_CODE_OAUTH_TOKEN, HOST_TOKEN);
  assert.equal(agents.orchestratorOptions(info({ kind: 'orchestrator', sandboxId: undefined, model: 'fable' })).env?.CLAUDE_CODE_USE_BEDROCK, undefined);
});
