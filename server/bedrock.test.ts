import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AWS_AUTH_ERROR,
  BEDROCK_KEYS,
  BEDROCK_STRIPPED_ENV,
  awsFix,
  bedrockAccountKey,
  bedrockEnv,
  bedrockModels,
  bedrockSettings,
  checkBedrockConfig,
  decideBackend,
  estimateUsd,
  isBedrockEnv,
  localDay,
  localWeekStart,
  noTokens,
  normalizeBedrockSetting,
  percentNow,
  tokenDelta,
  withBedrock,
  type AutoState,
  type BedrockConfig,
  type DecideInput,
  type PlanView,
} from './bedrock.ts';
import { normalizeSetting, setAppConfig, SETTABLE_KEYS } from './appConfig.ts';
import type { Config } from './config.ts';
import { HOST_LOGIN, buildAccounts, sessionSource, tokenKey } from './usage.ts';

/** The Bedrock backend's pure rules (w38, docs/bedrock.md): when to switch, what a process gets, what a turn cost. */

const NOW = new Date(2026, 9, 12, 14, 0, 0).getTime(); // local 2026-10-12 14:00, whatever the time zone is
const FUTURE = new Date(NOW + 3_600_000).toISOString();
const PAST = new Date(NOW - 60_000).toISOString();

const settings = (over: BedrockConfig = {}) => bedrockSettings({ bedrock: { profile: 'sketchup-bedrock', ...over } });
const session = (percent?: number, resetsAt: string | undefined = FUTURE): PlanView => ({ session: percent === undefined ? undefined : { percent, resetsAt } });

/** One decision; `state` is what the last one left. */
const decide = (plan: PlanView | undefined, state: AutoState = {}, over: Partial<DecideInput> = {}) => decideBackend({ settings: settings(), plan, state, spentToday: 0, now: NOW, ...over });

test('auto: the 5-hour session reaching 94% switches to Bedrock, 93.9% does not', () => {
  const below = decide(session(93.9));
  assert.equal(below.backend, 'plan');
  assert.deepEqual(below.state, {});
  const at = decide(session(94));
  assert.equal(at.backend, 'bedrock');
  assert.match(at.reason, /session usage 94% is at the 94% threshold/);
  assert.ok(at.state.onBedrock, 'remembered, for the hysteresis');
  assert.equal(decide(session(94), {}, { settings: settings({ thresholdPercent: 90 }) }).backend, 'bedrock', 'the threshold is configurable');
});

test('auto: hysteresis. On Bedrock it stays through 90% and comes back under 84%; a wobble around 94% does not flap', () => {
  let state: AutoState = decide(session(95)).state;
  for (const p of [93, 94, 92, 90, 84, 95, 93.9]) {
    const d = decide(session(p), state);
    assert.equal(d.backend, 'bedrock', `${p}% stays on Bedrock`);
    state = d.state;
  }
  const back = decide(session(83.9), state);
  assert.equal(back.backend, 'plan');
  assert.deepEqual(back.state, {}, 'the memory is cleared');
  assert.match(back.reason, /back to 84%|back to 83\.9%|back to 84%/);
  // On the plan again, the wobble stays on the plan until 94 is reached anew.
  assert.equal(decide(session(93), back.state).backend, 'plan');
  assert.equal(decide(session(94), back.state).backend, 'bedrock');
  // The margin is configurable: 5 points under 94 is 89.
  const tight = settings({ resumeMarginPercent: 5 });
  assert.equal(decide(session(90), state, { settings: tight }).backend, 'bedrock');
  assert.equal(decide(session(88), state, { settings: tight }).backend, 'plan');
});

