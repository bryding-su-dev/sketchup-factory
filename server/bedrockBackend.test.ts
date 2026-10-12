import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SessionInfo } from '../shared/types.ts';
import type { Config } from './config.ts';
import { localDay } from './bedrock.ts';
import { BedrockBackend, PROBE_FRESH_MS, PROBE_EVERY_MS, type BackendDeps, type Probe, type ProbeResult } from './bedrockBackend.ts';
import { classifyAwsFailure } from './bedrockPreflight.ts';
import { HOST_LOGIN, tokenKey, type UsageEntry } from './usage.ts';

/** The Bedrock controller (w38) with a fake clock, a fake AWS probe, fake plan meters and a fake owner's chat: no AWS, no network. */

const HOST_TOKEN = 'sk-ant-oat01-hosttoken' + 'H'.repeat(40);
const LOTH_TOKEN = 'sk-ant-oat01-lothsahn' + 'L'.repeat(40);
const SERVER_TOKEN = 'sk-ant-oat01-servertok' + 'S'.repeat(40);
const AWS_SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
const AWS_KEY = 'AKIAIOSFODNN7EXAMPLE';
/** Everything that must never come out of the controller. */
const SECRETS = [HOST_TOKEN, LOTH_TOKEN, SERVER_TOKEN, AWS_SECRET, AWS_KEY, 'FwoGZXIvYXdzEXAMPLESESSION'];
const SERVER_ENV = { PATH: '/usr/bin', CLAUDE_CODE_OAUTH_TOKEN: SERVER_TOKEN, AWS_ACCESS_KEY_ID: AWS_KEY, AWS_SECRET_ACCESS_KEY: AWS_SECRET, AWS_SESSION_TOKEN: 'FwoGZXIvYXdzEXAMPLESESSION' };

const T0 = new Date(2026, 9, 12, 14, 0, 0).getTime();
const HOUR = 3_600_000;
const tick = () => new Promise<void>((r) => setImmediate(r));

const meter = (percent: number, resetsAt = new Date(T0 + 3 * HOUR).toISOString()) => ({ label: 'Session', percent, resetsAt });
const entry = (kind: 'token' | 'login', session?: number, resetsAt?: number): UsageEntry => ({ kind, usage: session === undefined ? undefined : { available: true, asOf: new Date(T0).toISOString(), session: meter(session, resetsAt === undefined ? undefined : new Date(resetsAt).toISOString()), models: [] } });

interface Rig {
  ctl: BedrockBackend;
  cfg: Config & { dataDir: string };
  dir: string;
  clock: { t: number };
  entries: Map<string, UsageEntry>;
  notices: string[];
  probes: { profile: string; region: string }[];
  probeAnswer: { value: ProbeResult };
  events: { changed: number; switched: number };
  /** The plan's session usage on the host token and on the host login. */
  plan: (token?: number, login?: number, resetsAt?: number) => void;
  make: (over?: Partial<BackendDeps>) => BedrockBackend;
}

function rig(t: { after: (fn: () => void) => void }, cfgOver: Partial<Config> = {}): Rig {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-bedrock-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cfg = {
    dataDir: dir,
    claudeEnv: { CLAUDE_CODE_OAUTH_TOKEN: HOST_TOKEN },
    userClaudeEnv: { lothsahn: { CLAUDE_CODE_OAUTH_TOKEN: LOTH_TOKEN } },
    bedrock: { profile: 'sketchup-bedrock' },
    ...cfgOver,
  } as Config & { dataDir: string };
  const clock = { t: T0 };
  const entries = new Map<string, UsageEntry>();
  const notices: string[] = [];
  const probes: Rig['probes'] = [];
  const probeAnswer = { value: { ok: true } as ProbeResult };
  const events = { changed: 0, switched: 0 };
  const probe: Probe = async (profile, region) => {
    probes.push({ profile, region });
    return probeAnswer.value;
  };
  const make = (over: Partial<BackendDeps> = {}) =>
    new BedrockBackend({ cfg, usage: () => entries, notify: (x) => notices.push(x), changed: () => void events.changed++, switched: () => void events.switched++, probe, now: () => clock.t, env: SERVER_ENV, log: () => undefined, ...over });
  const ctl = make();
  t.after(() => ctl.stop());
  const plan = (token?: number, login?: number, resetsAt?: number) => {
    entries.set(tokenKey(HOST_TOKEN), entry('token', token, resetsAt));
    entries.set(HOST_LOGIN, entry('login', login, resetsAt));
  };
  return { ctl, cfg, dir, clock, entries, notices, probes, probeAnswer, events, plan, make };
}

