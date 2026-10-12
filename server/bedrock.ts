// The Bedrock backend (w38, docs/bedrock.md): when the agents run on SketchUp's AWS Bedrock account instead of the
// Claude plan. Everything here is pure, so the rules (when to switch, when to come back, what the daily cap does, which
// environment a Bedrock process gets, what a turn cost) are tested without AWS or a clock. The server's state and the
// notices live in bedrockBackend.ts.
//
// Nothing secret is ever configured or logged here: Bedrock authenticates through an AWS profile (SSO) that lives in
// ~/.aws, so the app knows its NAME and a region, never a key.
import type { Config } from './config.ts';
import { MODEL_IDS, type ModelAlias } from './models.ts';

export type BackendMode = 'auto' | 'plan' | 'bedrock';
export const BACKEND_MODES: readonly BackendMode[] = ['auto', 'plan', 'bedrock'];
/** Where an agent's process runs: the Claude plan (the host token or login) or Bedrock. */
export type Backend = 'plan' | 'bedrock';

/** config.json "bedrock" (docs/bedrock.md). Only `profile` has no default: without it Bedrock is off. */
export interface BedrockConfig {
  /** "auto" (default): Bedrock while the plan's 5-hour usage is at `thresholdPercent` or more; "plan" / "bedrock": forced. */
  mode?: BackendMode;
  /** The AWS profile NAME in ~/.aws/config (an SSO profile). Never a key. */
  profile?: string;
  /** The AWS region, default us-west-2. */
  region?: string;
  /** Cross-region inference profile prefix: "us" (default), "global" (about 10% cheaper), "eu", "apac"…. */
  regionPrefix?: string;
  /** Auto switches to Bedrock at this 5-hour session percent (default 94). */
  thresholdPercent?: number;
  /** Auto also switches when the weekly percent reaches this (default off). */
  weeklyThresholdPercent?: number;
  /** Auto comes back to the plan once the percent is this far under the threshold (default 10 points) or its window reset. */
  resumeMarginPercent?: number;
  /** The most Bedrock may cost per local day, USD (default 200). 0 turns the cap off. */
  dailyBudgetUsd?: number;
}

export const BEDROCK_DEFAULTS = { mode: 'auto', region: 'us-west-2', regionPrefix: 'us', thresholdPercent: 94, resumeMarginPercent: 10, dailyBudgetUsd: 200 } as const;
/** The share of the daily cap at which the owner's orchestrator is told once. */
export const BUDGET_WARN_FRACTION = 0.8;

/** The settings in force: defaults under config bedrock. `profile` undefined = Bedrock is not set up. */
export interface BedrockSettings {
  mode: BackendMode;
  profile?: string;
  region: string;
  regionPrefix: string;
  thresholdPercent: number;
  weeklyThresholdPercent?: number;
  resumeMarginPercent: number;
  dailyBudgetUsd: number;
}

export function bedrockSettings(cfg: Pick<Config, 'bedrock'>): BedrockSettings {
  const b = cfg.bedrock ?? {};
  const thresholdPercent = b.thresholdPercent ?? BEDROCK_DEFAULTS.thresholdPercent;
  return {
    mode: b.mode && BACKEND_MODES.includes(b.mode) ? b.mode : BEDROCK_DEFAULTS.mode,
    ...(b.profile ? { profile: b.profile } : {}),
    region: b.region || BEDROCK_DEFAULTS.region,
    regionPrefix: b.regionPrefix ?? BEDROCK_DEFAULTS.regionPrefix,
    thresholdPercent,
    ...(b.weeklyThresholdPercent ? { weeklyThresholdPercent: b.weeklyThresholdPercent } : {}),
    // At most threshold-1: the resume line stays above 0, so a meter that has reset (0%) always comes back to the plan.
    resumeMarginPercent: Math.max(0, Math.min(b.resumeMarginPercent ?? BEDROCK_DEFAULTS.resumeMarginPercent, thresholdPercent - 1)),
    dailyBudgetUsd: b.dailyBudgetUsd ?? BEDROCK_DEFAULTS.dailyBudgetUsd,
  };
}