test('auto: a window that reset since the reading means 0%, not the stale 97%', () => {
  assert.equal(percentNow({ percent: 97, resetsAt: PAST }, NOW), 0);
  assert.equal(percentNow({ percent: 97, resetsAt: FUTURE }, NOW), 97);
  assert.equal(percentNow({ percent: 97 }, NOW), 97, 'no reset time: the number stands');
  assert.equal(percentNow(undefined, NOW), undefined);
  assert.equal(decide(session(97, PAST)).backend, 'plan', 'a stale 97% does not send the agents to Bedrock');
  const onBedrock: AutoState = { onBedrock: new Date(NOW - 3_600_000).toISOString(), why: 'session usage 97% is at the 94% threshold' };
  const d = decide(session(97, PAST), onBedrock);
  assert.equal(d.backend, 'plan', 'and brings them back');
  assert.deepEqual(d.state, {});
});

test('auto: an unknown reading keeps the state, whichever it is', () => {
  const on: AutoState = { onBedrock: new Date(NOW - 1000).toISOString(), why: 'session usage 95% is at the 94% threshold' };
  assert.equal(decide(undefined, on).backend, 'bedrock');
  assert.deepEqual(decide(undefined, on).state, on);
  assert.equal(decide({ session: undefined }, on).backend, 'bedrock');
  assert.equal(decide(undefined, {}).backend, 'plan');
});

test('auto: the weekly meter switches too when bedrock.weeklyThresholdPercent is set, and only then', () => {
  const plan: PlanView = { session: { percent: 10, resetsAt: FUTURE }, weekly: { percent: 96, resetsAt: FUTURE } };
  assert.equal(decide(plan).backend, 'plan', 'off by default');
  const w = settings({ weeklyThresholdPercent: 95 });
  const d = decide(plan, {}, { settings: w });
  assert.equal(d.backend, 'bedrock');
  assert.match(d.reason, /weekly usage 96% is at the 95% threshold/);
  // The weekly meter must be under its own resume line too, even when the session is low.
  assert.equal(decide({ ...plan, weekly: { percent: 90, resetsAt: FUTURE } }, d.state, { settings: w }).backend, 'bedrock');
  assert.equal(decide({ ...plan, weekly: { percent: 84, resetsAt: FUTURE } }, d.state, { settings: w }).backend, 'plan');
});

test('a forced mode beats the usage, both ways', () => {
  assert.equal(decide(session(10), {}, { settings: settings({ mode: 'bedrock' }) }).backend, 'bedrock');
  assert.equal(decide(undefined, {}, { settings: settings({ mode: 'bedrock' }) }).backend, 'bedrock', 'even with no reading at all');
  const forced = decide(session(99), { onBedrock: 'x' }, { settings: settings({ mode: 'plan' }) });
  assert.equal(forced.backend, 'plan');
  assert.deepEqual(forced.state, {}, 'auto starts clean when it is switched back on');
  assert.match(forced.reason, /set to your Claude plan/);
});

test('Bedrock unavailable (no profile, expired SSO): the plan carries the work and the reason says so', () => {
  const none = decide(session(99), {}, { settings: bedrockSettings({ bedrock: {} }), unavailable: 'no AWS profile is set' });
  assert.equal(none.backend, 'plan');
  assert.equal(none.degraded, true);
  assert.match(none.reason, /Bedrock is not usable \(no AWS profile is set\), so the plan carries the work/);
  assert.ok(none.state.onBedrock, 'Auto still remembers it wanted Bedrock, so it goes the moment it works');
  const sso = decide(session(10), {}, { settings: settings({ mode: 'bedrock' }), unavailable: 'the AWS SSO session has expired' });
  assert.equal(sso.backend, 'plan');
  assert.match(sso.reason, /set to Bedrock, but Bedrock is not usable \(the AWS SSO session has expired\)/);
  assert.equal(decide(session(10), {}, { unavailable: 'the AWS SSO session has expired' }).degraded, undefined, 'not wanted: nothing is degraded');
  assert.equal(bedrockSettings({ bedrock: {} }).profile, undefined, 'no profile: Bedrock is off');
});

