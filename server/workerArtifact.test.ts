import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildOptions, connectorAllowlist } from './launch.ts';
import { Store } from './store.ts';
import { SessionManager } from './sessions.ts';
import { SandboxManager } from './sandboxes.ts';
import { MachineManager } from './machines.ts';
import { Agents } from './agents.ts';
import { Identity } from './identity.ts';
import { CLAUDE_DOCS_CONNECTOR, type Config } from './config.ts';
import type { Sandbox, SessionInfo } from '../shared/types.ts';

/**
 * Workers get Claude Code's Artifact tools and the configured claude.ai connectors (docs/accounts.md, "Artifacts and
 * claude.ai connectors"): the env that lifts the SDK's default-off gate, and an MCP allowlist in place of strict MCP config.
 */

function harness(t: { after: (fn: () => Promise<void> | void) => void }, over: Partial<Config> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-artifact-'));
  const cfg = {
    dataDir: dir,
    sandboxRoot: dir,
    standingRoot: path.join(dir, '_agents'),
    repo: { url: path.join(dir, 'base'), basePath: path.join(dir, 'base') },
    defaultBase: 'origin/develop',
    models: ['opus'],
    defaultModel: 'opus',
    protectedPaths: [],
    limits: { maxSessions: 30, maxUnity: 2, maxSandboxes: 4, minFreeGB: 0, minFreeRamGB: 0 },
    orchestrator: { model: 'opus', effort: 'low', notifyOnWorkerEvents: false },
    worker: { permissionMode: 'bypassPermissions', effort: 'low', claudeAiConnectors: [CLAUDE_DOCS_CONNECTOR] },
    unity: {},
    ...over,
  } as unknown as Config;
  const store = new Store(dir);
  const sessions = new SessionManager(cfg, store);
  const machines = new MachineManager(cfg, store, sessions);
  const agents = new Agents(cfg, store, new SandboxManager(cfg, store), sessions, machines, new Identity(cfg, () => []));
  const sb = { id: 'sb1', name: 'sb1', branch: 'sandbox/sb1', base: 'origin/develop', path: path.join(dir, 'sb1'), createdAt: '2026-10-05T00:00:00Z', status: 'ready', purpose: 'unused', sessionIds: [], unity: { state: 'stopped' } } as unknown as Sandbox;
  store.sandboxes.set(sb.id, sb);
  t.after(async () => {
    agents.orchestrators.close();
    sessions.stopAll();
    await new Promise((r) => setTimeout(r, 60));
    store.flush();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  const info = (over: Partial<SessionInfo> = {}) => ({ id: 's1', kind: 'worker', title: 't', status: 'idle', permissionMode: 'bypassPermissions', createdAt: '', lastActivityAt: '', turns: 0, costUsd: 0, pendingPermissions: [], sandboxId: 'sb1', ...over }) as SessionInfo;
  return { cfg, agents, machines, info };
}

test('connectorAllowlist: own servers by name, connectors by URL', () => {
  assert.deepEqual(connectorAllowlist(['sandbox', 'UnityMCP'], [CLAUDE_DOCS_CONNECTOR]), [{ serverName: 'sandbox' }, { serverName: 'UnityMCP' }, { serverUrl: CLAUDE_DOCS_CONNECTOR }]);
});

test('workerOptions: Artifact on, Claude Docs through an allowlist, the host user\'s own MCP servers still out', (t) => {
  const { agents, info } = harness(t);
  const o = agents.workerOptions(info());
  assert.equal(o.env?.CLAUDE_CODE_ARTIFACT, '1');
  assert.equal(o.strictMcpConfig, false, 'strict MCP config would drop the claude.ai connectors too');
  assert.deepEqual(Object.keys(o.mcpServers ?? {}), ['sandbox']);
  assert.deepEqual((o.settings as { allowedMcpServers: unknown }).allowedMcpServers, [{ serverName: 'sandbox' }, { serverUrl: CLAUDE_DOCS_CONNECTOR }]);
  assert.deepEqual(o.disallowedTools, ['mcp__ffsb']);
});

test('workerOptions: no connectors keeps strict MCP config, and claudeEnv can turn Artifact off', (t) => {
  const { agents, info } = harness(t, { worker: { permissionMode: 'bypassPermissions', effort: 'low', claudeAiConnectors: [] }, claudeEnv: { CLAUDE_CODE_ARTIFACT: '0' } } as Partial<Config>);
  const o = agents.workerOptions(info());
  assert.equal(o.strictMcpConfig, true);
  assert.equal(o.settings, undefined);
  assert.equal(o.disallowedTools, undefined);
  assert.equal(o.env?.CLAUDE_CODE_ARTIFACT, '0');
});

test('machine agents: the launch spec carries the Artifact env through to the SDK options', (t) => {
  const { machines, info } = harness(t);
  const sb = { id: 'msb', branch: 'sandbox/msb', base: 'origin/develop', path: 'D:\\work\\ffsb\\msb', createdAt: '', status: 'ready', purpose: 'unused', sessionIds: [], unity: { state: 'stopped' } };
  const { machine } = machines.register({ id: 'pc', host: 'pc', purpose: 'unused', status: 'ready', repoPath: 'D:\\work\\FFFRepo', home: 'C:\\Users\\u', portalUrl: 'http://x', maxSessions: 2, platform: 'win32', sandboxes: [sb] } as never);
  for (const spec of [machines.hooks!.specFor(info({ sandboxId: undefined, machineId: 'pc' }), machine), machines.hooks!.specFor(info({ sandboxId: undefined, machineId: 'pc', machineSandbox: 'msb' }), machine)]) {
    assert.equal(spec.env?.CLAUDE_CODE_ARTIFACT, '1');
    assert.equal(buildOptions(spec, {}, {}).env?.CLAUDE_CODE_ARTIFACT, '1');
  }
});