// ---------------------------------------------------------------- the config keys set_app_config may change

export const BEDROCK_KEYS = ['bedrock.mode', 'bedrock.profile', 'bedrock.region', 'bedrock.regionPrefix', 'bedrock.thresholdPercent', 'bedrock.weeklyThresholdPercent', 'bedrock.resumeMarginPercent', 'bedrock.dailyBudgetUsd'] as const;
export type BedrockKey = (typeof BEDROCK_KEYS)[number];
export const isBedrockKey = (k: string): k is BedrockKey => (BEDROCK_KEYS as readonly string[]).includes(k);

/** An AWS profile name, as ~/.aws/config spells it. A key (AKIA…, a long secret) is refused, not stored. */
const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.@+=,-]{0,127}$/;
// Also the other credentials someone might paste here by mistake: an Anthropic key or OAuth token (sk-ant-…, which the
// profile-name shape alone lets through), a Bedrock API key (ABSK…), a GitHub or provider token.
const AWS_KEY_LIKE = /^(AKIA|ASIA|AIDA|AROA)[A-Z0-9]{12,}$|^[A-Za-z0-9/+=]{40}$|^(sk-ant-|ABSK|ffpv1_|ghp_|gho_|github_pat_|xox[bap]-)|^sk-[A-Za-z0-9_-]{30,}$/i;
const REGION = /^[a-z]{2}(?:-[a-z]+)+-\d$/;
const PREFIXES = ['us', 'eu', 'apac', 'jp', 'au', 'global'];

const pct = (key: string, v: unknown, min: number, max: number) => {
  const n = Number(v);
  if (typeof v === 'boolean' || v === '' || !Number.isFinite(n) || n < min || n > max) throw new Error(`${key} is a number from ${min} to ${max}`);
  return n;
};

/** Validate one bedrock.* setting (set_app_config); null/undefined removes it (back to the default). Never echoes a rejected profile. `current` is the config in force, for the margin-under-threshold check. */
export function normalizeBedrockSetting(key: BedrockKey, value: unknown, current?: BedrockConfig): unknown {
  if (value === undefined || value === null) return undefined;
  switch (key) {
    case 'bedrock.mode': {
      const m = typeof value === 'string' ? value.trim().toLowerCase() : '';
      if (!BACKEND_MODES.includes(m as BackendMode)) throw new Error('bedrock.mode is "auto" (Bedrock at the usage threshold), "plan" (always your Claude plan) or "bedrock" (always Bedrock)');
      return m;
    }
    case 'bedrock.profile': {
      const p = typeof value === 'string' ? value.trim() : '';
      if (!PROFILE_NAME.test(p) || AWS_KEY_LIKE.test(p)) throw new Error('bedrock.profile is the NAME of an AWS profile in ~/.aws/config (see `aws configure list-profiles`), never a key or token; the value given is not one (not shown)');
      return p;
    }
    case 'bedrock.region': {
      const r = typeof value === 'string' ? value.trim() : '';
      if (!REGION.test(r)) throw new Error('bedrock.region is an AWS region such as "us-west-2"');
      return r;
    }
    case 'bedrock.regionPrefix': {
      const r = typeof value === 'string' ? value.trim().toLowerCase() : '';
      if (!PREFIXES.includes(r)) throw new Error(`bedrock.regionPrefix is one of ${PREFIXES.join(', ')} ("global" is about 10% cheaper; "us" keeps requests in US regions)`);
      return r;
    }
    case 'bedrock.thresholdPercent': {
      const n = pct(key, value, 1, 100);
      const margin = current?.resumeMarginPercent;
      if (margin !== undefined && margin >= n) throw new Error(`bedrock.thresholdPercent must stay above bedrock.resumeMarginPercent (${margin}), or the agents would never come back to the plan; lower the margin first`);
      return n;
    }
    case 'bedrock.weeklyThresholdPercent':
      return pct(key, value, 1, 100);
    case 'bedrock.resumeMarginPercent': {
      const n = pct(key, value, 1, 99);
      const threshold = current?.thresholdPercent ?? BEDROCK_DEFAULTS.thresholdPercent;
      if (n >= threshold) throw new Error(`bedrock.resumeMarginPercent (${n}) must be under bedrock.thresholdPercent (${threshold}): the plan's usage would have to fall to 0 or below to resume`);
      return n;
    }
    case 'bedrock.dailyBudgetUsd':
      return pct(key, value, 0, 100000);
  }
}

