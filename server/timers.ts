// Orchestrator timers (docs/orchestrators.md, "Timers"; w362). Lothsahn: "Please give yourself the ability to set timers
// in the FF Factory harness itself, so you don't have to keep reminding yourself to do things in the chat. Those timers
// should wake up and prompt you."
//
// wake_me (server/wake.ts) is one pending, one-off check-in that a person's message cancels. A timer is a standing job:
// several per orchestrator, once at a time, every N minutes or daily, kept in data/timers.json through the crash-safe
// writer (server/durable.ts), untouched by a person's message, and stopped only by cancel_timer, pause, its end
// (until, max_fires) or its person in the UI.
//
// FIRING. A tick every TICK_MS marks each due timer `pending` and moves its next fire on. A pending fire is delivered as a
// harness message ([timer <id> "<title>"] <note>) when its orchestrator is not mid-turn, else after that turn (turnEnd):
// never dropped, and never twice for one turn. Fires that come due while one is still waiting are coalesced into it, with
// the count; fires missed while FF Factory was down are delivered once at startup, with the missed count. Several timers
// due together go in one message.
//
// AUTHORITY. The message is the harness's (from 'system'), so its turn is not the person's (SessionHandle.turnFrom): every
// tool that needs a person's own words refuses it, as it refuses a wake_me turn.
import { randomBytes } from 'node:crypto';
import { checkObject, readJsonDurable, writeJsonDurable } from './durable.ts';

/** When a timer fires. `every` and `daily` recur; `once` ends after its fire. */
export type TimerSchedule =
  | { kind: 'once'; at: string }
  | { kind: 'every'; minutes: number }
  | { kind: 'daily'; time: string; tz?: string };

export interface TimerRecord {
  id: string;
  /** The orchestrator session it belongs to and wakes. */
  owner: string;
  title: string;
  /** What the orchestrator is told when it fires. */
  note: string;
  schedule: TimerSchedule;
  /** Up to this many minutes added at random to each fire, so several jobs do not wake at once. */
  jitterMinutes?: number;
  /** No fire after this time (ISO). */
  until?: string;
  /** End after this many fires. */
  maxFires?: number;
  /** A fire that comes while the orchestrator is mid-turn is skipped instead of delivered after the turn. */
  skipIfBusy?: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  /** Fires so far (a coalesced batch is one per fire it stands for). */
  fires: number;
  lastFiredAt?: string;
  /** When the last message carrying it was delivered. */
  lastDeliveredAt?: string;
  /** The schedule's next time, before jitter; undefined once it has ended. */
  nextDueAt?: string;
  /** When it will fire next (with jitter). */
  nextFireAt?: string;
  enabled: boolean;
  /** A fire waiting to be delivered: how many fires it stands for, and how many of them came while FF Factory was down. */
  pending?: { count: number; missed: number; since: string; held?: boolean };
  /** Fires skipped because the orchestrator was mid-turn (skipIfBusy). */
  skipped?: number;
  /** Ended (it will not fire again): when and why. */
  endedAt?: string;
  endReason?: 'fired' | 'until' | 'max_fires' | 'cancelled';
}

/** What a timer's owner, a person's view or a tool sees of one. */
export type TimerView = Omit<TimerRecord, 'pending'> & { pending?: number; state: 'active' | 'paused' | 'ended'; scheduleText: string };

/** What the timers need from the sessions. */
export interface TimerHost {
  /** The orchestrator session exists. */
  exists(sessionId: string): boolean;
  /** It is mid-turn (running, starting, waiting on a permission). */
  busy(sessionId: string): boolean;
  /** Send it a harness message (starts it when it is stopped). Throws when it cannot take one now (the agent limit). */
  deliver(sessionId: string, text: string): void;
}

