/**
 * Read-only check that this host can run agents on SketchUp's AWS Bedrock (w38, docs/bedrock.md). Run it before turning
 * the backend on, and whenever Bedrock "stopped working":
 *
 *   node scripts/bedrock-preflight.ts [--profile P] [--region R] [--call]
 *
 * 1. the AWS profile names ~/.aws/config knows (names only);
 * 2. `aws sts get-caller-identity`: prints the account id and the role name, never the user id, a key or a token;
 * 3. the three Claude models this app asks for (bedrockModels) are ACTIVE inference profiles in the region;
 * 4. with --call: one tiny Haiku call through `claude -p`, with the same environment a Bedrock agent gets, printing the
 *    model used, the provider that served it and what Claude Code priced it at;
 * 5. yesterday's and today's AWS cost, labelled ACCOUNT-WIDE: it may include other people, it is not this app's spend.
 *
 * Nothing is written or changed anywhere (`--call` costs a fraction of a cent). Where a step fails it says what to run or
 * to request. The profile and region default to config.json's bedrock settings.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { BEDROCK_STRIPPED_ENV, awsFix, bedrockSettings, withBedrock, type BedrockConfig } from '../server/bedrock.ts';
import { checkFoundationModels, checkInferenceProfiles, classifyAwsFailure, modelFix, parseCallerIdentity, parseClaudeCall, parseCostTotal, parseProfiles } from '../server/bedrockPreflight.ts';
import { configPath } from '../server/config.ts';

interface Args {
  profile?: string;
  region?: string;
  call: boolean;
}

export function parseArgs(argv: string[]): Args {
  const out: Args = { call: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--call') out.call = true;
    else if (a === '--profile' || a === '--region') {
      const v = argv[++i];
      if (!v || v.startsWith('--')) throw new Error(`${a} needs a value`);
      out[a.slice(2) as 'profile' | 'region'] = v;
    } else throw new Error(`unknown argument ${a}; usage: node scripts/bedrock-preflight.ts [--profile P] [--region R] [--call]`);
  }
  return out;
}

/** The environment the AWS CLI runs with: no key of the server's own, so the profile is what is tested. */
const cleanEnv = (): Record<string, string | undefined> => {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const k of BEDROCK_STRIPPED_ENV) delete env[k];
  return env;
};

interface Ran {
  ok: boolean;
  out: string;
  /** Only for classifyAwsFailure: never printed. */
  err: string;
  code?: string;
  killed?: boolean;
}

function run(cmd: string, args: string[], env: Record<string, string | undefined>, timeout = 30_000): Ran {
  const r = spawnSync(cmd, args, { env: env as NodeJS.ProcessEnv, encoding: 'utf8', timeout, maxBuffer: 8 << 20, windowsHide: true });
  const code = (r.error as NodeJS.ErrnoException | undefined)?.code;
  return { ok: r.status === 0 && !r.error, out: r.stdout ?? '', err: `${r.stderr ?? ''}`, ...(code ? { code } : {}), ...(r.signal ? { killed: true } : {}) };
}

const ok = (s: string) => console.log(`  ok    ${s}`);
const bad = (s: string, fix: string) => {
  console.log(`  FAIL  ${s}`);
  console.log(`        to fix: ${fix}`);
};
const note = (s: string) => console.log(`        ${s}`);
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** config.json's bedrock settings, read as plain JSON (no server config is loaded). */
function configured(): BedrockConfig {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath(), 'utf8').replace(/^﻿/, '')) as { bedrock?: BedrockConfig };
    return raw.bedrock ?? {};
  } catch {
    return {};
  }
}