/** The shape check config.json gets when it loads (a hand edit): throws the first problem. */
export function checkBedrockConfig(cfg: Pick<Config, 'bedrock'>) {
  const b: unknown = cfg.bedrock;
  if (b === undefined) return;
  if (typeof b !== 'object' || b === null || Array.isArray(b)) throw new Error('config bedrock is an object, e.g. { "profile": "my-sso-profile", "region": "us-west-2" }');
  for (const [field, v] of Object.entries(b)) {
    const key = `bedrock.${field}`;
    if (!isBedrockKey(key)) throw new Error(`config bedrock.${field}: no such setting (${BEDROCK_KEYS.map((k) => k.slice(8)).join(', ')})`);
    if (v === undefined || v === null) continue;
    normalizeBedrockSetting(key, v);
  }
  const { thresholdPercent: threshold = BEDROCK_DEFAULTS.thresholdPercent, resumeMarginPercent: margin } = cfg.bedrock ?? {};
  if (typeof margin === 'number' && margin >= threshold) throw new Error(`config bedrock.resumeMarginPercent (${margin}) must be under bedrock.thresholdPercent (${threshold})`);
}

// ---------------------------------------------------------------- what a Bedrock process runs with

/** The Bedrock id of an alias: `<prefix>.anthropic.<model>`; no prefix (empty) is the bare foundation-model id. */
export function bedrockModelId(alias: ModelAlias, prefix: string): string {
  return `${prefix ? `${prefix}.` : ''}anthropic.${MODEL_IDS[alias]}`;
}

/** The three aliases' Bedrock ids, checked 2026-10-12 with `aws bedrock list-inference-profiles` (docs/bedrock.md). */
export function bedrockModels(s: Pick<BedrockSettings, 'regionPrefix'>): Record<ModelAlias, string> {
  return { opus: bedrockModelId('opus', s.regionPrefix), sonnet: bedrockModelId('sonnet', s.regionPrefix), haiku: bedrockModelId('haiku', s.regionPrefix) };
}

/**
 * Variables that would make Claude Code or the AWS SDK use something other than the named profile, or the Claude plan:
 * dropped from a Bedrock process. A key in the server's own environment must not win over the profile.
 */
export const BEDROCK_STRIPPED_ENV = [
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_BEARER_TOKEN_BEDROCK',
  'AWS_DEFAULT_REGION',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_MANTLE',
] as const;

/** The variables that make a process a Bedrock one: the profile, the region and the model ids, nothing secret. */
export function bedrockEnv(s: BedrockSettings): Record<string, string> {
  if (!s.profile) throw new Error('Bedrock has no profile (config bedrock.profile)');
  const m = bedrockModels(s);
  return {
    CLAUDE_CODE_USE_BEDROCK: '1',
    AWS_PROFILE: s.profile,
    AWS_REGION: s.region,
    ANTHROPIC_DEFAULT_OPUS_MODEL: m.opus,
    ANTHROPIC_DEFAULT_SONNET_MODEL: m.sonnet,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: m.haiku,
  };
}

/** `env` as a Bedrock process gets it: without the plan's credentials and AWS keys, with bedrockEnv over it. */
export function withBedrock<E extends Record<string, string | undefined>>(env: E, s: BedrockSettings): E {
  const out: Record<string, string | undefined> = { ...env };
  for (const k of BEDROCK_STRIPPED_ENV) delete out[k];
  return { ...out, ...bedrockEnv(s) } as E;
}