/**
 * THE CAPS, and why these numbers.
 * - 20 active timers per orchestrator: a person's standing jobs are a handful; more is a loop setting timers.
 * - every N minutes at least 5: a check that needs to run more often belongs in code, not in a model's turn.
 * - 96 timer messages per orchestrator in any 24 hours (one every 15 minutes, all day): the budget guard. Several timers
 *   due together are one message, and a fire that comes while one waits joins it, so this counts turns, which is what
 *   costs tokens. Past it, fires wait (coalesced, never dropped) until a message fits the window, and that message says
 *   so. A runaway (a 5-minute timer left for a day) costs at most 96 short turns.
 */
export const TIMER_LIMITS = {
  activePerOwner: 20,
  minEveryMinutes: 5,
  maxEveryMinutes: 7 * 24 * 60,
  maxJitterMinutes: 60,
  deliveriesPerDay: 96,
  title: 120,
  note: 4000,
  /** Ended timers kept per owner, newest first, for the list's history. */
  keepEnded: 20,
} as const;

const TICK_MS = 30_000;
/** Later than this, a fire came due while FF Factory was down. */
const MISSED_AFTER_MS = 5 * 60_000;
const DAY_MS = 24 * 3600_000;
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Offset (ms, local minus UTC) of `tz` at `utcMs`. */
function tzOffset(utcMs: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(utcMs));
  const v = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return Date.UTC(v('year'), v('month') - 1, v('day'), v('hour'), v('minute'), v('second')) - Math.floor(utcMs / 1000) * 1000;
}

/** The next time after `after` that the clock in `tz` reads `time` (HH:MM). */
export function nextDaily(time: string, tz: string, after: number): number {
  const m = HHMM.exec(time);
  if (!m) throw new Error(`daily: a time of day as HH:MM (24-hour), e.g. "09:30"; got ${JSON.stringify(time)}`);
  const local = new Date(after + tzOffset(after, tz));
  for (let d = 0; d < 3; d++) {
    const guess = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + d, Number(m[1]), Number(m[2]));
    let at = guess - tzOffset(guess, tz);
    at = guess - tzOffset(at, tz);
    if (at > after) return at;
  }
  throw new Error('daily: no next time found');
}

export function validTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The schedule in a few words: "once at …", "every 60 min", "daily at 09:30 (Europe/Berlin)". */
export function scheduleText(s: TimerSchedule): string {
  if (s.kind === 'once') return `once at ${s.at}`;
  if (s.kind === 'every') return s.minutes % 60 === 0 ? `every ${s.minutes / 60} h` : `every ${s.minutes} min`;
  return `daily at ${s.time}${s.tz ? ` (${s.tz})` : ' (server time)'}`;
}

export interface TimerInput {
  title: string;
  note: string;
  /** Exactly one of at / every_minutes / daily. */
  schedule: { at?: string; every_minutes?: number; daily?: string; tz?: string };
  jitter_minutes?: number;
  until?: string;
  max_fires?: number;
  skip_if_busy?: boolean;
}

export class Timers {
  private readonly host: TimerHost;
  private readonly file?: string;
  private timers = new Map<string, TimerRecord>();
  /** Per owner, when each timer message went out in the last 24 hours (the budget guard). */
  private deliveries: Record<string, number[]> = {};
  private tickTimer?: NodeJS.Timeout;
  now: () => number = Date.now;
  /** Jitter's randomness (tests replace it). */
  random: () => number = Math.random;
  /** Called whenever a timer changes (the UI's refresh). */
  onChange?: (owner: string) => void;

  constructor(host: TimerHost, file?: string) {
    this.host = host;
    this.file = file;
  }

  // ---------------------------------------------------------------- the tools' half