export function preflight(args: Args): number {
  const s = bedrockSettings({ bedrock: { ...configured(), ...(args.profile ? { profile: args.profile } : {}), ...(args.region ? { region: args.region } : {}) } });
  const env = cleanEnv();
  let failed = 0;
  const fail = (what: string, fix: string) => {
    failed++;
    bad(what, fix);
  };

  console.log('1. AWS profiles (names only)');
  const profiles = run('aws', ['configure', 'list-profiles'], env);
  if (!profiles.ok) fail(classifyAwsFailure(profiles.err, profiles), 'install the AWS CLI v2 (https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html), then `aws configure sso`');
  else {
    const names = parseProfiles(profiles.out);
    ok(names.length ? names.join(', ') : '(none)');
    if (!s.profile) fail('no profile chosen', `pass --profile <one of the names above>, or set it for the app: ask the orchestrator to set_app_config bedrock.profile`);
    else if (!names.includes(s.profile)) fail(`profile "${s.profile}" is not in ~/.aws/config`, `\`aws configure sso --profile ${s.profile}\`, or pass --profile with one of the names above`);
    else ok(`using profile "${s.profile}", region ${s.region}, ${s.regionPrefix}. model ids`);
  }
  if (!s.profile) return finish(failed);
  const aws = (sub: string[], region = s.region) => run('aws', [...sub, '--profile', s.profile!, '--region', region, '--output', 'json'], env);

  console.log('2. Who AWS says you are (aws sts get-caller-identity)');
  const who = aws(['sts', 'get-caller-identity']);
  if (!who.ok) fail(classifyAwsFailure(who.err, who), awsFix(s.profile, classifyAwsFailure(who.err, who)));
  else {
    const id = parseCallerIdentity(who.out);
    if (id) ok(`account ${id.account}, role ${id.role}`);
    else fail('AWS answered, but not with an account id', `check \`aws sts get-caller-identity --profile ${s.profile}\` by hand`);
  }
  if (failed) return finish(failed);

  console.log(`3. The Claude models this app asks for, in ${s.region}`);
  // With a cross-region prefix ("us.", "global.") the ids are inference profiles; without one they are the foundation models.
  const listed = s.regionPrefix ? aws(['bedrock', 'list-inference-profiles', '--type-equals', 'SYSTEM_DEFINED', '--max-results', '1000']) : aws(['bedrock', 'list-foundation-models', '--by-provider', 'anthropic']);
  if (!listed.ok) {
    const problem = classifyAwsFailure(listed.err, listed);
    fail(`could not list the models: ${problem}`, /denied/.test(problem) ? 'ask your AWS admin for bedrock:ListInferenceProfiles and bedrock:ListFoundationModels (and bedrock:InvokeModel on these models)' : awsFix(s.profile, problem));
  } else {
    for (const c of s.regionPrefix ? checkInferenceProfiles(listed.out, s) : checkFoundationModels(listed.out, s)) {
      if (c.status === 'active') ok(`${c.alias}: ${c.id} is ACTIVE`);
      else fail(`${c.alias}: ${c.id} is ${c.status === 'missing' ? 'not listed' : 'not ACTIVE'}`, modelFix(c, s.region));
    }
  }

  if (args.call) {
    console.log('4. One tiny call through Claude Code on Bedrock (claude -p, Haiku)');
    const callEnv = withBedrock(process.env as Record<string, string | undefined>, s);
    const r = run('claude', ['-p', 'Reply with the word pong', '--model', 'haiku', '--max-turns', '1', '--output-format', 'json'], callEnv, 120_000);
    if (!r.ok) fail(`claude did not answer${r.code === 'ENOENT' ? ' (it is not installed or not on PATH)' : ''}`, r.code === 'ENOENT' ? 'install Claude Code (https://docs.claude.com/en/docs/claude-code)' : `run the same call by hand: CLAUDE_CODE_USE_BEDROCK=1 AWS_PROFILE=${s.profile} AWS_REGION=${s.region} claude -p "Reply with the word pong" --model haiku`);
    else {
      const c = parseClaudeCall(r.out);
      if (c.isError) fail('claude answered with an error', 'run the call by hand to read the error (the model may not be enabled for your account: request access in the Bedrock console, Model access)');
      else {
        ok(`answered "${c.text ?? ''}"`);
        note(`model used: ${c.model ?? '(not reported)'}`);
        note(`provider: ${c.provider ?? '(not reported)'}${c.provider && c.provider !== 'bedrock' ? '   <-- NOT bedrock: the call did not go through Bedrock' : ''}`);
        note(`total_cost_usd: ${c.costUsd ?? '(not reported)'} (Claude Code's own estimate)`);
        if (c.provider && c.provider !== 'bedrock') failed++;
      }
    }
  } else console.log('4. (skipped: add --call to make one tiny Haiku call through Claude Code)');

  console.log('5. AWS cost, yesterday and today (read-only)');
  const today = new Date();
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  const ce = aws(['ce', 'get-cost-and-usage', '--time-period', `Start=${ymd(yesterday)},End=${ymd(tomorrow)}`, '--granularity', 'DAILY', '--metrics', 'UnblendedCost'], 'us-east-1');
  if (!ce.ok) note(`skipped: ${classifyAwsFailure(ce.err, ce)} (the cost view needs ce:GetCostAndUsage; not required)`);
  else {
    const total = parseCostTotal(ce.out);
    note(`ACCOUNT-WIDE (may include other users), not this app's spend: ${total === undefined ? 'unreadable' : `$${total.toFixed(2)}`} for ${ymd(yesterday)} and ${ymd(today)}`);
    note("this app's own estimate is in data/bedrock-spend.jsonl and system_status");
  }
  return finish(failed);
}

function finish(failed: number): number {
  console.log(failed ? `\n${failed} problem(s): Bedrock cannot be used until they are fixed.` : '\nAll checks passed: Bedrock can run agents from this host.');
  return failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = preflight(parseArgs(process.argv.slice(2)));
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 2;
  }
}