/** What a plan process must not inherit from a server started in a Bedrock shell: it would run on Bedrock past the cap, or on the wrong model ids. */
export const PLAN_STRIPPED_ENV = [
  'CLAUDE_CODE_USE_BEDROCK',
  'AWS_PROFILE',
  'AWS_REGION',
  'AWS_DEFAULT_REGION',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_BEARER_TOKEN_BEDROCK',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
] as const;

/** `env` as a plan process gets it: none of the Bedrock variables (the caller puts the model pins back). */
export function withPlan<E extends Record<string, string | undefined>>(env: E): E {
  const out: Record<string, string | undefined> = { ...env };
  for (const k of PLAN_STRIPPED_ENV) delete out[k];
  return out as E;
}

/** Whether a process environment is a Bedrock one. */
export const isBedrockEnv = (env: Record<string, string | undefined>) => env.CLAUDE_CODE_USE_BEDROCK === '1' || env.CLAUDE_CODE_USE_BEDROCK === 'true';

/** Whether a session's model can run on Bedrock: an alias with a pinned id and a price (opus, sonnet, haiku) or one of their ids. Anything else (fable…) stays on the plan. */
export function bedrockSupportsModel(model: string | undefined): boolean {
  const m = (model ?? '').trim().toLowerCase();
  return Object.hasOwn(MODEL_IDS, m) || !!aliasOf(m);
}

/** The account key of a Bedrock process (SessionInfo.account), with the profile NAME only. */
export const bedrockAccountKey = (env: Record<string, string | undefined>) => `bedrock:${env.AWS_PROFILE ?? 'default'}`;
export const isBedrockAccount = (key: string | undefined) => !!key && key.startsWith('bedrock:');

// ---------------------------------------------------------------- the decision

/** One plan meter as the decision reads it. */
export interface PlanMeterView {
  percent?: number;
  resetsAt?: string;
}
export interface PlanView {
  session?: PlanMeterView;
  weekly?: PlanMeterView;
}

/** What the controller remembers between decisions (persisted): whether auto has put this account on Bedrock. */
export interface AutoState {
  /** Auto is on Bedrock for this account since this time. */
  onBedrock?: string;
  /** Why it went (the numbers it saw). */
  why?: string;
}

/**
 * A meter's percent now: the number as polled, or 0 once its window has reset since (a number from a window that is over
 * says nothing about the new one, so a stale 97% neither keeps Bedrock on nor sends the agents there).
 */
export function percentNow(m: PlanMeterView | undefined, now: number): number | undefined {
  if (!m || m.percent === undefined) return undefined;
  const reset = m.resetsAt ? Date.parse(m.resetsAt) : NaN;
  return Number.isFinite(reset) && now >= reset ? 0 : m.percent;
}

export interface DecideInput {
  settings: BedrockSettings;
  plan?: PlanView;
  state: AutoState;
  /** Estimated Bedrock spend so far this local day, USD. */
  spentToday: number;
  now: number;
  /** Why Bedrock cannot be used right now (no profile, expired SSO), or undefined. */
  unavailable?: string;
}

export interface Decision {
  /** `blocked`: neither may start work (the Bedrock cap is reached and the plan is at its limit). */
  backend: Backend | 'blocked';
  /** One line, for the badge, system_status and the notices. */
  reason: string;
  /** The state to keep. */
  state: AutoState;
  /** True when Bedrock was wanted but could not be used, so the plan carries the work (or it is blocked). */
  degraded?: boolean;
}

const fmtPct = (n: number | undefined) => (n === undefined ? '?' : `${Math.round(n)}%`);
const usd = (n: number) => `$${n.toFixed(n >= 100 ? 0 : 2)}`;

/** Whether the plan has room left (below 100% on the session and the weekly meter, as far as they are known). */
export function planHasHeadroom(plan: PlanView | undefined, now: number): boolean {
  const s = percentNow(plan?.session, now);
  const w = percentNow(plan?.weekly, now);
  return !((s !== undefined && s >= 100) || (w !== undefined && w >= 100));
}