  /** A new timer for `owner`; its record. Throws a sentence saying what was wrong. */
  create(owner: string, input: TimerInput, createdBy: string): TimerRecord {
    if (!this.host.exists(owner)) throw new Error('no such orchestrator');
    const active = this.of(owner).filter((t) => !t.endedAt);
    if (active.length >= TIMER_LIMITS.activePerOwner) throw new Error(`you have ${active.length} timers; at most ${TIMER_LIMITS.activePerOwner} are active at once. Cancel one first (list_timers shows them).`);
    const now = this.now();
    const iso = new Date(now).toISOString();
    const t: TimerRecord = {
      id: this.newId(),
      owner,
      title: '',
      note: '',
      schedule: { kind: 'every', minutes: 60 },
      createdBy,
      createdAt: iso,
      updatedAt: iso,
      fires: 0,
      enabled: true,
    };
    this.apply(t, input, now, true);
    this.timers.set(t.id, t);
    this.changed(owner);
    return t;
  }

  /** Change a timer's fields (any of create's); its record. */
  update(owner: string, id: string, input: Partial<TimerInput> & { enabled?: boolean }): TimerRecord {
    const t = this.mine(owner, id);
    if (t.endedAt) throw new Error(`${id} has ended (${t.endReason}); set a new one`);
    const now = this.now();
    this.apply(t, input, now, false);
    if (input.enabled !== undefined && input.enabled !== t.enabled) {
      t.enabled = input.enabled;
      // Resumed: from now on, with nothing owed for the paused time.
      if (t.enabled) this.reschedule(t, now, true);
      else t.pending = undefined;
    }
    t.updatedAt = new Date(now).toISOString();
    this.changed(owner);
    return t;
  }

  cancel(owner: string, id: string): TimerRecord {
    const t = this.mine(owner, id);
    if (!t.endedAt) this.end(t, 'cancelled');
    this.changed(owner);
    return t;
  }

  /**
   * The orchestrator started a new conversation ("New conversation": a new session in place of the old one): its timers
   * go with it, as its person's standing jobs. How many moved.
   */
  rehome(from: string, to: string): number {
    if (!from || from === to) return 0;
    let n = 0;
    for (const t of this.timers.values()) {
      if (t.owner !== from) continue;
      t.owner = to;
      n++;
    }
    if (n) {
      if (this.deliveries[from]) this.deliveries[to] = [...(this.deliveries[to] ?? []), ...this.deliveries[from]];
      delete this.deliveries[from];
      this.changed(to);
    }
    return n;
  }

  /** Every timer of `owner`: active and paused first (soonest first), then the recently ended. */
  list(owner: string): TimerView[] {
    const all = this.of(owner);
    const live = all.filter((t) => !t.endedAt).sort((a, b) => (a.nextFireAt ?? '~').localeCompare(b.nextFireAt ?? '~'));
    const ended = all.filter((t) => t.endedAt).sort((a, b) => b.endedAt!.localeCompare(a.endedAt!));
    return [...live, ...ended].map((t) => this.view(t));
  }

  view(t: TimerRecord): TimerView {
    const { pending, ...rest } = t;
    return { ...rest, ...(pending ? { pending: pending.count } : {}), state: t.endedAt ? 'ended' : t.enabled ? 'active' : 'paused', scheduleText: scheduleText(t.schedule) };
  }

  /** How many timer messages `owner` got in the last 24 hours. */
  deliveredToday(owner: string): number {
    const since = this.now() - DAY_MS;
    return (this.deliveries[owner] ?? []).filter((x) => x > since).length;
  }

  // ---------------------------------------------------------------- the clock

  /** Load the file, deliver once what came due while FF Factory was down, and start ticking. How many timers loaded. */
  start(): number {
    this.load();
    this.tick();
    this.tickTimer = setInterval(() => this.tick(), TICK_MS);
    this.tickTimer.unref?.();
    return this.timers.size;
  }

  stop() {
    clearInterval(this.tickTimer);
  }

