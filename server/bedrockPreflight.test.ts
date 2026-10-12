import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bedrockSettings } from './bedrock.ts';
import { checkFoundationModels, checkInferenceProfiles, modelFix, parseCallerIdentity, parseClaudeCall, parseCostTotal, parseProfiles } from './bedrockPreflight.ts';
import { parseArgs } from '../scripts/bedrock-preflight.ts';

/** What scripts/bedrock-preflight.ts makes of the AWS CLI's and Claude Code's answers (w38): parsing, no AWS. */

const us = bedrockSettings({ bedrock: {} });

test('parseCallerIdentity: the account id and the role name, never the user id or the session name', () => {
  const json = JSON.stringify({ UserId: 'AROAEXAMPLEID:ben@example.com', Account: '123456789012', Arn: 'arn:aws:sts::123456789012:assumed-role/AWSReservedSSO_BedrockUser_abc123/ben@example.com' });
  const id = parseCallerIdentity(json);
  assert.deepEqual(id, { account: '123456789012', role: 'AWSReservedSSO_BedrockUser_abc123' });
  assert.doesNotMatch(JSON.stringify(id), /AROAEXAMPLEID|ben@/);
  assert.deepEqual(parseCallerIdentity(JSON.stringify({ Account: '123456789012', Arn: 'arn:aws:iam::123456789012:user/ben' })), { account: '123456789012', role: '(not a role)' });
  assert.equal(parseCallerIdentity('not json'), undefined);
  assert.equal(parseCallerIdentity(JSON.stringify({ Account: 'nope' })), undefined);
});

test('parseProfiles: names only, one per line', () => {
  assert.deepEqual(parseProfiles('default\r\nsketchup-bedrock\n\n  other \n'), ['default', 'sketchup-bedrock', 'other']);
});

test('checkInferenceProfiles: the three ids must be listed and ACTIVE', () => {
  const list = (items: { inferenceProfileId: string; status: string }[]) => JSON.stringify({ inferenceProfileSummaries: items });
  const all = checkInferenceProfiles(list([{ inferenceProfileId: 'us.anthropic.claude-opus-5-5', status: 'ACTIVE' }, { inferenceProfileId: 'us.anthropic.claude-sonnet-5-5', status: 'ACTIVE' }, { inferenceProfileId: 'us.anthropic.claude-haiku-5-5', status: 'ACTIVE' }, { inferenceProfileId: 'us.anthropic.claude-3-haiku', status: 'ACTIVE' }]), us);
  assert.deepEqual(all.map((c) => [c.alias, c.status]), [['opus', 'active'], ['sonnet', 'active'], ['haiku', 'active']]);
  const some = checkInferenceProfiles(list([{ inferenceProfileId: 'us.anthropic.claude-opus-5-5', status: 'ACTIVE' }, { inferenceProfileId: 'us.anthropic.claude-sonnet-5-5', status: 'INACTIVE' }]), us);
  assert.deepEqual(some.map((c) => c.status), ['active', 'inactive', 'missing']);
  assert.match(modelFix(some[2], 'us-west-2'), /us\.anthropic\.claude-haiku-5-5 is not listed in us-west-2.*Model access/);
  assert.match(modelFix(some[1], 'us-west-2'), /not ACTIVE/);
  assert.deepEqual(checkInferenceProfiles('garbage', us).map((c) => c.status), ['missing', 'missing', 'missing']);
  // The prefix decides the ids that are looked for.
  assert.equal(checkInferenceProfiles(list([{ inferenceProfileId: 'global.anthropic.claude-opus-5-5', status: 'ACTIVE' }]), { regionPrefix: 'global' })[0].status, 'active');
});

test('checkFoundationModels: a bare id matches its versioned listing', () => {
  const json = JSON.stringify({ modelSummaries: [{ modelId: 'anthropic.claude-opus-5-5-v1:0', modelLifecycle: { status: 'ACTIVE' } }, { modelId: 'anthropic.claude-sonnet-5-5-v1:0', modelLifecycle: { status: 'LEGACY' } }] });
  assert.deepEqual(checkFoundationModels(json, { regionPrefix: '' }).map((c) => c.status), ['active', 'inactive', 'missing']);
});

