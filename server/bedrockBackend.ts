// The Bedrock backend's controller (w38, docs/bedrock.md): the rules are in bedrock.ts; this keeps what changes. Which
// backend each account's agents are on (the Auto state, persisted per account), what Bedrock has cost (a JSON-lines
// ledger, rebuilt at start), whether the AWS login works (a probe), and the one-line notices to the owner's orchestrator.
// Nothing secret is read, kept or printed here: Bedrock runs on a profile NAME in ~/.aws, the probe's answer is reduced to
// a fixed sentence (bedrockPreflight.ts) and the ledger holds tokens and dollars.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { BackendStatus, SessionInfo } from '../shared/types.ts';
import { HOST_ROLES, roleNames, type Config, type HostRole } from './config.ts';
import {
  AWS_AUTH_ERROR,
  BEDROCK_STRIPPED_ENV,
  BUDGET_WARN_FRACTION,
  awsFix,
  bedrockModels,
  bedrockSettings,
  decideBackend,
  estimateUsd,
  localDay,
  localWeekStart,
  bedrockSupportsModel,
  counterRestarted,
  percentNow,
  tokenDelta,
  withBedrock,
  withPlan,
  type AutoState,
  type BedrockSettings,
  type Decision,
  type PlanView,
  type TokenUsage,
} from './bedrock.ts';
import { classifyAwsFailure } from './bedrockPreflight.ts';
import { checkObject, readJsonDurable, writeJsonDurable } from './durable.ts';
import { userToken } from './identity.ts';
import { modelEnv } from './models.ts';
import { hostAccount, hostRole } from './secrets.ts';
import { HOST_LOGIN, hostToken, tokenKey, type UsageEntry } from './usage.ts';

/** A new switch to Bedrock waits for a probe at most this old; while it is wanted the probe repeats at the longer interval. */
export const PROBE_FRESH_MS = 2 * 60_000;
export const PROBE_EVERY_MS = 5 * 60_000;
/** How often the decision is looked at again, whatever else happens (the plan's numbers move without telling us). */
export const TICK_MS = 30_000;
/** A probe that failed without saying why (a timeout, a network blip) is tried again this soon; the second one in a row counts. */
export const PROBE_RETRY_MS = 10_000;
/** Two refusals of the model within this window... */
export const ACCESS_ERROR_WINDOW_MS = 10 * 60_000;
const ACCESS_ERROR_DEDUPE_MS = 2000;
/** ...make Bedrock unavailable for this long, whatever the AWS login probe says. */
export const ACCESS_COOLDOWN_MS = 30 * 60_000;
/** A Bedrock turn that failed because the role may not use the model (not because the login expired). */
const MODEL_REFUSED = /AccessDeniedException|not authorized|model access|ValidationException[^\n]{0,200}model/i;
/** Probe answers that say nothing about the login itself: they need to repeat before Bedrock is given up. */
const TRANSIENT_PROBE = new Set(['the AWS check timed out', 'the AWS check failed']);
const TITLE_CHARS = 80;
/** The cumulative-usage memory is bounded; the oldest entries go first. */
const MAX_LAST = 4000;
const TAIL = 30;

export interface ProbeResult {
  ok: boolean;
  /** One fixed sentence (classifyAwsFailure), never the CLI's own text. */
  problem?: string;
}
export type Probe = (profile: string, region: string) => Promise<ProbeResult>;

/** `aws sts get-caller-identity`: only whether it worked, and why not. Its output is dropped unread. */
export const awsProbe: Probe = (profile, region) => {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const k of BEDROCK_STRIPPED_ENV) delete env[k];
  return new Promise((resolve) => {
    execFile('aws', ['sts', 'get-caller-identity', '--profile', profile, '--region', region, '--output', 'json'], { timeout: 20_000, env, maxBuffer: 1 << 20, windowsHide: true }, (err, _stdout, stderr) => {
      if (!err) return resolve({ ok: true });
      const e = err as NodeJS.ErrnoException & { killed?: boolean };
      resolve({ ok: false, problem: classifyAwsFailure(String(stderr ?? ''), e) });
    });
  });
};

/** One line of data/bedrock-spend.jsonl: a turn's estimated cost. */
export interface SpendLine {
  t: string;
  session: string;
  title: string;
  role: string;
  model: string;
  in: number;
  out: number;
  cacheRead: number;
  cacheWrite: number;
  usd: number;
}