test('the daily cap: at 100% the plan carries the work if it has room, else new work is blocked', () => {
  const s = settings({ dailyBudgetUsd: 100 });
  assert.equal(decide(session(95), {}, { settings: s, spentToday: 99.99 }).backend, 'bedrock');
  const plan = decide(session(95), {}, { settings: s, spentToday: 100 });
  assert.equal(plan.backend, 'plan');
  assert.equal(plan.degraded, true);
  assert.match(plan.reason, /today's Bedrock cap is spent \(\$100 of \$100\), so the plan carries the work/);
  const full: PlanView = { session: { percent: 100, resetsAt: FUTURE } };
  const blocked = decide(full, {}, { settings: s, spentToday: 150 });
  assert.equal(blocked.backend, 'blocked');
  assert.match(blocked.reason, /the plan is at its limit, so new work waits/);
  assert.equal(decide({ session: { percent: 100, resetsAt: PAST } }, { onBedrock: 'x' }, { settings: s, spentToday: 150 }).backend, 'plan', 'a plan whose window reset has room again');
  assert.equal(decide({ weekly: { percent: 100, resetsAt: FUTURE } }, { onBedrock: 'x' }, { settings: s, spentToday: 150 }).backend, 'blocked', 'the weekly limit blocks too');
  assert.equal(decide(session(95), {}, { settings: settings({ dailyBudgetUsd: 0 }), spentToday: 5000 }).backend, 'bedrock', '0 turns the cap off');
  assert.equal(decide(session(10), {}, { settings: s, spentToday: 500 }).backend, 'plan', 'not wanted: the cap is no news');
});

test('the local day and week: spend counts from local midnight; the week starts on Monday', () => {
  assert.equal(localDay(new Date(2026, 9, 12, 0, 0, 0)), '2026-10-12');
  assert.equal(localDay(new Date(2026, 9, 12, 23, 59, 59)), '2026-10-12');
  assert.equal(localDay(new Date(2026, 9, 13, 0, 0, 1)), '2026-10-13', 'a new day');
  assert.equal(localDay(new Date(2026, 0, 5).getTime()), '2026-01-05', 'a timestamp works too');
  assert.equal(localWeekStart(new Date(2026, 9, 12)), '2026-10-12', '2026-10-12 is a Monday');
  assert.equal(localWeekStart(new Date(2026, 9, 18)), '2026-10-12', 'the Sunday after it');
  assert.equal(localWeekStart(new Date(2026, 9, 11)), '2026-10-05', 'the Sunday before');
  assert.equal(localWeekStart(new Date(2026, 0, 1)), '2025-12-29', 'across the year');
});

test('estimateUsd: the measured Haiku 5.5 turn (992 in, 132 out, 27553 cache write) is $0.00361 at global rates', () => {
  const turn = { ...noTokens(), inputTokens: 992, outputTokens: 132, cacheCreationInputTokens: 27553 };
  const global = estimateUsd('global.anthropic.claude-haiku-5-5', turn, 'global');
  assert.ok(Math.abs(global - 0.00361) < 0.000005, `got ${global}`);
  assert.ok(Math.abs(estimateUsd('us.anthropic.claude-haiku-5-5', turn, 'us') - global * 1.1) < 1e-9, 'a regional prefix costs 10% more');
  // Opus and Sonnet use their own rates; cache reads are cheap.
  const m = { ...noTokens(), inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadInputTokens: 1_000_000 };
  assert.equal(estimateUsd('x.anthropic.claude-opus-5-5', m, 'global'), 4 + 20 + 0.2);
  assert.equal(estimateUsd('x.anthropic.claude-sonnet-5-5', m, 'global'), 2 + 10 + 0.1);
  // Claude Code's own price for the same tokens wins when it is higher (Haiku's long-context tier), and is the only
  // figure for a model this table does not know.
  assert.equal(estimateUsd('global.anthropic.claude-haiku-5-5', turn, 'global', 1), 1);
  assert.equal(estimateUsd('some-new-model', turn, 'global', 0.5), 0.5);
  assert.ok(estimateUsd('some-new-model', turn, 'global') > 0, 'no price at all: the Opus rates, never zero');
});

test('tokenDelta: a result is cumulative, so a turn is the difference; a resumed session is not counted twice', () => {
  const t = (inputTokens: number, outputTokens: number, cacheReadInputTokens = 0, cacheCreationInputTokens = 0) => ({ inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens });
  assert.deepEqual(tokenDelta(t(150, 40, 10, 5), t(100, 30, 10, 0)), t(50, 10, 0, 5));
  assert.deepEqual(tokenDelta(t(100, 30), t(100, 30)), noTokens(), 'nothing new');
  assert.deepEqual(tokenDelta(t(5, 3), t(100, 30)), t(5, 3), 'a counter that went down restarted: all of it counts');
  assert.deepEqual(tokenDelta(t(5, 3), undefined), t(5, 3), 'the first sight counts whole');
  assert.deepEqual(tokenDelta(t(100, 30, 2), t(100, 30, 9)).cacheReadInputTokens, 0, 'never negative');
});

test('a Bedrock process gets the profile, the region and the three model ids, and none of the plan or AWS credentials', () => {
  const s = settings({ region: 'us-east-1' });
  const server = {
    PATH: '/usr/bin',
    CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-' + 'a'.repeat(50),
    ANTHROPIC_API_KEY: 'sk-ant-api03-secret',
    AWS_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
    AWS_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    AWS_SESSION_TOKEN: 'FwoGZXIvYXdzE',
    AWS_BEARER_TOKEN_BEDROCK: 'bearer-secret',
    AWS_DEFAULT_REGION: 'eu-west-1',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku-5-5',
    FF_SANDBOX_ID: 'sb1',
  };
  const env: Record<string, string | undefined> = withBedrock(server, s);
  for (const k of BEDROCK_STRIPPED_ENV) assert.equal(k in env, false, `${k} is dropped`);
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.FF_SANDBOX_ID, 'sb1');
  assert.equal(env.CLAUDE_CODE_USE_BEDROCK, '1');
  assert.equal(env.AWS_PROFILE, 'sketchup-bedrock');
  assert.equal(env.AWS_REGION, 'us-east-1');
  assert.deepEqual({ opus: env.ANTHROPIC_DEFAULT_OPUS_MODEL, sonnet: env.ANTHROPIC_DEFAULT_SONNET_MODEL, haiku: env.ANTHROPIC_DEFAULT_HAIKU_MODEL }, { opus: 'us.anthropic.claude-opus-5-5', sonnet: 'us.anthropic.claude-sonnet-5-5', haiku: 'us.anthropic.claude-haiku-5-5' }, 'the pins now name Bedrock ids');
  assert.doesNotMatch(JSON.stringify(env), /AKIA|wJalr|sk-ant|bearer-secret|FwoGZ/);
  assert.equal(server.AWS_SECRET_ACCESS_KEY.length > 0, true, 'the input is not changed');
  assert.deepEqual(bedrockModels({ regionPrefix: 'global' }), { opus: 'global.anthropic.claude-opus-5-5', sonnet: 'global.anthropic.claude-sonnet-5-5', haiku: 'global.anthropic.claude-haiku-5-5' });
  assert.throws(() => bedrockEnv(bedrockSettings({ bedrock: {} })), /no profile/);
  assert.equal(isBedrockEnv(env), true);
  assert.equal(isBedrockEnv({}), false);
  assert.equal(isBedrockEnv({ CLAUDE_CODE_USE_BEDROCK: '0' }), false);
  assert.equal(bedrockAccountKey(env), 'bedrock:sketchup-bedrock', 'the profile name only');
});

