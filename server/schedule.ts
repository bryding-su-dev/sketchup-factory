// Pure scheduling and budget rules for standing agents (docs/standing-agents.md). No I/O here, so
// the tests can drive every rule with a fixed clock.
import { EFFORT_LEVELS, type AutoApprove, type StandingAgent, type StandingTrigger } from '../shared/types.ts';

// ---- cron (5 fields, host local time) ----

interface CronSpec {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  /** Standard cron: when both day fields are restricted, a day matches if EITHER matches. */
  domStar: boolean;
  dowStar: boolean;
}

const FIELDS: [name: string, min: number, max: number][] = [
  ['minute', 0, 59],
  ['hour', 0, 23],
  ['day of month', 1, 31],
  ['month', 1, 12],
  ['day of week', 0, 7],
];

function parseField(text: string, [name, min, max]: (typeof FIELDS)[number]): Set<number> {
  const out = new Set<number>();
  for (const part of text.split(',')) {
    const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    if (!m) throw new Error(`cron ${name}: cannot read "${part}"`);
    const step = m[4] ? Number(m[4]) : 1;
    let lo = min;
    let hi = max;
    if (m[1] !== '*') {
      lo = Number(m[2]);
      hi = m[3] !== undefined ? Number(m[3]) : m[4] ? max : lo;
    }
    if (lo < min || hi > max || lo > hi || step < 1) throw new Error(`cron ${name}: "${part}" is outside ${min}-${max}`);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

export function parseCron(expr: string): CronSpec {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`cron "${expr}" needs 5 fields: minute hour day-of-month month day-of-week`);
  const [minute, hour, dom, month, dow] = parts.map((p, i) => parseField(p, FIELDS[i]));
  if (dow.has(7)) dow.add(0); // 7 is Sunday too
  return { minute, hour, dom, month, dow, domStar: parts[2] === '*', dowStar: parts[4] === '*' };
}

function dayMatches(c: CronSpec, d: Date) {
  const dom = c.dom.has(d.getDate());
  const dow = c.dow.has(d.getDay());
  if (c.domStar || c.dowStar) return dom && dow;
  return dom || dow;
}

/** The first minute strictly after `after` that matches `expr`, in local time. Throws if none within ~4 years. */
export function nextCron(expr: string, after: Date): Date {
  const c = parseCron(expr);
  const t = new Date(after.getTime());
  t.setSeconds(0, 0);
  t.setMinutes(t.getMinutes() + 1);
  const limit = after.getTime() + 4 * 366 * 86_400_000;
  while (t.getTime() <= limit) {
    if (!c.month.has(t.getMonth() + 1)) {
      t.setMonth(t.getMonth() + 1, 1);
      t.setHours(0, 0, 0, 0);
      continue;
    }
    if (!dayMatches(c, t)) {
      t.setDate(t.getDate() + 1);
      t.setHours(0, 0, 0, 0);
      continue;
    }
    if (!c.hour.has(t.getHours())) {
      t.setHours(t.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (!c.minute.has(t.getMinutes())) {
      t.setMinutes(t.getMinutes() + 1, 0, 0);
      continue;
    }
    return t;
  }
  throw new Error(`cron "${expr}" never matches`);
}

// ---- triggers ----

export const MIN_INTERVAL_MINUTES = 5;

/** Why a trigger is unusable, or undefined. */
export function triggerProblem(t: StandingTrigger | undefined): string | undefined {
  if (!t || typeof t !== 'object') return 'trigger is required';
  if (t.kind === 'manual') return undefined;
  if (t.kind === 'interval') {
    if (!Number.isFinite(t.minutes) || t.minutes < MIN_INTERVAL_MINUTES) return `interval must be at least ${MIN_INTERVAL_MINUTES} minutes`;
    return undefined;
  }
  if (t.kind === 'cron') {
    try {
      nextCron(t.expr, new Date());
      return undefined;
    } catch (e) {
      return (e as Error).message;
    }
  }
  return `unknown trigger kind "${(t as { kind: unknown }).kind}"`;
}

/**
 * The next scheduled run after `from`: `from` + interval, or the next cron match. `from` is the time
 * the previous run came due (or now, when the schedule is first set), so an interval keeps its
 * rhythm however long the runs take. Undefined for manual-only triggers.
 */
export function nextRunAfter(t: StandingTrigger, from: Date): Date | undefined {
  if (t.kind === 'interval') return new Date(from.getTime() + t.minutes * 60_000);
  if (t.kind === 'cron') return nextCron(t.expr, from);
  return undefined;
}

/**
 * The schedule slot after a run that came due at `due`, seen at `now`. Always after `now`, so a
 * server that was down for hours catches up with ONE run, not one per missed slot. An interval keeps
 * its phase (due + k * interval).
 */
export function advanceSchedule(t: StandingTrigger, due: Date, now: Date): Date | undefined {
  if (t.kind === 'interval') {
    const ms = t.minutes * 60_000;
    const k = Math.max(1, Math.floor((now.getTime() - due.getTime()) / ms) + 1);
    return new Date(due.getTime() + k * ms);
  }
  if (t.kind === 'cron') return nextCron(t.expr, now > due ? now : due);
  return undefined;
}

export function describeTrigger(t: StandingTrigger): string {
  if (t.kind === 'interval') return t.minutes % 60 === 0 ? `every ${t.minutes / 60} h` : `every ${t.minutes} min`;
  if (t.kind === 'cron') return `cron ${t.expr}`;
  return 'manual only';
}

// ---- budget ----

/** The host-local calendar day of `d`, "YYYY-MM-DD": the unit of the daily budget. */
export function dayKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function spentToday(a: Pick<StandingAgent, 'spend'>, now: Date): number {
  return a.spend.day === dayKey(now) ? a.spend.usd : 0;
}

/** Add `usd` to today's spend, rolling the day over when it changed. */
export function addSpend(spend: StandingAgent['spend'], usd: number, now: Date): StandingAgent['spend'] {
  const day = dayKey(now);
  return { day, usd: (spend.day === day ? spend.usd : 0) + Math.max(0, usd) };
}

/** The most one run may spend now: the per-run cap, or what is left of today's budget if less. 0 = do not run. */
export function runCap(a: Pick<StandingAgent, 'budget' | 'spend'>, now: Date): number {
  const left = a.budget.perDayUsd - spentToday(a, now);
  return Math.max(0, Math.min(a.budget.perRunUsd, left));
}

/** Below this a run is not worth starting: the first model call alone can cost more. */
export const MIN_RUN_USD = 0.05;

// ---- run admission ----

/** How long a due run may wait for a free agent slot before it is skipped. */
export const MAX_WAIT_MS = 60 * 60_000;

export type Admission =
  | { action: 'start'; capUsd: number }
  | { action: 'wait'; reason: string }
  | { action: 'skip'; reason: string };

/**
 * Whether a pending run of `agent` may start now. `busy`: the agent already has an active run (no
 * overlap). `liveAgents`/`maxAgents`: the machine-wide ceiling. `deadline`: when a run waiting for a
 * slot gives up (see waitDeadline).
 */
export function admit(opts: {
  agent: Pick<StandingAgent, 'budget' | 'spend'>;
  now: Date;
  busy: boolean;
  liveAgents: number;
  maxAgents: number;
  deadline: Date;
  /** Why the place it runs on cannot take it now (a machine that is offline); waits like a full limit. */
  unavailable?: string;
}): Admission {
  const { agent, now } = opts;
  if (opts.busy) return { action: 'skip', reason: 'previous run still going' };
  const cap = runCap(agent, now);
  if (cap < MIN_RUN_USD) return { action: 'skip', reason: `daily budget spent ($${spentToday(agent, now).toFixed(2)} of $${agent.budget.perDayUsd.toFixed(2)})` };
  if (opts.unavailable) {
    if (now.getTime() >= opts.deadline.getTime()) return { action: 'skip', reason: opts.unavailable };
    return { action: 'wait', reason: `waiting: ${opts.unavailable}` };
  }
  if (opts.liveAgents >= opts.maxAgents) {
    if (now.getTime() >= opts.deadline.getTime()) return { action: 'skip', reason: `no free agent slot (all ${opts.maxAgents} in use)` };
    return { action: 'wait', reason: `waiting for an agent slot (${opts.liveAgents}/${opts.maxAgents} in use)` };
  }
  return { action: 'start', capUsd: cap };
}

/**
 * When a pending run gives up waiting for a slot: at the agent's next scheduled occurrence (which
 * replaces it) or MAX_WAIT_MS after it began waiting, whichever is sooner.
 */
export function waitDeadline(next: Date | undefined, from: Date): Date {
  const cap = new Date(from.getTime() + MAX_WAIT_MS);
  return next && next < cap ? next : cap;
}

// ---- delegation auto-approval ----

/** Defaults for a standing agent's auto-approved delegations (Sonnet 5.5 since 2026-10-08, high effort, 3 a night). */
export const DEFAULT_AUTO: AutoApprove = {
  enabled: false,
  maxPerRun: 3,
  maxPerDay: 3,
  model: 'sonnet',
  effort: 'high',
  targets: 'sandboxes-then-machines',
  expiryHours: 8,
  exclude: ['mp-r2'],
};

export function normalizeAutoApprove(input: Partial<AutoApprove>, prev: AutoApprove | undefined, models: string[]): AutoApprove {
  const out = { ...DEFAULT_AUTO, ...prev, ...Object.fromEntries(Object.entries(input ?? {}).filter(([, v]) => v !== undefined)) } as AutoApprove;
  const int = (v: unknown, name: string, min: number, max: number) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be a whole number from ${min} to ${max}`);
    return n;
  };
  if (!models.includes(out.model)) throw new Error(`auto-approve model must be one of ${models.join(', ')}`);
  if (!EFFORT_LEVELS.includes(out.effort)) throw new Error(`auto-approve effort must be one of ${EFFORT_LEVELS.join(', ')}`);
  if (!['sandboxes-then-machines', 'sandboxes', 'machines'].includes(out.targets)) throw new Error('auto-approve targets: sandboxes-then-machines, sandboxes or machines');
  const perDay = int(out.maxPerDay, 'max auto-approved per day', 1, 20);
  return {
    enabled: !!out.enabled,
    maxPerRun: Math.min(int(out.maxPerRun, 'max auto-approved per run', 1, 20), perDay),
    maxPerDay: perDay,
    model: out.model,
    effort: out.effort,
    targets: out.targets,
    expiryHours: int(out.expiryHours, 'auto-approve expiry (hours)', 1, 48),
    exclude: [...new Set((out.exclude ?? []).map((x) => String(x).trim().toLowerCase()).filter(Boolean))],
  };
}

// ---- validation ----

export interface BudgetInput {
  perRunUsd?: number;
  perDayUsd?: number;
  maxMinutes?: number;
}

export const DEFAULT_BUDGET = { perRunUsd: 2, perDayUsd: 10, maxMinutes: 45 };

export function normalizeBudget(b: BudgetInput | undefined, prev = DEFAULT_BUDGET): StandingAgent['budget'] {
  const out = { ...prev, ...Object.fromEntries(Object.entries(b ?? {}).filter(([, v]) => v !== undefined)) };
  const num = (v: unknown, name: string, min: number, max: number) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${name} must be between ${min} and ${max}`);
    return n;
  };
  const perRunUsd = num(out.perRunUsd, 'per-run budget ($)', MIN_RUN_USD, 100);
  const perDayUsd = num(out.perDayUsd, 'daily budget ($)', MIN_RUN_USD, 500);
  if (perDayUsd < perRunUsd) throw new Error('the daily budget must be at least the per-run budget');
  return { perRunUsd, perDayUsd, maxMinutes: Math.round(num(out.maxMinutes, 'max minutes per run', 1, 240)) };
}