interface Health {
  ok: boolean;
  /** 0: never checked. */
  checkedAt: number;
  problem?: string;
}

interface StateFile {
  /** Auto's state per account key. */
  auto: Record<string, AutoState>;
  /** What each account's agents were last said to be on, and since when. */
  active: Record<string, { backend: Decision['backend']; since: string }>;
  /** The cumulative usage last seen per "<session>|<model id>": a result carries the session's running total. */
  last: Record<string, { tokens: TokenUsage; costUsd: number }>;
  notified: { warnDay?: string; capDay?: string; problem?: string };
  /** Bedrock refused the model twice: unavailable until then (epoch ms), with the sentence that says so. */
  refused?: { until: number; problem: string };
}

const emptyState = (): StateFile => ({ auto: {}, active: {}, last: {}, notified: {} });

export interface BackendDeps {
  cfg: Pick<Config, 'bedrock' | 'claudeAccounts' | 'claudeEnv' | 'userClaudeEnv' | 'modelPins' | 'defaultModel' | 'orchestrator'> & { dataDir: string };
  /** The usage tracker's entries (UsageTracker.entries): the plan meters of each account. */
  usage: () => ReadonlyMap<string, UsageEntry>;
  /** One line to the owner's orchestrator. */
  notify: (text: string) => void;
  /** The status (or the spend) changed: broadcast it. */
  changed?: () => void;
  /** An account's backend changed: messages held for the backend may go now. */
  switched?: () => void;
  /** The person a session works for, whose own token (if any) keeps it off Bedrock. */
  whoFor?: (info: SessionInfo) => { userId: string } | undefined;
  probe?: Probe;
  now?: () => number;
  /** The server's own environment, for the host token (default process.env). */
  env?: Record<string, string | undefined>;
  log?: (line: string) => void;
}

/** The part of a result message the ledger reads. */
interface ResultLike {
  modelUsage?: Record<string, { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number; costUSD?: number; provider?: string }>;
  is_error?: boolean;
  subtype?: string;
  result?: string;
  errors?: string[];
}

const usd = (n: number) => `$${n.toFixed(n >= 100 ? 0 : 2)}`;

export class BedrockBackend {
  private readonly d: BackendDeps;
  private readonly now: () => number;
  private readonly stateFile: string;
  private readonly ledgerFile: string;
  private state: StateFile = emptyState();
  private health: Health = { ok: false, checkedAt: 0 };
  private probing = false;
  /** Probe failures in a row that did not say why (timeouts, network), and when the next try may start. */
  private blips = 0;
  private retryAt = 0;
  /** When Bedrock refused the model lately (epoch ms). */
  private accessErrors: number[] = [];
  /** The profile and region the last probe was for: another one makes its answer worthless. */
  private probedFor?: string;
  private timer?: NodeJS.Timeout;
  private view?: { decisions: Map<HostRole, Decision>; keys: Map<HostRole, string> };
  private lastShape = '';
  private readonly probe: Probe;
  /** The ledger in memory: dollars per local day, per session, and the last lines. */
  private readonly days = new Map<string, number>();
  private readonly sessionUsd = new Map<string, { usd: number; title: string; turns: number }>();
  private tail: SpendLine[] = [];

  constructor(deps: BackendDeps) {
    this.d = deps;
    this.now = deps.now ?? Date.now;
    this.probe = deps.probe ?? awsProbe;
    this.stateFile = path.join(deps.cfg.dataDir, 'bedrock-state.json');
    this.ledgerFile = path.join(deps.cfg.dataDir, 'bedrock-spend.jsonl');
    try {
      const f = readJsonDurable<Partial<StateFile>>(this.stateFile, { check: checkObject });
      if (f) this.state = { ...emptyState(), ...f, notified: { ...f.notified } };
    } catch {
      // first run
    }
    this.loadLedger();
  }

  private get settings(): BedrockSettings {
    return bedrockSettings(this.d.cfg);
  }

  private log(line: string) {
    (this.d.log ?? ((l) => console.log(l)))(line);
  }

  // ---------------------------------------------------------------- the ledger