test('a Bedrock session is not counted against a plan account (buildAccounts, sessionSource)', () => {
  const TOKEN = 'sk-ant-oat01-host-token-9AAA';
  const ctx = { hostName: 'BEAST', token: { key: tokenKey(TOKEN), label: 'host token …9AAA' }, machines: [], sessions: [] as { id: string; source: string; live?: boolean }[] };
  const running = { machineId: undefined, requestedBy: undefined, kind: 'worker' as const, status: 'running' as const };
  const onBedrock = sessionSource({ ...running, account: bedrockAccountKey({ AWS_PROFILE: 'p' }) }, TOKEN, () => undefined);
  assert.equal(onBedrock, 'bedrock:p', 'a running Bedrock process is on its profile');
  const onToken = sessionSource({ ...running, account: tokenKey(TOKEN) }, TOKEN, () => undefined);
  const accounts = buildAccounts(new Map(), { ...ctx, sessions: [{ id: 'plan1', source: onToken, live: true }, { id: 'bed1', source: onBedrock, live: true }] });
  assert.equal(accounts.length, 2, 'the token and the host login; no account for Bedrock');
  assert.deepEqual(accounts.flatMap((a) => a.sessionIds), ['plan1']);
  assert.deepEqual(accounts.map((a) => a.sources).flat().sort(), [HOST_LOGIN, tokenKey(TOKEN)].sort());
  assert.equal(accounts.some((a) => a.sources.some((x) => x.startsWith('bedrock:'))), false);
});