  /** Mark each due timer pending and move it on, then deliver what can be delivered. */
  tick() {
    const now = this.now();
    for (const t of this.timers.values()) {
      if (t.endedAt || !t.enabled || !t.nextFireAt) continue;
      if (!this.host.exists(t.owner)) continue;
      if (Date.parse(t.nextFireAt) > now) continue;
      this.fire(t, now);
    }
    for (const owner of new Set([...this.timers.values()].filter((t) => t.pending).map((t) => t.owner))) this.flush(owner);
  }

  /** The orchestrator finished a turn: what waited for it goes now. */
  turnEnded(owner: string) {
    this.flush(owner);
  }

  private fire(t: TimerRecord, now: number) {
    // HOW MANY SCHEDULED FIRES THIS ONE STANDS FOR: more than one only after downtime (a tick every 30 s never misses one).
    // A fire more than MISSED_AFTER_MS late came due while FF Factory was down: it and every scheduled time it covers
    // were missed, and this one fire stands for all of them (the startup catch-up).
    const due = Date.parse(t.nextDueAt ?? t.nextFireAt!);
    const period = t.schedule.kind === 'every' ? t.schedule.minutes * 60_000 : t.schedule.kind === 'daily' ? DAY_MS : 0;
    const late = now - due;
    const missed = late > MISSED_AFTER_MS ? (period > 0 ? Math.floor(late / period) + 1 : 1) : 0;
    t.fires += 1;
    t.lastFiredAt = new Date(now).toISOString();
    if (t.skipIfBusy && this.host.busy(t.owner)) {
      t.skipped = (t.skipped ?? 0) + 1;
    } else {
      const p = t.pending ?? { count: 0, missed: 0, since: t.lastFiredAt };
      p.count += 1;
      p.missed += missed;
      t.pending = p;
    }
    if (t.schedule.kind === 'once') this.end(t, 'fired', true);
    else if (t.maxFires !== undefined && t.fires >= t.maxFires) this.end(t, 'max_fires', true);
    else this.reschedule(t, now, false);
    t.updatedAt = new Date(now).toISOString();
    this.changed(t.owner);
  }

  /** Deliver every pending fire of `owner` in one message, when it is not mid-turn and the budget allows. */
  private flush(owner: string) {
    const due = this.of(owner).filter((t) => t.pending);
    if (!due.length || !this.host.exists(owner) || this.host.busy(owner)) return;
    const now = this.now();
    const since = now - DAY_MS;
    const sent = (this.deliveries[owner] ?? []).filter((x) => x > since);
    if (sent.length >= TIMER_LIMITS.deliveriesPerDay) {
      // HELD BY THE BUDGET: coalesced, never dropped, until a message fits the 24-hour window; that message says so.
      if (due.some((t) => !t.pending!.held)) {
        for (const t of due) t.pending!.held = true;
        this.changed(owner);
      }
      return;
    }
    const lines = due.map((t) => {
      const p = t.pending!;
      const extra = [
        p.count > 1 ? `fired ${p.count} times since it was last delivered` : '',
        p.missed > 0 ? `${p.missed} fire(s) missed while FF Factory was down` : '',
        t.endedAt ? (t.endReason === 'fired' ? 'its one fire: it has ended' : `its last fire (${t.endReason === 'max_fires' ? 'max_fires reached' : 'until passed'}): it has ended`) : '',
      ].filter(Boolean);
      return `[timer ${t.id} "${t.title}"] ${t.note}${extra.length ? `\n(${extra.join('; ')})` : ''}`;
    });
    const held = due.some((t) => t.pending!.held);
    const text = [
      ...lines,
      ...(held ? [`(These waited for the timer budget: at most ${TIMER_LIMITS.deliveriesPerDay} timer messages a day. Slow or cancel a timer if this keeps happening.)`] : []),
      'A timer is the harness reminding you, not your person: it carries no one\'s authority. Anything that needs their own words still needs them to write.',
    ].join('\n\n');
    try {
      this.host.deliver(owner, text);
    } catch (e) {
      console.warn(`timers: could not wake ${owner} now (${(e as Error).message}); trying again on the next tick`);
      return;
    }
    const iso = new Date(now).toISOString();
    for (const t of due) {
      t.pending = undefined;
      t.lastDeliveredAt = iso;
    }
    this.deliveries[owner] = [...sent, now];
    this.changed(owner);
  }