  private loadLedger() {
    let text = '';
    try {
      text = fs.readFileSync(this.ledgerFile, 'utf8');
    } catch {
      return;
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        this.count(JSON.parse(line) as SpendLine);
      } catch {
        // a torn last line (the server stopped mid-write); the rest stands
      }
    }
  }

  private count(l: SpendLine) {
    const t = Date.parse(l.t);
    if (!Number.isFinite(t) || !Number.isFinite(l.usd)) return;
    const day = localDay(t);
    this.days.set(day, (this.days.get(day) ?? 0) + l.usd);
    const s = this.sessionUsd.get(l.session) ?? { usd: 0, title: l.title, turns: 0 };
    this.sessionUsd.set(l.session, { usd: s.usd + l.usd, title: l.title || s.title, turns: s.turns + 1 });
    this.tail.push(l);
    if (this.tail.length > TAIL) this.tail.shift();
  }

  /** Estimated Bedrock dollars so far this local day. */
  spentToday(): number {
    return this.days.get(localDay(this.now())) ?? 0;
  }

  spentThisWeek(): number {
    const from = localWeekStart(this.now());
    let sum = 0;
    for (const [day, v] of this.days) if (day >= from) sum += v;
    return sum;
  }

  /** The sessions that cost the most, for GET /api/backend. */
  topSessions(n = 20) {
    return [...this.sessionUsd.entries()]
      .map(([session, v]) => ({ session, title: v.title, usd: v.usd, turns: v.turns }))
      .sort((a, b) => b.usd - a.usd)
      .slice(0, n);
  }

  /** The last spend lines, newest last. */
  recentSpend(n = TAIL): SpendLine[] {
    return this.tail.slice(-n);
  }

  /**
   * A Bedrock session's result (AgentSession emits 'bedrockResult'). modelUsage is the session's running total per
   * model, and a resumed session's first result already carries what came before, so each model's tokens are priced as
   * the difference from the last total seen (kept here and in the state file). A first result with nothing to subtract
   * from counts whole: the cap errs toward counting too much.
   */
  recordResult(session: { info: SessionInfo }, m: ResultLike) {
    const info = session.info;
    const s = this.settings;
    let any = false;
    for (const [model, e] of Object.entries(m.modelUsage ?? {})) {
      // The process is known to be Bedrock: an entry counts unless it says another provider. A missing provider is not $0.
      if (e.provider && e.provider !== 'bedrock') continue;
      const cur: TokenUsage = { inputTokens: e.inputTokens ?? 0, outputTokens: e.outputTokens ?? 0, cacheReadInputTokens: e.cacheReadInputTokens ?? 0, cacheCreationInputTokens: e.cacheCreationInputTokens ?? 0 };
      const key = `${info.id}|${model}`;
      const prev = this.state.last[key];
      const delta = tokenDelta(cur, prev?.tokens);
      const sdk = e.costUSD ?? 0;
      // A counter that went down in any field belongs to a new process (or a reset): its whole value counts, on top of what was counted before.
      const fresh = counterRestarted(cur, prev?.tokens);
      const sdkDelta = prev && !fresh && sdk >= prev.costUsd ? sdk - prev.costUsd : sdk;
      delete this.state.last[key]; // re-inserted last: the oldest go first when the memory is trimmed
      this.state.last[key] = { tokens: cur, costUsd: sdk };
      if (!delta.inputTokens && !delta.outputTokens && !delta.cacheReadInputTokens && !delta.cacheCreationInputTokens) continue;
      const cost = estimateUsd(model, delta, s.regionPrefix, sdkDelta);
      const line: SpendLine = { t: new Date(this.now()).toISOString(), session: info.id, title: info.title.slice(0, TITLE_CHARS), role: hostRole(info.kind), model, in: delta.inputTokens, out: delta.outputTokens, cacheRead: delta.cacheReadInputTokens, cacheWrite: delta.cacheCreationInputTokens, usd: cost };
      try {
        fs.appendFileSync(this.ledgerFile, JSON.stringify(line) + '\n');
      } catch (err) {
        this.log(`bedrock: could not append to the spend ledger: ${(err as Error).message}`);
      }
      this.count(line);
      any = true;
    }
    const keys = Object.keys(this.state.last);
    if (keys.length > MAX_LAST) for (const k of keys.slice(0, keys.length - MAX_LAST)) delete this.state.last[k];
    if (any) info.bedrockCostUsd = this.sessionUsd.get(info.id)?.usd;
    this.save();
    // A failed turn that says the AWS login is the problem: look at once, not at the next 5-minute probe.
    const text = m.is_error || (m.subtype && m.subtype !== 'success') ? [m.result, ...(m.errors ?? [])].filter(Boolean).join(' ') : '';
    if (text) this.bedrockError(text);
    this.evaluate();
    this.d.changed?.();
  }

  /** A Bedrock turn failed with this text (a result, or the process threw): AWS credentials get probed now when it says so. */
  bedrockError(text: string) {
    const refused = MODEL_REFUSED.exec(text);
    if (refused) this.modelRefused(refused[0]);
    if (AWS_AUTH_ERROR.test(text)) void this.checkAws();
  }

  /** Bedrock said no to the model: twice within ACCESS_ERROR_WINDOW_MS and it is unavailable for ACCESS_COOLDOWN_MS (the AWS login probe cannot lift that). */
  private modelRefused(what: string) {
    const now = this.now();
    // One failed turn can be reported twice (its result, then the process's error): that is one refusal.
    if (this.accessErrors.length && now - this.accessErrors[this.accessErrors.length - 1] < ACCESS_ERROR_DEDUPE_MS) return;
    this.accessErrors = [...this.accessErrors.filter((t) => now - t < ACCESS_ERROR_WINDOW_MS), now];
    if (this.accessErrors.length < 2 || (this.state.refused && this.state.refused.until > now)) return;
    const kind = /ValidationException/i.test(what) ? 'ValidationException' : /AccessDenied/i.test(what) ? 'AccessDeniedException' : /model access/i.test(what) ? 'no model access' : 'not authorized';
    this.state.refused = { until: now + ACCESS_COOLDOWN_MS, problem: `Bedrock refused the model (${kind}): ask your AWS admin for bedrock:InvokeModel on the Claude inference profiles in ${this.settings.region}` };
    this.accessErrors = [];
    this.save();
    this.evaluate();
    this.d.changed?.();
  }

  /** The refusal still in force (it ends by itself), or undefined. */
  private refusal(): string | undefined {
    const r = this.state.refused;
    if (!r) return undefined;
    if (this.now() >= r.until) {
      delete this.state.refused;
      return undefined;
    }
    return r.problem;
  }

  // ---------------------------------------------------------------- AWS health

  /** The last probe, cached. */
  awsHealth(): Readonly<Health> {
    return this.health;
  }

  /** Probe the profile now (once at a time). Resolves when the decision has been looked at again. */
  async checkAws(): Promise<void> {
    const s = this.settings;
    if (!s.profile || this.probing) return;
    this.probing = true;
    let r: ProbeResult;
    try {
      r = await this.probe(s.profile, s.region);
    } catch {
      r = { ok: false, problem: 'the AWS check failed' };
    } finally {
      this.probing = false;
    }
    // A profile or region changed while it ran: its answer is for the old one.
    if (`${this.settings.profile}|${this.settings.region}` !== `${s.profile}|${s.region}`) {
      this.evaluate();
      return;
    }
    this.probedFor = `${s.profile}|${s.region}`;
    // One timeout or network blip is not an expired login: it takes two in a row. A clear answer counts at once.
    const problem = r.problem ?? 'the AWS check failed';
    if (!r.ok && TRANSIENT_PROBE.has(problem) && ++this.blips < 2) {
      this.retryAt = this.now() + PROBE_RETRY_MS;
      this.evaluate();
      return;
    }
    this.blips = 0;
    this.health = { ok: r.ok, checkedAt: this.now(), ...(r.ok ? {} : { problem }) };
    this.evaluate();
    this.d.changed?.();
  }

  /** Why Bedrock cannot be used for an account now, or undefined (decideBackend's `unavailable`). */
  private unavailable(key: string): string | undefined {
    const s = this.settings;
    if (!s.profile) return 'no AWS profile is set (config bedrock.profile)';
    const refused = this.refusal();
    if (refused) return refused;
    if (this.health.checkedAt && !this.health.ok) return this.health.problem ?? 'the AWS check failed';
    // A switch to Bedrock needs an ok probe no older than PROBE_FRESH_MS; one already on it keeps going on the 5-minute probe.
    const fresh = this.health.ok && this.now() - this.health.checkedAt <= PROBE_FRESH_MS;
    if (!fresh && this.state.active[key]?.backend !== 'bedrock') return 'checking that the AWS login works';
    return undefined;
  }

  /** The problem to report (not the transient "checking"), or undefined. */
  private problem(): string | undefined {
    // Not being set up is no problem unless Bedrock was asked for by name.
    if (!this.settings.profile) return this.settings.mode === 'bedrock' ? 'no AWS profile is set (config bedrock.profile)' : undefined;
    const refused = this.refusal();
    if (refused) return refused;
    return this.health.checkedAt && !this.health.ok ? (this.health.problem ?? 'the AWS check failed') : undefined;
  }

  // ---------------------------------------------------------------- the decision

  /** The account key the agents of `role` run on: the host login, or the host token. */
  accountKey(role: HostRole): string {
    const tok = hostToken(this.d.cfg, this.d.env ?? process.env);
    return hostAccount(this.d.cfg, role) === 'login' || !tok ? HOST_LOGIN : tokenKey(tok);
  }

  private planView(key: string): PlanView | undefined {
    const u = this.d.usage().get(key)?.usage;
    if (!u || !u.available) return undefined;
    const m = (x: { percent: number; resetsAt?: string } | undefined) => (x ? { percent: x.percent, ...(x.resetsAt ? { resetsAt: x.resetsAt } : {}) } : undefined);
    return { session: m(u.session), weekly: m(u.weekly) };
  }

  /**
   * Look at the decision of every account again, keep the Auto state, and say what changed: a notice per switch, the
   * cap's and the AWS login's once. Called by apply/wantFor/gateFor, the tick, a new usage reading, a result and a
   * settings change. Returns each role's decision.
   */
  evaluate(): Map<HostRole, Decision> {
    const s = this.settings;
    const now = this.now();
    const spent = this.spentToday();
    // Another profile or region (set_app_config): the old probe says nothing about it.
    if (this.probedFor && this.probedFor !== `${s.profile}|${s.region}`) {
      this.probedFor = undefined;
      this.health = { ok: false, checkedAt: 0 };
      delete this.state.notified.problem;
      this.blips = 0;
      this.retryAt = 0;
      this.accessErrors = [];
      delete this.state.refused; // another profile or region may be allowed the model
      // An account on Bedrock with the old profile is a new switch with this one: it waits for its probe.
      for (const [key, a] of Object.entries(this.state.active)) if (a.backend === 'bedrock') delete this.state.active[key];
    }
    const decisions = new Map<HostRole, Decision>();
    const keys = new Map<HostRole, string>();
    const byKey = new Map<string, { roles: HostRole[]; decision: Decision }>();
    let dirty = false;
    for (const role of HOST_ROLES) {
      const key = this.accountKey(role);
      keys.set(role, key);
      const seen = byKey.get(key);
      if (seen) {
        seen.roles.push(role);
        decisions.set(role, seen.decision);
        continue;
      }
      const decision = decideBackend({ settings: s, plan: this.planView(key), state: this.state.auto[key] ?? {}, spentToday: spent, now, unavailable: this.unavailable(key) });
      if (JSON.stringify(this.state.auto[key] ?? {}) !== JSON.stringify(decision.state)) {
        if (Object.keys(decision.state).length) this.state.auto[key] = decision.state;
        else delete this.state.auto[key];
        dirty = true;
      }
      byKey.set(key, { roles: [role], decision });
      decisions.set(role, decision);
    }
    this.view = { decisions, keys };

    const split = byKey.size > 1;
    let switchTold = false;
    let switched = false;
    for (const [key, { roles, decision }] of byKey) {
      const prev = this.state.active[key];
      if (prev?.backend === decision.backend) continue;
      this.state.active[key] = { backend: decision.backend, since: new Date(now).toISOString() };
      dirty = true;
      switched = true;
      if (!prev && decision.backend === 'plan') continue; // the plan is where agents start
      switchTold = true;
      this.say(this.switchNotice(split ? roles : undefined, decision, s));
    }

    // Without a profile Bedrock is not set up, which says nothing unless it was asked for by name (mode "bedrock").
    const wanted = (!!s.profile || s.mode === 'bedrock') && [...byKey.values()].some(({ decision }) => decision.backend === 'bedrock' || decision.degraded);
    const problem = this.problem();
    if (problem && wanted && this.state.notified.problem !== problem) {
      this.state.notified.problem = problem;
      dirty = true;
      this.say(`[backend] Bedrock is wanted but cannot be used: ${problem}. The plan carries the work meanwhile. To fix it: ${this.fixFor(problem)}. I will say when it works again.`);
    } else if (!problem && this.health.ok && this.state.notified.problem) {
      delete this.state.notified.problem;
      dirty = true;
      this.say(`[backend] AWS access works again (profile ${s.profile}).`);
    }

    const today = localDay(now);
    if (s.dailyBudgetUsd > 0) {
      if (spent >= s.dailyBudgetUsd) {
        if (wanted && this.state.notified.capDay !== today) {
          this.state.notified.capDay = today;
          dirty = true;
          // The switch's own notice already says the cap is why.
          const d = [...byKey.values()].find(({ decision }) => decision.degraded)?.decision;
          if (!switchTold) this.say(`[backend] Today's Bedrock cap is spent (${usd(spent)} of ${usd(s.dailyBudgetUsd)}). ${d?.backend === 'blocked' ? 'The plan is at its limit too, so new agent work waits until the plan resets or the cap day rolls over.' : 'Agents run on your Claude plan until tomorrow.'}`);
        }
      } else if (spent >= BUDGET_WARN_FRACTION * s.dailyBudgetUsd && this.state.notified.warnDay !== today) {
        this.state.notified.warnDay = today;
        dirty = true;
        this.say(`[backend] Bedrock spend today is ${usd(spent)}, ${Math.round((spent / s.dailyBudgetUsd) * 100)}% of the ${usd(s.dailyBudgetUsd)} daily cap. At the cap agents go back to your Claude plan.`);
      }
    }

    if (dirty) this.save();
    // Probe when Bedrock is wanted and the last answer is too old for what it is needed for.
    if (s.profile && wanted && !this.probing) {
      const age = now - this.health.checkedAt;
      const onBedrock = [...byKey.keys()].every((k) => this.state.active[k]?.backend === 'bedrock');
      if (now >= this.retryAt && (!this.health.checkedAt || age >= PROBE_EVERY_MS || (!onBedrock && age > PROBE_FRESH_MS))) void this.checkAws();
    }
    const shape = JSON.stringify(this.status());
    if (shape !== this.lastShape) {
      this.lastShape = shape;
      this.d.changed?.();
    }
    if (switched) this.d.switched?.();
    return decisions;
  }

  private fixFor(problem: string): string {
    const s = this.settings;
    if (!s.profile) return 'ask me to set bedrock.profile to your AWS SSO profile (see `aws configure list-profiles`)';
    if (/refused the model/.test(problem)) return 'ask your AWS admin to allow the Claude models; Bedrock is tried again by itself in half an hour';
    if (/not installed/.test(problem)) return 'install the AWS CLI on this host';
    if (/profile was not found/.test(problem)) return `add the profile to ~/.aws/config (\`aws configure sso --profile ${s.profile}\`) or point bedrock.profile at an existing one`;
    return awsFix(s.profile, problem);
  }

  private switchNotice(roles: HostRole[] | undefined, d: Decision, s: BedrockSettings): string {
    const who = roles ? `Agents (${roleNames(roles)})` : 'Agents';
    const back = `Back to your plan when usage is under ${s.thresholdPercent - s.resumeMarginPercent}% or the window resets.`;
    if (d.backend === 'bedrock') return `[backend] ${who} now run on SketchUp's Bedrock (${d.state.why ?? d.reason}).${d.state.onBedrock ? ` ${back}` : ''} Bedrock bills the company, not your plan; the daily cap is ${s.dailyBudgetUsd > 0 ? usd(s.dailyBudgetUsd) : 'off'}.`;
    if (d.backend === 'plan') return `[backend] ${who === 'Agents' ? 'Back' : `${who}: back`} on your Claude plan (${d.reason}).`;
    return `[backend] New work for ${who.toLowerCase()} is on hold (${d.reason}). Messages wait and go as soon as the cap day rolls over or the plan has room.`;
  }

  /** Send a notice after the current call returns (it may start the orchestrator, which asks for its options again). */
  private say(text: string) {
    this.log(text);
    queueMicrotask(() => {
      try {
        this.d.notify(text);
      } catch (e) {
        this.log(`bedrock: could not tell the owner: ${(e as Error).message}`);
      }
    });
  }

  // ---------------------------------------------------------------- what the sessions ask

  /** Whether the person this session works for has a Claude token of their own (config userClaudeEnv): then it never runs on Bedrock. */
  private ownsToken(info: SessionInfo): boolean {
    return !!userToken(this.d.cfg, (this.d.whoFor?.(info) ?? info.requestedBy)?.userId);
  }

  /** The model a session of this info runs: its own, else its role's default. */
  private modelOf(info: SessionInfo): string | undefined {
    return info.model ?? this.defaultModel(hostRole(info.kind));
  }

  private defaultModel(role: HostRole): string | undefined {
    return role === 'orchestrator' ? this.d.cfg.orchestrator?.model : this.d.cfg.defaultModel;
  }

  /** `env` as a plan process gets it: nothing of Bedrock, whatever the server inherited, and the model pins (config modelPins, claudeEnv over them) back. */
  private planEnv<E extends Record<string, string | undefined>>(env: E, userId?: string): E {
    const pins = (from: Record<string, string> | undefined) => Object.fromEntries(Object.entries(from ?? {}).filter(([k]) => /^ANTHROPIC_DEFAULT_(OPUS|SONNET|HAIKU)_MODEL$/.test(k)));
    return { ...withPlan(env), ...modelEnv(this.d.cfg), ...pins(this.d.cfg.claudeEnv), ...pins(userId ? this.d.cfg.userClaudeEnv?.[userId] : undefined) } as E;
  }

  /**
   * The environment an agent of `role` on this host starts with: `env` with the Bedrock variables when the decision is
   * Bedrock, else on the plan (what the server inherited of Bedrock is removed). Only an agent that has no token of its
   * own and runs a model Bedrock has an id for goes to Bedrock: the person's own token always keeps the plan.
   */
  apply<E extends Record<string, string | undefined>>(role: HostRole, env: E, requester?: { userId: string }, model?: string): E {
    if (requester && userToken(this.d.cfg, requester.userId)) return this.planEnv(env, requester.userId);
    const d = this.evaluate().get(role);
    return d?.backend === 'bedrock' && bedrockSupportsModel(model ?? this.defaultModel(role)) ? withBedrock(env, this.settings) : this.planEnv(env, requester?.userId);
  }

  /**
   * The backend a process of this session would start on now: for recycling an idle one. `blocked`: neither backend has
   * room, so a Bedrock process must still come off Bedrock. Undefined when it does not apply.
   */
  wantFor(info: SessionInfo): { backend: 'plan' | 'bedrock'; reason: string; refresh?: true } | undefined {
    if (info.machineId || this.ownsToken(info)) return undefined;
    const model = this.modelOf(info);
    if (!bedrockSupportsModel(model)) return { backend: 'plan', reason: `${model ?? 'its model'} has no Bedrock id, so it stays on your Claude plan` };
    const d = this.evaluate().get(hostRole(info.kind));
    if (!d) return undefined;
    // A standing agent's run is for a person this session does not know (their own token would keep the plan): its idle
    // process is left to the idle reaper, and the next process starts on the right backend. Only coming off Bedrock is safe to do.
    if (info.kind === 'standing' && d.backend === 'bedrock') return undefined;
    if (d.backend === 'blocked') return { backend: 'plan', reason: d.reason };
    if (d.backend === 'bedrock') {
      // The same backend on another profile or region (set_app_config): the process is stale all the same.
      const s = this.settings;
      const stale = info.backend === 'bedrock' && ((info.account !== undefined && info.account !== `bedrock:${s.profile}`) || (info.bedrockRegion !== undefined && info.bedrockRegion !== s.region));
      return { backend: 'bedrock', reason: stale ? 'the Bedrock profile or region changed' : (d.state.why ?? d.reason), ...(stale ? { refresh: true as const } : {}) };
    }
    return { backend: d.backend, reason: d.reason };
  }

  /** Why a message to this session must wait (both backends are out of room), or undefined. */
  gateFor(info: SessionInfo): string | undefined {
    // A session Bedrock cannot run (its model has no id) is on the plan whatever the decision: it is not this gate's.
    if (info.machineId || this.ownsToken(info) || !bedrockSupportsModel(this.modelOf(info))) return undefined;
    const d = this.evaluate().get(hostRole(info.kind));
    return d?.backend === 'blocked' ? d.reason : undefined;
  }

  // ---------------------------------------------------------------- what people see

  status(): BackendStatus {
    const s = this.settings;
    if (!this.view) this.view = { decisions: new Map(), keys: new Map() };
    // Workers are most of the agents: their account speaks for the badge; statusLines names a role that differs.
    const d = this.view.decisions.get('workers') ?? this.evaluateQuietly();
    const key = this.view.keys.get('workers') ?? this.accountKey('workers');
    const sessionPercent = percentNow(this.planView(key)?.session, this.now());
    const problem = this.problem();
    return {
      mode: s.mode,
      active: d.backend,
      reason: d.reason,
      configured: !!s.profile,
      ...(s.profile ? { profile: s.profile } : {}),
      region: s.region,
      regionPrefix: s.regionPrefix,
      thresholdPercent: s.thresholdPercent,
      resumePercent: s.thresholdPercent - s.resumeMarginPercent,
      ...(sessionPercent !== undefined ? { sessionPercent: Math.round(sessionPercent * 10) / 10 } : {}),
      ...(this.state.active[key]?.since ? { since: this.state.active[key].since } : {}),
      ...(problem && s.profile ? { problem } : {}),
      spend: { day: localDay(this.now()), todayUsd: round2(this.spentToday()), weekUsd: round2(this.spentThisWeek()), dailyBudgetUsd: s.dailyBudgetUsd },
      ...(s.profile ? { models: bedrockModels(s) } : {}),
    };
  }

  /** status() before any evaluation: decide without announcing anything. */
  private evaluateQuietly(): Decision {
    const s = this.settings;
    const key = this.accountKey('workers');
    return decideBackend({ settings: s, plan: this.planView(key), state: this.state.auto[key] ?? {}, spentToday: this.spentToday(), now: this.now(), unavailable: this.unavailable(key) });
  }

  /** system_status's lines: where the agents run, what Bedrock costs, and a WARNING when it is not usable. */
  statusLines(): string[] {
    const s = this.settings;
    const st = this.status();
    const label = st.active === 'bedrock' ? 'Bedrock' : st.active === 'plan' ? 'your Claude plan' : 'ON HOLD (neither Bedrock nor the plan can take new work)';
    const cap = s.dailyBudgetUsd > 0 ? `${usd(s.dailyBudgetUsd)} (${Math.round((st.spend.todayUsd / s.dailyBudgetUsd) * 100)}%)` : 'no cap';
    const lines = [
      `Backend: ${label} (${s.mode}: ${st.reason})${s.profile ? ` · profile ${s.profile}, region ${s.region}, ${s.regionPrefix}. ids` : ' · Bedrock is not set up (config bedrock.profile)'} · Bedrock spend today ${usd(st.spend.todayUsd)} of ${cap}, this week ${usd(st.spend.weekUsd)}`,
    ];
    // Another role on another account may differ (the orchestrator on the login, the workers on the token).
    if (this.view) {
      for (const role of HOST_ROLES) {
        const d = this.view.decisions.get(role);
        if (d && d.backend !== st.active) lines.push(`Backend for ${roleNames([role])}: ${d.backend === 'bedrock' ? 'Bedrock' : d.backend === 'plan' ? 'your Claude plan' : 'ON HOLD'} (${d.reason})`);
      }
    }
    const problem = this.problem();
    if (problem && (st.active !== 'plan' || s.mode === 'bedrock' || [...(this.view?.decisions.values() ?? [])].some((d) => d.degraded))) lines.push(`WARNING: Bedrock cannot be used: ${problem}; the plan carries the work. To fix it: ${this.fixFor(problem)}.`);
    else if (st.active === 'blocked') lines.push(`WARNING: ${st.reason}.`);
    else if (s.dailyBudgetUsd > 0 && st.spend.todayUsd >= BUDGET_WARN_FRACTION * s.dailyBudgetUsd) lines.push(`WARNING: Bedrock spend today is at ${Math.round((st.spend.todayUsd / s.dailyBudgetUsd) * 100)}% of the daily cap.`);
    return lines;
  }

  // ---------------------------------------------------------------- lifecycle

  /** Probe once at start (when a profile is set) and look at the decision every TICK_MS. */
  start() {
    if (this.timer) return;
    if (this.settings.profile) void this.checkAws();
    this.evaluate();
    this.timer = setInterval(() => this.evaluate(), TICK_MS);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private save() {
    try {
      writeJsonDurable(this.stateFile, this.state, { indent: 1 });
    } catch (e) {
      this.log(`bedrock: could not save its state: ${(e as Error).message}`);
    }
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100;