const isBedrock = (env: Record<string, string | undefined>) => env.CLAUDE_CODE_USE_BEDROCK === '1';
const worker = (id = 's1', over: Partial<SessionInfo> = {}) => ({ info: { id, kind: 'worker', title: 'Fix the belts', ...over } as SessionInfo });

/** Put the rig on Bedrock: 95% on the host token, the AWS probe answered. */
async function onBedrock(r: Rig) {
  r.plan(95, 10);
  r.ctl.apply('workers', {});
  await tick();
  assert.ok(isBedrock(r.ctl.apply('workers', {})), 'on Bedrock');
  await tick();
  r.notices.length = 0;
}

test('a switch waits for an ok AWS probe: the plan carries the work until it answers, then Bedrock', async (t) => {
  const r = rig(t);
  r.plan(95);
  const first = r.ctl.apply('workers', { MCP_TIMEOUT: '1' });
  assert.equal(isBedrock(first), false, 'not before the AWS login is known to work');
  assert.deepEqual(r.probes, [{ profile: 'sketchup-bedrock', region: 'us-west-2' }], 'one probe, started by the first wish');
  r.ctl.apply('workers', {});
  assert.equal(r.probes.length, 1, 'not one per call');
  await tick();
  const env: Record<string, string | undefined> = r.ctl.apply('workers', { MCP_TIMEOUT: '1' });
  assert.equal(isBedrock(env), true);
  assert.equal(env.MCP_TIMEOUT, '1', 'the rest of the env stays');
  assert.equal(env.AWS_PROFILE, 'sketchup-bedrock');
  assert.equal(env.AWS_REGION, 'us-west-2');
  assert.deepEqual([env.ANTHROPIC_DEFAULT_OPUS_MODEL, env.ANTHROPIC_DEFAULT_SONNET_MODEL, env.ANTHROPIC_DEFAULT_HAIKU_MODEL], ['us.anthropic.claude-opus-5-5', 'us.anthropic.claude-sonnet-5-5', 'us.anthropic.claude-haiku-5-5']);
  assert.equal(r.events.switched >= 1, true, 'held messages are told to look again');
});

test('env per role: orchestrator, workers and standing agents each get the Bedrock env; a person with their own token keeps the plan', async (t) => {
  const r = rig(t);
  await onBedrock(r);
  const base = { PATH: '/usr/bin', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku-5-5', CLAUDE_CODE_OAUTH_TOKEN: HOST_TOKEN, AWS_SECRET_ACCESS_KEY: AWS_SECRET, AWS_ACCESS_KEY_ID: AWS_KEY };
  for (const role of ['orchestrator', 'workers', 'standing'] as const) {
    const env = r.ctl.apply(role, base);
    assert.equal(isBedrock(env), true, role);
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined, `${role}: no plan token`);
    assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined, `${role}: no AWS key even though the server env has one`);
    assert.equal(env.AWS_ACCESS_KEY_ID, undefined);
    assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'us.anthropic.claude-haiku-5-5', `${role}: the w33 pin is replaced by the Bedrock id`);
    assert.equal(env.PATH, '/usr/bin');
  }
  const own = { ...base, CLAUDE_CODE_OAUTH_TOKEN: LOTH_TOKEN };
  assert.deepEqual(r.ctl.apply('workers', own, { userId: 'lothsahn' }), own, 'their own token keeps the plan, whatever the decision');
  assert.deepEqual(r.ctl.apply('orchestrator', own, { userId: 'Lothsahn' }), own, 'ids compare without case');
  assert.equal(isBedrock(r.ctl.apply('workers', base, { userId: 'ben' })), true, 'a person without one is on Bedrock');
  assert.equal(isBedrock(r.ctl.apply('workers', base, undefined)), true);
  assert.equal(r.ctl.wantFor({ kind: 'worker', requestedBy: { userId: 'lothsahn', displayName: 'L' } } as SessionInfo), undefined, 'and is never recycled onto it');
  assert.equal(r.ctl.wantFor({ kind: 'worker', machineId: 'mac1' } as SessionInfo), undefined, 'a Mac daemon stays on its own login');
  assert.equal(r.ctl.wantFor({ kind: 'worker' } as SessionInfo)?.backend, 'bedrock');
});