  // ---------------------------------------------------------------- the record

  private apply(t: TimerRecord, input: Partial<TimerInput>, now: number, creating: boolean) {
    if (input.title !== undefined || creating) {
      const title = String(input.title ?? '').trim().replace(/\s+/g, ' ');
      if (!title) throw new Error('title: a few words naming the job, e.g. "FFBox desync PR scan"');
      t.title = title.slice(0, TIMER_LIMITS.title);
    }
    if (input.note !== undefined || creating) {
      const note = String(input.note ?? '').trim();
      if (!note) throw new Error('note: what to do when it fires, written to yourself');
      if (note.length > TIMER_LIMITS.note) throw new Error(`note: at most ${TIMER_LIMITS.note} characters`);
      t.note = note;
    }
    if (input.jitter_minutes !== undefined) {
      const j = Number(input.jitter_minutes);
      if (!Number.isInteger(j) || j < 0 || j > TIMER_LIMITS.maxJitterMinutes) throw new Error(`jitter_minutes: 0 to ${TIMER_LIMITS.maxJitterMinutes}`);
      t.jitterMinutes = j || undefined;
    }
    if (input.until !== undefined) {
      if (input.until === '' || input.until === null) t.until = undefined;
      else {
        const u = Date.parse(input.until);
        if (Number.isNaN(u) || u <= now) throw new Error('until: a future ISO time with a zone, e.g. 2026-10-10T18:00:00Z');
        t.until = new Date(u).toISOString();
      }
    }
    if (input.max_fires !== undefined) {
      const m = Number(input.max_fires);
      if (!Number.isInteger(m) || m < 1 || m > 10_000) throw new Error('max_fires: a whole number from 1');
      t.maxFires = m;
    }
    if (input.skip_if_busy !== undefined) t.skipIfBusy = input.skip_if_busy || undefined;
    if (input.schedule !== undefined || creating) {
      t.schedule = this.parseSchedule(input.schedule ?? {}, now);
      this.reschedule(t, now, true);
    } else if (input.jitter_minutes !== undefined || input.until !== undefined) this.reschedule(t, now, true);
  }

  private parseSchedule(s: TimerInput['schedule'], now: number): TimerSchedule {
    const given = [s.at !== undefined, s.every_minutes !== undefined, s.daily !== undefined].filter(Boolean).length;
    if (given !== 1) throw new Error('schedule: exactly one of at (an ISO time), every_minutes, or daily ("HH:MM")');
    if (s.at !== undefined) {
      const at = Date.parse(s.at);
      if (Number.isNaN(at) || !/(Z|[+-]\d{2}:?\d{2})$/.test(s.at)) throw new Error('schedule.at: an ISO time with a zone, e.g. 2026-10-04T15:00:00Z');
      if (at <= now) throw new Error('schedule.at: that time has passed');
      if (at > now + 366 * DAY_MS) throw new Error('schedule.at: within a year');
      return { kind: 'once', at: new Date(at).toISOString() };
    }
    if (s.every_minutes !== undefined) {
      const m = Number(s.every_minutes);
      if (!Number.isInteger(m) || m < TIMER_LIMITS.minEveryMinutes || m > TIMER_LIMITS.maxEveryMinutes) throw new Error(`schedule.every_minutes: a whole number from ${TIMER_LIMITS.minEveryMinutes} to ${TIMER_LIMITS.maxEveryMinutes}`);
      return { kind: 'every', minutes: m };
    }
    const time = String(s.daily);
    if (!HHMM.test(time)) throw new Error(`schedule.daily: a time of day as HH:MM (24-hour), e.g. "09:30"`);
    if (s.tz !== undefined && !validTimeZone(s.tz)) throw new Error(`schedule.tz: an IANA time zone, e.g. "America/New_York"; got ${JSON.stringify(s.tz)}`);
    return { kind: 'daily', time, ...(s.tz ? { tz: s.tz } : {}) };
  }