test('normalizeBedrockSetting: sane values only; a profile that is a key is refused and never echoed', () => {
  assert.equal(normalizeBedrockSetting('bedrock.mode', ' Plan '), 'plan');
  assert.throws(() => normalizeBedrockSetting('bedrock.mode', 'sometimes'), /"auto".*"plan".*"bedrock"/);
  assert.equal(normalizeBedrockSetting('bedrock.profile', 'sketchup-bedrock'), 'sketchup-bedrock');
  assert.equal(normalizeBedrockSetting('bedrock.profile', 'Team_A.sso@prod'), 'Team_A.sso@prod');
  const secrets = ['AKIAIOSFODNN7EXAMPLE', 'ASIAIOSFODNN7EXAMPLE1234', 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', 'sk-ant-oat01-' + 'a'.repeat(50), 'two words', 'with;semi', '', '  '];
  for (const bad of secrets) {
    assert.throws(
      () => normalizeBedrockSetting('bedrock.profile', bad),
      (e: Error) => /NAME of an AWS profile/.test(e.message) && (!bad.trim() || !e.message.includes(bad)),
      `refused: ${bad.slice(0, 6)}…`,
    );
  }
  assert.throws(() => normalizeBedrockSetting('bedrock.profile', 42), /NAME of an AWS profile/);
  assert.equal(normalizeBedrockSetting('bedrock.region', 'eu-central-1'), 'eu-central-1');
  assert.throws(() => normalizeBedrockSetting('bedrock.region', 'Oregon'), /AWS region/);
  assert.equal(normalizeBedrockSetting('bedrock.regionPrefix', 'GLOBAL'), 'global');
  assert.throws(() => normalizeBedrockSetting('bedrock.regionPrefix', ''), /one of us, eu/);
  assert.equal(normalizeBedrockSetting('bedrock.thresholdPercent', '90'), 90);
  assert.throws(() => normalizeBedrockSetting('bedrock.thresholdPercent', 101), /1 to 100/);
  assert.throws(() => normalizeBedrockSetting('bedrock.thresholdPercent', true), /1 to 100/);
  assert.throws(() => normalizeBedrockSetting('bedrock.resumeMarginPercent', 100), /1 to 99/);
  assert.equal(normalizeBedrockSetting('bedrock.dailyBudgetUsd', 0), 0);
  assert.equal(normalizeBedrockSetting('bedrock.dailyBudgetUsd', '12.5'), 12.5);
  assert.throws(() => normalizeBedrockSetting('bedrock.dailyBudgetUsd', -1), /0 to 100000/);
  assert.equal(normalizeBedrockSetting('bedrock.mode', null), undefined, 'null removes it');
  assert.equal(normalizeBedrockSetting('bedrock.profile', undefined), undefined);
});

test('checkBedrockConfig: a hand-edited config.json is checked as set_app_config would', () => {
  checkBedrockConfig({});
  checkBedrockConfig({ bedrock: { profile: 'p', region: 'us-west-2', mode: 'auto', dailyBudgetUsd: 50 } });
  assert.throws(() => checkBedrockConfig({ bedrock: 'p' } as never), /bedrock is an object/);
  assert.throws(() => checkBedrockConfig({ bedrock: [] } as never), /bedrock is an object/);
  assert.throws(() => checkBedrockConfig({ bedrock: { prfile: 'p' } } as never), /bedrock\.prfile: no such setting/);
  assert.throws(() => checkBedrockConfig({ bedrock: { mode: 'x' } } as never), /bedrock\.mode/);
  assert.throws(() => checkBedrockConfig({ bedrock: { profile: 'AKIAIOSFODNN7EXAMPLE' } }), (e: Error) => /NAME of an AWS profile/.test(e.message) && !e.message.includes('AKIAIOSFODNN7EXAMPLE'));
});

test('set_app_config: every bedrock key is allowed, validated, written, applied live, and removable', (t) => {
  for (const k of BEDROCK_KEYS) assert.ok((SETTABLE_KEYS as readonly string[]).includes(k), `${k} is settable`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bedrock-cfg-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ port: 8790 }));
  const cfg = {} as unknown as Config;
  assert.deepEqual(setAppConfig(file, cfg, 'bedrock.profile', 'sketchup-bedrock'), { before: undefined, after: 'sketchup-bedrock' });
  assert.deepEqual(setAppConfig(file, cfg, 'bedrock.mode', 'Bedrock'), { before: undefined, after: 'bedrock' });
  setAppConfig(file, cfg, 'bedrock.dailyBudgetUsd', '75');
  assert.deepEqual(cfg.bedrock, { profile: 'sketchup-bedrock', mode: 'bedrock', dailyBudgetUsd: 75 }, 'live');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { port: 8790, bedrock: { profile: 'sketchup-bedrock', mode: 'bedrock', dailyBudgetUsd: 75 } });
  assert.equal(bedrockSettings(cfg).mode, 'bedrock');
  assert.throws(() => setAppConfig(file, cfg, 'bedrock.profile', 'AKIAIOSFODNN7EXAMPLE'), (e: Error) => !e.message.includes('AKIAIOSFODNN7EXAMPLE'));
  assert.equal(cfg.bedrock?.profile, 'sketchup-bedrock', 'a refused value changes nothing');
  assert.throws(() => normalizeSetting('bedrock.mode', 'maybe'), /bedrock\.mode/);
  assert.deepEqual(setAppConfig(file, cfg, 'bedrock.mode', null), { before: 'bedrock', after: undefined });
  assert.equal(cfg.bedrock?.mode, undefined, 'null removes it: back to auto');
  assert.equal(bedrockSettings(cfg).mode, 'auto');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).bedrock.mode, undefined);
});

test('AWS_AUTH_ERROR and awsFix: an expired SSO session is told with the command that fixes it', () => {
  for (const text of ['The SSO session associated with this profile has expired', 'ExpiredToken: The security token included in the request is expired', 'Token has expired and refresh failed', 'UnrecognizedClientException', 'Unable to locate credentials', 'failed to load AWS credentials', 'AccessDeniedException: not allowed']) {
    assert.match(text, AWS_AUTH_ERROR, text);
  }
  assert.doesNotMatch('rate limit exceeded, retry later', AWS_AUTH_ERROR);
  assert.equal(awsFix('p', 'the AWS SSO session has expired'), 'run `aws sso login --profile p`');
  assert.match(awsFix('p', 'AWS denied access (AccessDenied)'), /bedrock:InvokeModel/);
  assert.match(awsFix(undefined, 'something else'), /aws sts get-caller-identity --profile <profile>/);
});