test('Auto decides per account: the orchestrator on the login and the workers on the token are separate', async (t) => {
  const r = rig(t, { claudeAccounts: { orchestrator: 'login' } });
  r.plan(95, 20);
  r.ctl.apply('workers', {});
  await tick();
  assert.equal(isBedrock(r.ctl.apply('workers', {})), true, 'the token is at 95%');
  assert.equal(isBedrock(r.ctl.apply('orchestrator', {})), false, 'the login is at 20%');
  assert.equal(isBedrock(r.ctl.apply('standing', {})), true, 'standing agents share the token');
  assert.equal(r.ctl.accountKey('orchestrator'), HOST_LOGIN);
  assert.equal(r.ctl.accountKey('workers'), tokenKey(HOST_TOKEN));
  const lines = r.ctl.statusLines();
  assert.match(lines.join('\n'), /Backend for the orchestrator: your Claude plan/);
  await tick();
  assert.match(r.notices[0], /Agents \(workers, standing agents\) now run on SketchUp's Bedrock/, 'a notice names who moved when the accounts are split');
  r.plan(10, 99);
  assert.equal(isBedrock(r.ctl.apply('orchestrator', {})), true, 'the login at 99% moves the orchestrator (the AWS answer is fresh)');
  assert.equal(isBedrock(r.ctl.apply('workers', {})), false, 'while the workers, whose token is at 10%, are back on the plan');
});

test('no host token: the agents run on the host login, and its meters decide', async (t) => {
  const r = rig(t, { claudeEnv: {} });
  const noTokenEnv = { PATH: '/usr/bin' };
  const ctl = r.make({ env: noTokenEnv });
  r.entries.set(HOST_LOGIN, entry('login', 96));
  ctl.apply('workers', {});
  await tick();
  assert.equal(ctl.accountKey('workers'), HOST_LOGIN);
  assert.equal(isBedrock(ctl.apply('workers', {})), true);
});

test('notices: one line to the owner on every switch, in both directions, with the numbers', async (t) => {
  const r = rig(t);
  r.plan(50);
  r.ctl.apply('workers', {});
  await tick();
  assert.equal(r.notices.length, 0, 'starting on the plan is no news');
  r.plan(95);
  r.ctl.evaluate();
  await tick();
  r.ctl.evaluate();
  await tick();
  assert.equal(r.notices.length, 1);
  assert.equal(r.notices[0].startsWith("[backend] Agents now run on SketchUp's Bedrock (session usage 95% is at the 94% threshold). Back to your plan when usage is under 84% or the window resets."), true, r.notices[0]);
  r.plan(90);
  r.ctl.evaluate();
  await tick();
  assert.equal(r.notices.length, 1, '90% stays on Bedrock without a word');
  r.plan(80);
  r.ctl.evaluate();
  await tick();
  assert.equal(r.notices.length, 2);
  assert.match(r.notices[1], /^\[backend\] Back on your Claude plan \(plan usage is back to 80% \(resumes under 84%\)\)\./);
  // Wobbling around the threshold does not talk.
  for (const p of [93, 94, 93.9, 94.5]) {
    r.plan(p);
    r.ctl.evaluate();
    await tick();
  }
  assert.equal(r.notices.length, 3, 'one more: it crossed 94 once');
  assert.match(r.notices[2], /now run on SketchUp's Bedrock/);
  assert.equal(isBedrock(r.ctl.apply('workers', {})), true);
});

test('the window reset brings the agents back even though the last reading said 97%', async (t) => {
  const r = rig(t);
  const resets = T0 + 2 * HOUR;
  r.entries.set(tokenKey(HOST_TOKEN), { kind: 'token', usage: { available: true, asOf: new Date(T0).toISOString(), session: meter(97, new Date(resets).toISOString()), models: [] } });
  r.ctl.apply('workers', {});
  await tick();
  assert.equal(isBedrock(r.ctl.apply('workers', {})), true);
  r.clock.t = resets + 1000; // nobody polled since; the window is over
  assert.equal(isBedrock(r.ctl.apply('workers', {})), false);
  await tick();
  assert.match(r.notices.at(-1)!, /Back on your Claude plan/);
});

test('the state survives a restart: on Bedrock at 90%, back under 84%; the cumulative usage too', async (t) => {
  const r = rig(t);
  await onBedrock(r);
  const again = r.make();
  r.plan(90);
  assert.equal(isBedrock(again.apply('workers', {})), true, 'a new instance remembers it is on Bedrock, and stays at 90% without waiting for a probe');
  await tick();
  assert.equal(again.awsHealth().ok, true, 'it probes now, as it is wanted');
  assert.equal(JSON.parse(fs.readFileSync(path.join(r.dir, 'bedrock-state.json'), 'utf8')).active[tokenKey(HOST_TOKEN)].backend, 'bedrock');
  r.plan(83);
  assert.equal(isBedrock(again.apply('workers', {})), false);
});

test('a forced mode applies to the next call, whatever the usage; Auto again follows it', async (t) => {
  const r = rig(t);
  r.plan(10);
  r.cfg.bedrock = { ...r.cfg.bedrock, mode: 'bedrock' };
  r.ctl.evaluate();
  await tick();
  assert.equal(isBedrock(r.ctl.apply('workers', {})), true);
  assert.match(r.notices.join('\n'), /now run on SketchUp's Bedrock \(set to Bedrock\)\./);
  assert.doesNotMatch(r.notices.join('\n'), /Back to your plan when usage/, 'a forced mode has no resume line');
  r.cfg.bedrock = { ...r.cfg.bedrock, mode: 'plan' };
  r.plan(99);
  assert.equal(isBedrock(r.ctl.apply('workers', {})), false);
  await tick();
  assert.match(r.notices.at(-1)!, /Back on your Claude plan \(set to your Claude plan\)/);
  r.cfg.bedrock = { ...r.cfg.bedrock, mode: 'auto' };
  assert.equal(isBedrock(r.ctl.apply('workers', {})), true, 'auto at 99% is Bedrock');
  assert.equal(r.ctl.status().mode, 'auto');
});

test('no profile: the plan carries the work, with one notice that says how to set it up', async (t) => {
  const r = rig(t, { bedrock: {} });
  r.plan(99);
  for (let i = 0; i < 3; i++) {
    assert.equal(isBedrock(r.ctl.apply('workers', {})), false);
    r.ctl.evaluate();
    await tick();
  }
  assert.equal(r.notices.length, 1, 'once');
  assert.match(r.notices[0], /Bedrock is wanted but cannot be used: no AWS profile is set.*bedrock\.profile/);
  assert.equal(r.probes.length, 0, 'nothing to probe');
  assert.equal(r.ctl.status().configured, false);
  assert.match(r.ctl.statusLines()[0], /Backend: your Claude plan .*Bedrock is not set up \(config bedrock\.profile\)/);
  assert.match(r.ctl.statusLines().join('\n'), /WARNING: Bedrock cannot be used: no AWS profile is set/);
});

test('an expired AWS SSO session: the plan carries the work, the owner is told once with the fix, and once when it works again', async (t) => {
  const r = rig(t);
  await onBedrock(r);
  r.probeAnswer.value = { ok: false, problem: 'the AWS SSO session has expired' };
  r.clock.t += PROBE_EVERY_MS + 1000;
  r.ctl.evaluate(); // the 5-minute probe while Bedrock is wanted
  await tick();
  await tick();
  assert.equal(r.probes.length, 2);
  assert.equal(isBedrock(r.ctl.apply('workers', {})), false, 'the plan carries the work');
  assert.match(r.ctl.status().reason, /Bedrock is not usable \(the AWS SSO session has expired\), so the plan carries the work/);
  assert.equal(r.ctl.status().problem, 'the AWS SSO session has expired');
  await tick();
  const told = r.notices.filter((n) => /cannot be used/.test(n));
  assert.equal(told.length, 1);
  assert.match(told[0], /the AWS SSO session has expired.*run `aws sso login --profile sketchup-bedrock`/);
  assert.match(r.notices.join('\n'), /Back on your Claude plan/, 'and the switch itself');
  // The same problem again: not told again.
  r.clock.t += PROBE_EVERY_MS + 1000;
  r.ctl.evaluate();
  await tick();
  await tick();
  assert.equal(r.notices.filter((n) => /cannot be used/.test(n)).length, 1);
  assert.match(r.ctl.statusLines().join('\n'), /WARNING: Bedrock cannot be used: the AWS SSO session has expired; the plan carries the work\. To fix it: run `aws sso login --profile sketchup-bedrock`\./);
  // Logged in again.
  r.probeAnswer.value = { ok: true };
  r.clock.t += PROBE_EVERY_MS + 1000;
  r.ctl.evaluate();
  await tick();
  await tick();
  assert.equal(isBedrock(r.ctl.apply('workers', {})), true, 'back on Bedrock (it is still at 95%)');
  await tick();
  const ok = r.notices.filter((n) => /AWS access works again/.test(n));
  assert.equal(ok.length, 1);
  assert.match(ok[0], /profile sketchup-bedrock/);
  assert.equal(r.ctl.status().problem, undefined);
});

test('a Bedrock turn that fails with an AWS auth error is probed at once; other errors are not', async (t) => {
  const r = rig(t);
  await onBedrock(r);
  const before = r.probes.length;
  r.ctl.bedrockError('rate limit exceeded, retry later');
  await tick();
  assert.equal(r.probes.length, before);
  r.probeAnswer.value = { ok: false, problem: 'the AWS SSO session has expired' };
  r.ctl.recordResult(worker(), { is_error: true, subtype: 'success', result: 'API Error: The SSO session associated with this profile has expired. Run aws sso login.' });
  await tick();
  await tick();
  assert.equal(r.probes.length, before + 1, 'at once, not at the next 5 minutes');
  assert.equal(isBedrock(r.ctl.apply('workers', {})), false);
  r.probeAnswer.value = { ok: true };
  r.ctl.bedrockError('ExpiredToken: the security token included in the request is expired');
  await tick();
  assert.equal(r.probes.length, before + 2);
});

test('the probe is cached: a switch needs an ok answer no older than two minutes, and it is asked again only then', async (t) => {
  const r = rig(t);
  r.plan(50);
  r.ctl.start();
  await tick();
  assert.equal(r.probes.length, 1, 'once at start, when a profile is set');
  assert.deepEqual({ ok: r.ctl.awsHealth().ok, at: r.ctl.awsHealth().checkedAt }, { ok: true, at: T0 });
  r.clock.t += PROBE_FRESH_MS - 1000;
  r.plan(95);
  assert.equal(isBedrock(r.ctl.apply('workers', {})), true, 'the answer is fresh enough');
  assert.equal(r.probes.length, 1, 'the cache served it');
  r.ctl.stop();
  const late = rig(t);
  late.plan(50);
  late.ctl.start();
  await tick();
  late.ctl.stop();
  late.clock.t += PROBE_FRESH_MS + 1000;
  late.plan(95);
  assert.equal(isBedrock(late.ctl.apply('workers', {})), false, 'older than two minutes: asked again first');
  assert.equal(late.probes.length, 2);
  await tick();
  assert.equal(isBedrock(late.ctl.apply('workers', {})), true);
});

test('a probe that throws is a problem, not a crash; a changed profile throws the old answer away', async (t) => {
  const r = rig(t);
  const boom = r.make({
    probe: async () => {
      throw new Error(`boom ${AWS_SECRET}`);
    },
  });
  r.plan(95);
  boom.apply('workers', {});
  await tick();
  assert.equal(boom.awsHealth().ok, false);
  assert.equal(boom.awsHealth().problem, 'the AWS check failed', 'a fixed sentence, not the error');
  const answer = r.ctl;
  answer.apply('workers', {});
  await tick();
  assert.equal(isBedrock(answer.apply('workers', {})), true);
  r.cfg.bedrock = { ...r.cfg.bedrock, profile: 'other-profile' };
  assert.equal(isBedrock(answer.apply('workers', {})), false, 'another profile has not been checked');
  assert.equal(r.probes.at(-1)?.profile, 'other-profile');
  await tick();
  assert.equal(answer.apply<Record<string, string | undefined>>('workers', {}).AWS_PROFILE, 'other-profile', 'and is used once it has been');
});

test('the daily cap: a notice once a day at 80%, the plan carries the work at 100%, and the next local day starts at zero', async (t) => {
  const r = rig(t, { bedrock: { profile: 'sketchup-bedrock', dailyBudgetUsd: 100 } });
  await onBedrock(r);
  r.ctl.recordResult(worker(), usageResult('us.anthropic.claude-opus-5-5', { inputTokens: 0, outputTokens: 3_000_000 }));
  // 3M output tokens of Opus at the regional rate: 3 * 20 * 1.1 = $66
  assert.equal(r.ctl.spentToday(), 66);
  await tick();
  assert.equal(r.notices.length, 0, 'under 80%');
  r.ctl.recordResult(worker(), usageResult('us.anthropic.claude-opus-5-5', { inputTokens: 0, outputTokens: 3_700_000 }));
  assert.ok(Math.abs(r.ctl.spentToday() - 66 - 0.7 * 22) < 1e-9);
  await tick();
  assert.equal(r.notices.length, 1);
  assert.match(r.notices[0], /Bedrock spend today is \$81\.40, 81% of the \$100 daily cap\. At the cap agents go back to your Claude plan\./);
  r.ctl.recordResult(worker(), usageResult('us.anthropic.claude-opus-5-5', { inputTokens: 0, outputTokens: 3_800_000 }));
  await tick();
  assert.equal(r.notices.filter((n) => /daily cap\./.test(n)).length, 1, 'the 80% notice is once per day');
  assert.equal(isBedrock(r.ctl.apply('workers', {})), true, '$81.40 + 0.1 * 22 is not 100 yet');
  r.ctl.recordResult(worker(), usageResult('us.anthropic.claude-opus-5-5', { inputTokens: 0, outputTokens: 9_000_000 }));
  assert.equal(isBedrock(r.ctl.apply('workers', {})), false, 'at 100% the plan carries the work (it has room)');
  await tick();
  assert.match(r.notices.at(-1)!, /Back on your Claude plan \(.*today's Bedrock cap is spent \(\$\d+ of \$100\), so the plan carries the work\)/);
  assert.equal(r.ctl.status().active, 'plan');
  assert.match(r.ctl.statusLines().join('\n'), /Bedrock spend today \$\d+ of \$100 \(\d+%\)/);
  // The plan at its limit as well: new work is blocked.
  r.plan(100);
  assert.equal(r.ctl.gateFor({ kind: 'worker' } as SessionInfo)?.includes('cap is spent'), true);
  assert.equal(r.ctl.status().active, 'blocked');
  assert.equal(isBedrock(r.ctl.apply('workers', {})), false);
  assert.equal(r.ctl.wantFor({ kind: 'worker' } as SessionInfo), undefined, 'nothing to recycle onto');
  assert.equal(r.ctl.gateFor({ kind: 'worker', requestedBy: { userId: 'lothsahn', displayName: 'L' } } as SessionInfo), undefined, 'a person with their own token is not held');
  await tick();
  assert.match(r.notices.at(-1)!, /on hold/);
  assert.match(r.ctl.statusLines().join('\n'), /WARNING: .*cap is spent.*new work waits/);
  const heldSwitches = r.events.switched;
  // Midnight: the cap day rolls over, spend starts at zero, and the held work may go.
  r.clock.t = new Date(2026, 9, 13, 0, 0, 5).getTime();
  const later = r.clock.t + 3 * HOUR;
  r.plan(100, 10, later);
  assert.equal(r.ctl.spentToday(), 0);
  assert.equal(r.ctl.gateFor({ kind: 'worker' } as SessionInfo), undefined);
  assert.equal(r.events.switched > heldSwitches, true, 'the held messages are told to look again');
  r.plan(96, 10, later);
  r.ctl.apply('workers', {});
  await tick(); // the AWS answer was hours old: asked again before the switch
  assert.equal(isBedrock(r.ctl.apply('workers', {})), true);
  assert.equal(r.ctl.status().spend.day, '2026-10-13');
  assert.ok(r.ctl.status().spend.weekUsd > 0, 'the week keeps the earlier days (Monday 2026-10-12)');
});

test('the cap notice comes once a day: at 80% again on the next day', async (t) => {
  const r = rig(t, { bedrock: { profile: 'sketchup-bedrock', dailyBudgetUsd: 10 } });
  await onBedrock(r);
  r.ctl.recordResult(worker(), usageResult('global.anthropic.claude-opus-5-5', { inputTokens: 0, outputTokens: 450_000 }));
  await tick();
  assert.equal(r.notices.filter((n) => /daily cap/.test(n)).length, 1);
  r.clock.t = new Date(2026, 9, 13, 9, 0, 0).getTime();
  r.plan(96, 10, r.clock.t + 3 * HOUR);
  r.ctl.recordResult(worker('s2'), usageResult('global.anthropic.claude-opus-5-5', { inputTokens: 0, outputTokens: 450_000 }));
  await tick();
  assert.equal(r.notices.filter((n) => /daily cap/.test(n)).length, 2, 'a new day, a new notice');
});

/** A result message carrying one Bedrock model's cumulative usage, as the SDK sends it. */
function usageResult(model: string, t: { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number; costUSD?: number }, provider = 'bedrock') {
  return { subtype: 'success', is_error: false, modelUsage: { [model]: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0, provider, ...t } } };
}

test('spend: each result is priced as the difference from the last total; a resumed session is not counted twice', async (t) => {
  const r = rig(t);
  await onBedrock(r);
  const s = worker('s1', { title: 'T'.repeat(200), kind: 'worker' });
  const haiku = 'us.anthropic.claude-haiku-5-5';
  // The measured turn: 992 in, 132 out, 27553 cache write on Haiku 5.5 (regional rates here: x1.1).
  r.ctl.recordResult(s, usageResult(haiku, { inputTokens: 992, outputTokens: 132, cacheCreationInputTokens: 27553 }));
  const one = 0.003609325 * 1.1;
  assert.ok(Math.abs(r.ctl.spentToday() - one) < 1e-9);
  assert.ok(Math.abs(s.info.bedrockCostUsd! - one) < 1e-9, 'the session carries its own total');
  // The next result is cumulative: only what is new counts.
  r.ctl.recordResult(s, usageResult(haiku, { inputTokens: 1992, outputTokens: 232, cacheCreationInputTokens: 27553, cacheReadInputTokens: 27553 }));
  const two = one + ((1000 * 0.1 + 100 * 0.5 + 27553 * 0.01) / 1e6) * 1.1;
  assert.ok(Math.abs(r.ctl.spentToday() - two) < 1e-9, `${r.ctl.spentToday()} vs ${two}`);
  // The same totals again (a result with nothing new): nothing is added and no line is written.
  r.ctl.recordResult(s, usageResult(haiku, { inputTokens: 1992, outputTokens: 232, cacheCreationInputTokens: 27553, cacheReadInputTokens: 27553 }));
  assert.ok(Math.abs(r.ctl.spentToday() - two) < 1e-9);
  // A first-party entry in the same result is not Bedrock's.
  r.ctl.recordResult(s, { modelUsage: { 'claude-haiku-5-5': { inputTokens: 5_000_000, outputTokens: 5_000_000, provider: 'firstParty', costUSD: 99 } } });
  assert.ok(Math.abs(r.ctl.spentToday() - two) < 1e-9, 'plan usage costs nothing here');
  // The server restarts and the session resumes: its first result carries the whole history again.
  const restarted = r.make();
  restarted.recordResult(s, usageResult(haiku, { inputTokens: 1992, outputTokens: 232, cacheCreationInputTokens: 27553, cacheReadInputTokens: 27553 }));
  assert.ok(Math.abs(restarted.spentToday() - two) < 1e-9, 'the ledger was reloaded, and the totals seen before are remembered');
  restarted.recordResult(s, usageResult(haiku, { inputTokens: 2000, outputTokens: 240, cacheCreationInputTokens: 27553, cacheReadInputTokens: 27553 }));
  assert.ok(restarted.spentToday() > two && restarted.spentToday() < two + 0.0001, 'and only the new tokens are added');
  // The ledger: one JSON line per priced turn, no secrets, the title cut.
  const lines = fs.readFileSync(path.join(r.dir, 'bedrock-spend.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 3);
  assert.deepEqual(Object.keys(lines[0]), ['t', 'session', 'title', 'role', 'model', 'in', 'out', 'cacheRead', 'cacheWrite', 'usd']);
  assert.deepEqual({ session: lines[0].session, role: lines[0].role, model: lines[0].model, in: lines[0].in, out: lines[0].out, cacheWrite: lines[0].cacheWrite }, { session: 's1', role: 'workers', model: haiku, in: 992, out: 132, cacheWrite: 27553 });
  assert.equal(lines[0].title.length, 80);
  assert.equal(lines[1].in, 1000);
  assert.equal(lines[1].cacheRead, 27553);
});

test('the ledger rebuilds the day, the week and the sessions at start', async (t) => {
  const r = rig(t);
  const line = (when: Date, session: string, usd: number) => JSON.stringify({ t: when.toISOString(), session, title: `title ${session}`, role: 'workers', model: 'us.anthropic.claude-sonnet-5-5', in: 1, out: 1, cacheRead: 0, cacheWrite: 0, usd });
  fs.writeFileSync(
    path.join(r.dir, 'bedrock-spend.jsonl'),
    [
      line(new Date(2026, 9, 5, 12), 'old', 7), // the Monday before: last week
      line(new Date(2026, 9, 11, 23, 59), 'sun', 5), // Sunday: last week
      line(new Date(2026, 9, 12, 0, 1), 'mon', 3.5), // Monday: this week, today
      line(new Date(2026, 9, 12, 9), 'mon', 2.5),
      '{"t": "torn',
    ].join('\n'),
  );
  const ctl = r.make();
  assert.equal(ctl.spentToday(), 6);
  assert.equal(ctl.spentThisWeek(), 6);
  r.clock.t = new Date(2026, 9, 14, 9).getTime();
  assert.equal(ctl.spentThisWeek(), 6, 'Wednesday: the same Monday-based week');
  assert.equal(ctl.spentToday(), 0);
  assert.deepEqual(ctl.topSessions(2).map((x) => [x.session, x.usd, x.turns]), [['old', 7, 1], ['mon', 6, 2]]);
  assert.equal(ctl.recentSpend().length, 4);
  assert.equal(localDay(Date.parse(ctl.recentSpend()[0].t)), '2026-10-05');
});

test('status() and statusLines(): the badge, the thresholds and the spend line', async (t) => {
  const r = rig(t);
  r.plan(96);
  r.ctl.apply('workers', {});
  await tick();
  r.ctl.recordResult(worker(), usageResult('us.anthropic.claude-sonnet-5-5', { inputTokens: 1_000_000, outputTokens: 0 }));
  const st = r.ctl.status();
  assert.deepEqual({ mode: st.mode, active: st.active, configured: st.configured, profile: st.profile, region: st.region, regionPrefix: st.regionPrefix, thresholdPercent: st.thresholdPercent, resumePercent: st.resumePercent, sessionPercent: st.sessionPercent }, { mode: 'auto', active: 'bedrock', configured: true, profile: 'sketchup-bedrock', region: 'us-west-2', regionPrefix: 'us', thresholdPercent: 94, resumePercent: 84, sessionPercent: 96 });
  assert.equal(st.spend.day, '2026-10-12');
  assert.equal(st.spend.todayUsd, 2.2);
  assert.equal(st.spend.dailyBudgetUsd, 200);
  assert.deepEqual(st.models, { opus: 'us.anthropic.claude-opus-5-5', sonnet: 'us.anthropic.claude-sonnet-5-5', haiku: 'us.anthropic.claude-haiku-5-5' });
  assert.ok(st.since);
  assert.equal(st.problem, undefined);
  const [line, ...rest] = r.ctl.statusLines();
  assert.equal(line, 'Backend: Bedrock (auto: session usage 96% is at the 94% threshold; back to the plan under 84% or at the reset) · profile sketchup-bedrock, region us-west-2, us. ids · Bedrock spend today $2.20 of $200 (1%), this week $2.20');
  assert.deepEqual(rest, [], 'no warning while all is well');
  const off = rig(t, { bedrock: { profile: 'p', dailyBudgetUsd: 0 } });
  assert.match(off.ctl.statusLines()[0], /of no cap/);
});

test('no secret leaks: not into the Bedrock env, status lines, the ledger, the state file, the notices or a probe failure', async (t) => {
  const r = rig(t);
  // Secrets everywhere they could come from: the server's env (SERVER_ENV), config claudeEnv, a session's title.
  r.probeAnswer.value = { ok: false, problem: classifyAwsFailure(`The SSO session associated with this profile has expired ${AWS_SECRET} ${AWS_KEY} ${SERVER_TOKEN}`, { code: 1 }) };
  r.plan(99);
  r.ctl.apply('workers', {});
  await tick();
  await tick();
  r.probeAnswer.value = { ok: true };
  r.clock.t += PROBE_EVERY_MS + 1;
  r.ctl.evaluate();
  await tick();
  await tick();
  const env = r.ctl.apply('workers', { ...SERVER_ENV, ...r.cfg.claudeEnv, ...r.cfg.userClaudeEnv!.lothsahn });
  assert.equal(isBedrock(env), true);
  assert.equal(r.ctl.apply('orchestrator', { ...SERVER_ENV, ...r.cfg.claudeEnv }).CLAUDE_CODE_OAUTH_TOKEN, undefined);
  r.ctl.recordResult(worker('s9', { title: `leak? ${AWS_KEY}` }), usageResult('us.anthropic.claude-haiku-5-5', { inputTokens: 10, outputTokens: 10 }));
  await tick();
  const everything = [
    JSON.stringify(env),
    JSON.stringify(r.ctl.apply('standing', SERVER_ENV)),
    r.ctl.statusLines().join('\n'),
    JSON.stringify(r.ctl.status()),
    JSON.stringify(r.ctl.awsHealth()),
    r.notices.join('\n'),
    fs.readFileSync(path.join(r.dir, 'bedrock-state.json'), 'utf8'),
    JSON.stringify(r.ctl.recentSpend().map((l) => ({ ...l, title: '' }))),
    fs.readdirSync(r.dir).filter((f) => f !== 'bedrock-spend.jsonl').map((f) => fs.readFileSync(path.join(r.dir, f), 'utf8')).join('\n'),
  ].join('\n');
  for (const s of SECRETS.filter((x) => x !== AWS_KEY)) assert.equal(everything.includes(s), false, `leaked ${s.slice(0, 10)}…`);
  assert.equal(everything.includes(AWS_KEY), false, 'the access key id neither');
  assert.match(classifyAwsFailure(`${AWS_SECRET} Token has expired`), /^the AWS SSO session has expired$/);
  assert.equal(classifyAwsFailure(`weird ${AWS_SECRET}`), 'the AWS check failed');
});

test('classifyAwsFailure: fixed sentences for what the AWS CLI can say', () => {
  assert.equal(classifyAwsFailure('', { code: 'ENOENT' }), 'the AWS CLI (aws) is not installed on this host');
  assert.equal(classifyAwsFailure('', { killed: true }), 'the AWS check timed out');
  assert.equal(classifyAwsFailure('The config profile (x) could not be found'), 'the AWS profile was not found in ~/.aws/config');
  assert.equal(classifyAwsFailure('Could not connect to the endpoint URL: "https://sts.us-west-2.amazonaws.com/"'), 'the AWS check failed', 'unknown text is not guessed at');
  assert.equal(classifyAwsFailure('Your session has expired. Please reauthenticate. The SSO session associated with this profile has expired'), 'the AWS SSO session has expired');
  assert.equal(classifyAwsFailure('Unable to locate credentials. You can configure credentials by running "aws configure".'), 'AWS has no credentials for this profile (no SSO login yet)');
  assert.equal(classifyAwsFailure('An error occurred (InvalidClientTokenId) when calling GetCallerIdentity'), 'AWS did not accept the credentials (invalid or expired)');
  assert.equal(classifyAwsFailure('An error occurred (AccessDenied) when calling'), 'AWS denied access (AccessDenied)');
});