  /** The next fire after `now` (fresh: counted from now; else from the last due time). Ends it past `until`. */
  private reschedule(t: TimerRecord, now: number, fresh: boolean) {
    const s = t.schedule;
    let due: number;
    if (s.kind === 'once') due = Date.parse(s.at);
    else if (s.kind === 'every') {
      const step = s.minutes * 60_000;
      const last = !fresh && t.nextDueAt ? Date.parse(t.nextDueAt) : now;
      due = fresh ? now + step : last + step * Math.max(1, Math.floor((now - last) / step) + 1);
    } else due = nextDaily(s.time, s.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone, now);
    if (t.until && due > Date.parse(t.until)) {
      t.nextDueAt = undefined;
      t.nextFireAt = undefined;
      if (!fresh || t.fires > 0) return this.end(t, 'until', true);
      throw new Error('until: comes before the first fire');
    }
    const jitter = t.jitterMinutes ? Math.floor(this.random() * t.jitterMinutes * 60_000) : 0;
    t.nextDueAt = new Date(due).toISOString();
    t.nextFireAt = new Date(due + jitter).toISOString();
  }

  /** It will not fire again. `keepPending`: its last fire still goes out. */
  private end(t: TimerRecord, why: NonNullable<TimerRecord['endReason']>, keepPending = false) {
    t.endedAt = new Date(this.now()).toISOString();
    t.endReason = why;
    t.enabled = false;
    t.nextDueAt = undefined;
    t.nextFireAt = undefined;
    if (!keepPending) t.pending = undefined;
    // Only the newest ended ones are kept.
    const ended = this.of(t.owner).filter((x) => x.endedAt && !x.pending).sort((a, b) => b.endedAt!.localeCompare(a.endedAt!));
    for (const old of ended.slice(TIMER_LIMITS.keepEnded)) this.timers.delete(old.id);
  }

  private of(owner: string): TimerRecord[] {
    return [...this.timers.values()].filter((t) => t.owner === owner);
  }

  /** The owner's timer `id`, or an error that names nobody else's. */
  private mine(owner: string, id: string): TimerRecord {
    const t = this.timers.get(String(id ?? '').trim());
    if (!t || t.owner !== owner) throw new Error(`no timer "${id}" of yours (list_timers shows them)`);
    return t;
  }

  private newId(): string {
    for (;;) {
      const id = `t-${randomBytes(4).toString('hex')}`;
      if (!this.timers.has(id)) return id;
    }
  }

  private changed(owner: string) {
    this.save();
    this.onChange?.(owner);
  }

  private load() {
    if (!this.file) return;
    let saved: { timers?: TimerRecord[]; deliveries?: Record<string, number[]> } | undefined;
    try {
      saved = readJsonDurable(this.file, { check: checkObject });
    } catch (e) {
      console.warn('timers: could not read the saved timers:', (e as Error).message);
    }
    for (const t of saved?.timers ?? []) if (t && typeof t.id === 'string' && typeof t.owner === 'string') this.timers.set(t.id, t);
    this.deliveries = saved?.deliveries && typeof saved.deliveries === 'object' ? saved.deliveries : {};
  }

  private save() {
    if (!this.file) return;
    const since = this.now() - DAY_MS;
    for (const k of Object.keys(this.deliveries)) this.deliveries[k] = this.deliveries[k].filter((x) => x > since);
    try {
      writeJsonDurable(this.file, { timers: [...this.timers.values()], deliveries: this.deliveries }, { indent: 2 });
    } catch (e) {
      console.warn('timers: could not save:', (e as Error).message);
    }
  }
}
