import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { BackendStatus } from '../shared/types.ts';
import { describeBackend, parseSwitchArgs, readKey, runSwitch } from './backendSwitch.ts';

const KEY = 'ffsb_' + 'k'.repeat(43);
const status = (over: Partial<BackendStatus> = {}): BackendStatus => ({
  mode: 'auto', active: 'plan', reason: 'plan usage 40% is under the 94% threshold', configured: true, profile: 'p', region: 'us-west-2', regionPrefix: 'us', thresholdPercent: 94, resumePercent: 84,
  spend: { day: '2026-10-12', todayUsd: 1.5, weekUsd: 9, dailyBudgetUsd: 200 }, ...over,
});
const reply = (code: number, body: unknown) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: code });

test('the command line: one command, optional url and key file', () => {
  assert.deepEqual(parseSwitchArgs(['plan'], {}), { command: 'plan' });
  assert.deepEqual(parseSwitchArgs(['--url', 'http://h:1/', 'bedrock', '--key-file', '/k'], {}), { command: 'bedrock', url: 'http://h:1', keyFile: '/k' });
  assert.deepEqual(parseSwitchArgs(['auto'], { FF_URL: 'http://e:2' }), { command: 'auto', url: 'http://e:2' });
  assert.ok('error' in parseSwitchArgs([], {}));
  assert.ok('error' in parseSwitchArgs(['fast'], {}));
  assert.ok('error' in parseSwitchArgs(['plan', 'auto'], {}));
  assert.ok('error' in parseSwitchArgs(['plan', '--url'], {}));
});

test('the key comes from the environment first, then the key file, and is trimmed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-'));
  const file = path.join(dir, 'key');
  fs.writeFileSync(file, `${KEY}\n`);
  assert.equal(readKey({ keyFile: file }, {}), KEY);
  assert.equal(readKey({ keyFile: file }, { FF_BACKEND_KEY: 'ffsb_env' }), 'ffsb_env');
  assert.equal(readKey({ keyFile: path.join(dir, 'none') }, {}), undefined);
  fs.rmSync(dir, { recursive: true });
});

test('a mode change posts the mode with the bearer key and reports where agents run', async () => {
  const seen: { url: string; method?: string; auth?: string; body?: string }[] = [];
  const lines = await runSwitch({ command: 'bedrock', url: 'http://h:1' }, KEY, {
    fetch: async (url, init) => {
      seen.push({ url: String(url), method: init?.method, auth: (init?.headers as Record<string, string>).authorization, body: init?.body as string });
      return reply(200, status({ mode: 'bedrock', active: 'bedrock', reason: 'set to Bedrock' }));
    },
  });
  assert.deepEqual(seen, [{ url: 'http://h:1/api/backend/mode', method: 'POST', auth: `Bearer ${KEY}`, body: '{"mode":"bedrock"}' }]);
  assert.match(lines.join('\n'), /Mode is now bedrock/);
  assert.match(lines.join('\n'), /run on BEDROCK/);
});

test('status reads GET /api/backend', async () => {
  const lines = await runSwitch({ command: 'status', url: 'http://h:1' }, KEY, { fetch: async () => reply(200, { backend: status({ active: 'blocked', reason: 'cap spent', problem: 'SSO expired' }) }) });
  assert.match(lines[0], /WAITING/);
  assert.match(lines.join('\n'), /Bedrock cannot be used: SSO expired/);
});

test('a refused key is explained and the key itself is never printed', async () => {
  await assert.rejects(runSwitch({ command: 'plan', url: 'http://h:1' }, KEY, { fetch: async () => reply(403, { error: 'a backend-scoped key is required' }) }), (e: Error) => /refused the key \(403\)/.test(e.message) && !e.message.includes(KEY));
  await assert.rejects(runSwitch({ command: 'plan', url: 'http://h:1' }, undefined, { fetch: async () => reply(200, {}) }), /no key/);
});

test('with the server down a mode is written to config.json, and status says the server is down', async () => {
  const down = async () => {
    throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
  };
  const set: string[] = [];
  const lines = await runSwitch({ command: 'plan', url: 'http://h:1' }, KEY, { fetch: down as typeof fetch, offlineSet: (m) => set.push(m) });
  assert.deepEqual(set, ['plan']);
  assert.match(lines.join('\n'), /does not answer.*config\.json only/s);
  await assert.rejects(runSwitch({ command: 'status', url: 'http://h:1' }, KEY, { fetch: down as typeof fetch, offlineSet: (m) => set.push(m) }), /does not answer/);
  assert.deepEqual(set, ['plan']);
});

test('describeBackend names the backend, the spend and a missing setup', () => {
  assert.match(describeBackend(status({ configured: false })), /not set up/);
  assert.match(describeBackend(status()), /your Claude PLAN \(mode auto\).*\$1\.50 of \$200/s);
});