/**
 * Which backend new work starts on. Auto goes to Bedrock at the session threshold (or the weekly one, when set) and
 * comes back once the percent is `resumeMarginPercent` under the threshold or the window has reset: the two numbers are
 * the hysteresis, so a reading that wobbles around the threshold cannot flap it. A forced mode ignores usage. Whatever is
 * wanted, Bedrock is not used when it is unavailable (no profile, expired SSO: the plan carries the work and the reason
 * says so) or when its daily cap is spent (the plan carries the work if it has room, else the work waits: `blocked`).
 */
export function decideBackend(i: DecideInput): Decision {
  const { settings: s, plan, now } = i;
  const session = percentNow(plan?.session, now);
  const weekly = percentNow(plan?.weekly, now);
  let want: Backend = 'plan';
  let why: string;
  let state: AutoState = {};
  if (s.mode === 'plan') why = 'set to your Claude plan';
  else if (s.mode === 'bedrock') {
    want = 'bedrock';
    why = 'set to Bedrock';
  } else {
    const high = session !== undefined && session >= s.thresholdPercent ? `session usage ${fmtPct(session)} is at the ${s.thresholdPercent}% threshold` : weekly !== undefined && s.weeklyThresholdPercent !== undefined && weekly >= s.weeklyThresholdPercent ? `weekly usage ${fmtPct(weekly)} is at the ${s.weeklyThresholdPercent}% threshold` : undefined;
    const sessionBack = session === undefined || session < s.thresholdPercent - s.resumeMarginPercent;
    const weeklyBack = s.weeklyThresholdPercent === undefined || weekly === undefined || weekly < s.weeklyThresholdPercent - s.resumeMarginPercent;
    if (i.state.onBedrock) {
      // Already on Bedrock: stay until both meters are back under their resume line. An unknown reading keeps the state.
      const known = session !== undefined || (s.weeklyThresholdPercent !== undefined && weekly !== undefined);
      const back = known && sessionBack && weeklyBack;
      if (back) why = `plan usage is back to ${fmtPct(session)} (resumes under ${s.thresholdPercent - s.resumeMarginPercent}%)`;
      else {
        want = 'bedrock';
        state = { ...i.state };
        why = `${i.state.why ?? `session usage reached ${s.thresholdPercent}%`}; back to the plan under ${s.thresholdPercent - s.resumeMarginPercent}% or at the reset`;
      }
    } else if (high) {
      want = 'bedrock';
      why = high;
      state = { onBedrock: new Date(now).toISOString(), why: high };
    } else why = `plan usage ${fmtPct(session)} is under the ${s.thresholdPercent}% threshold`;
  }

  if (want === 'plan') return { backend: 'plan', reason: why, state };
  // Bedrock was wanted: can it be used?
  if (i.unavailable) return { backend: 'plan', reason: `${why}, but Bedrock is not usable (${i.unavailable}), so the plan carries the work`, state, degraded: true };
  if (s.dailyBudgetUsd > 0 && i.spentToday >= s.dailyBudgetUsd) {
    const capped = `${why}, but today's Bedrock cap is spent (${usd(i.spentToday)} of ${usd(s.dailyBudgetUsd)})`;
    return planHasHeadroom(plan, now) ? { backend: 'plan', reason: `${capped}, so the plan carries the work`, state, degraded: true } : { backend: 'blocked', reason: `${capped} and the plan is at its limit, so new work waits`, state, degraded: true };
  }
  return { backend: 'bedrock', reason: why, state };
}

// ---------------------------------------------------------------- the day, and what a turn cost