test('parseClaudeCall: the model used, its provider and the cost; an error result is one', () => {
  const ok = parseClaudeCall(JSON.stringify({ type: 'result', is_error: false, result: 'pong', total_cost_usd: 0.00361, modelUsage: { 'us.anthropic.claude-haiku-5-5': { provider: 'bedrock', inputTokens: 992 } } }));
  assert.deepEqual(ok, { model: 'us.anthropic.claude-haiku-5-5', provider: 'bedrock', costUsd: 0.00361, text: 'pong', isError: false });
  assert.equal(parseClaudeCall(JSON.stringify({ is_error: true, result: 'boom' })).isError, true);
  assert.equal(parseClaudeCall('not json').isError, true);
  assert.equal(parseClaudeCall(JSON.stringify({ result: 'pong', modelUsage: { 'claude-haiku-5-5': { provider: 'firstParty' } } })).provider, 'firstParty', 'a call that did not go through Bedrock shows');
});

test('parseCostTotal: the sum of the days, or nothing when it cannot be read', () => {
  const day = (amount: string) => ({ Total: { UnblendedCost: { Amount: amount } } });
  assert.equal(parseCostTotal(JSON.stringify({ ResultsByTime: [day('12.5'), day('0.25')] })), 12.75);
  assert.equal(parseCostTotal(JSON.stringify({ ResultsByTime: [] })), undefined);
  assert.equal(parseCostTotal(JSON.stringify({ ResultsByTime: [day('x')] })), undefined);
  assert.equal(parseCostTotal('nope'), undefined);
});

test('the script takes --profile, --region and --call, and nothing else', () => {
  assert.deepEqual(parseArgs([]), { call: false });
  assert.deepEqual(parseArgs(['--profile', 'p', '--region', 'eu-west-1', '--call']), { profile: 'p', region: 'eu-west-1', call: true });
  assert.throws(() => parseArgs(['--profile']), /needs a value/);
  assert.throws(() => parseArgs(['--profile', '--call']), /needs a value/);
  assert.throws(() => parseArgs(['--key', 'x']), /unknown argument --key/);
});

test('the script end to end against stub aws and claude programs: prints the account id and role only, flags what is missing', { skip: process.platform === 'win32' }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-preflight-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const stub = (name: string, body: string) => fs.writeFileSync(path.join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  stub(
    'aws',
    [
      'case "$*" in',
      `  "configure list-profiles") printf 'default\\nsketchup-bedrock\\n';;`,
      `  sts*) printf '{"UserId":"AROASECRETUSERID:ben","Account":"123456789012","Arn":"arn:aws:sts::123456789012:assumed-role/BedrockUser/ben"}';;`,
      `  *list-inference-profiles*) printf '{"inferenceProfileSummaries":[{"inferenceProfileId":"us.anthropic.claude-opus-5-5","status":"ACTIVE"},{"inferenceProfileId":"us.anthropic.claude-sonnet-5-5","status":"ACTIVE"}]}';;`,
      '  ce*) echo "An error occurred (AccessDeniedException) secretdetail" >&2; exit 254;;',
      'esac',
    ].join('\n'),
  );
  stub('claude', `printf '{"is_error":false,"result":"pong","total_cost_usd":0.0004,"modelUsage":{"us.anthropic.claude-haiku-5-5":{"provider":"bedrock"}}}'`);
  const env: Record<string, string | undefined> = { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}`, AWS_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' };
  delete env.CLAUDE_CODE_USE_BEDROCK;
  delete env.AWS_PROFILE;
  const script = path.join(import.meta.dirname, '..', 'scripts', 'bedrock-preflight.ts');
  const r = spawnSync(process.execPath, [script, '--profile', 'sketchup-bedrock', '--call'], { env: env as NodeJS.ProcessEnv, encoding: 'utf8' });
  const out = r.stdout + r.stderr;
  assert.equal(r.status, 1, out);
  assert.match(out, /account 123456789012, role BedrockUser/);
  assert.match(out, /opus: us\.anthropic\.claude-opus-5-5 is ACTIVE/);
  assert.match(out, /FAIL {2}haiku: us\.anthropic\.claude-haiku-5-5 is not listed\n {8}to fix: .*Model access/);
  assert.match(out, /model used: us\.anthropic\.claude-haiku-5-5\n.*provider: bedrock\n.*total_cost_usd: 0\.0004/);
  assert.match(out, /skipped: AWS denied access \(AccessDenied\)/);
  assert.doesNotMatch(out, /AROASECRETUSERID|wJalr|secretdetail/, 'no user id, key or CLI text');
  const unknown = spawnSync(process.execPath, [script, '--profile', 'nope'], { env: env as NodeJS.ProcessEnv, encoding: 'utf8' });
  assert.equal(unknown.status, 1);
  assert.match(unknown.stdout, /profile "nope" is not in ~\/\.aws\/config\n {8}to fix: `aws configure sso --profile nope`/);
});