/** The host's local calendar day, "2026-10-12" (the daily cap counts from local midnight). */
export function localDay(t: number | Date): string {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** The local day starting the week the day is in (Monday), for "this week". */
export function localWeekStart(t: number | Date): string {
  const d = new Date(t);
  const back = (d.getDay() + 6) % 7;
  return localDay(new Date(d.getFullYear(), d.getMonth(), d.getDate() - back));
}

/** USD per million tokens, Bedrock on-demand, global endpoints: the AWS Price List API (AmazonBedrockFoundationModels), us-west-2, checked 2026-10-12. */
export interface Rates {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}
export const BEDROCK_RATES: Record<ModelAlias, Rates> = {
  opus: { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
  sonnet: { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.1 },
  haiku: { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 },
};
/** A regional ("us.", "eu.", "apac.") profile costs 10% more than the global one (same API, us-west-2 list, 2026-10-12). */
export const REGIONAL_MULTIPLIER = 1.1;

/** The alias a Bedrock or first-party model id belongs to, or undefined. */
export function aliasOf(modelId: string): ModelAlias | undefined {
  const m = /(opus|sonnet|haiku)-5/.exec(modelId);
  return m ? (m[1] as ModelAlias) : undefined;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}
export const noTokens = (): TokenUsage => ({ inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 });

/**
 * The estimated cost of `u` on `modelId`: tokens times the Bedrock rates (5-minute cache writes), times the regional
 * premium unless the prefix is "global". `sdkUsd` is what Claude Code itself priced the same tokens at (its list prices):
 * the larger of the two is kept, so the cap errs toward counting too much (it covers Haiku's long-context tier, which a
 * turn's totals cannot show). An unknown model uses `sdkUsd` alone, or the Opus rates.
 */
export function estimateUsd(modelId: string, u: TokenUsage, prefix: string, sdkUsd?: number): number {
  const mult = prefix === 'global' ? 1 : REGIONAL_MULTIPLIER;
  const alias = aliasOf(modelId);
  const r = alias ? BEDROCK_RATES[alias] : sdkUsd === undefined ? BEDROCK_RATES.opus : undefined;
  const table = r ? ((u.inputTokens * r.input + u.outputTokens * r.output + u.cacheCreationInputTokens * r.cacheWrite + u.cacheReadInputTokens * r.cacheRead) / 1e6) * mult : 0;
  return Math.max(table, (sdkUsd ?? 0) * mult);
}

/** Whether `cur` is a counter that started over: smaller than `prev` in any field (a new process, a reset). */
export const counterRestarted = (cur: TokenUsage, prev: TokenUsage | undefined) => !prev || cur.inputTokens < prev.inputTokens || cur.outputTokens < prev.outputTokens || cur.cacheReadInputTokens < prev.cacheReadInputTokens || cur.cacheCreationInputTokens < prev.cacheCreationInputTokens;

/** `cur` minus `prev` per field (a counter that restarted: its whole value counts, on top of what was counted before). */
export function tokenDelta(cur: TokenUsage, prev: TokenUsage | undefined): TokenUsage {
  if (!prev || counterRestarted(cur, prev)) return { ...cur };
  const d = (a: number, b: number) => Math.max(0, a - b);
  return { inputTokens: d(cur.inputTokens, prev.inputTokens), outputTokens: d(cur.outputTokens, prev.outputTokens), cacheReadInputTokens: d(cur.cacheReadInputTokens, prev.cacheReadInputTokens), cacheCreationInputTokens: d(cur.cacheCreationInputTokens, prev.cacheCreationInputTokens) };
}

/** Whether a failed turn's text says the AWS credentials are the problem (an expired SSO session, no access). */
export const AWS_AUTH_ERROR = /ExpiredToken|security token included in the request is expired|SSO (?:session|token)|Token has expired|UnrecognizedClientException|could not load credentials|Unable to locate credentials|AWS authentication failed|failed to load AWS credentials|AccessDeniedException/i;

/** What to run for an AWS problem, in words: SSO expiry is the usual one. */
export function awsFix(profile: string | undefined, problem: string): string {
  const p = profile ?? '<profile>';
  if (/expired|SSO|token|credential/i.test(problem)) return `run \`aws sso login --profile ${p}\``;
  if (/AccessDenied|not authorized|access/i.test(problem)) return `ask your AWS admin for bedrock:InvokeModel on the Claude inference profiles in this region`;
  return `check \`aws sts get-caller-identity --profile ${p}\``;
}
