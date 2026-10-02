// The intake (docs/intake.md): everything that asks for work outside the people's own orchestrators, routed into the
// one work ledger so the dispatcher sees it beside everyone else's work, de-duplicated against what is in flight and
// what is done.
//
// - Discord: new #bug-reports threads (the in-game reporter's posts too) and trusted people's requests to Max in
//   #dev-chat, read with Max's bot token through server/max.ts (read-only; nothing here posts).
// - FFBox: its fix branches and diagnoses (the connector's conversations), the requests it files itself, and its
//   question "is this already in the ledger?" before it works a report (board_check).
// - Releases: once a landed fix ships in a version, one follow-up request tells its reporters.
// - The nightly e2e lab: each night's new regressions (and long-flaky scenarios) become requests, or are added to the
//   open request already on that scenario (POST /api/intake/nightly, server/nightlyRules.ts).
//
// Every switch is off by default (config intake, server/intakeRules.ts intakeSettings). The rules that are not a
// model's to decide (trust, caps, approval, quoting players' text) are fixed code here and in intakeRules.ts.
import fs from 'node:fs';
import path from 'node:path';
import type { Config } from './config.ts';
import type { Store } from './store.ts';
import { emit } from './store.ts';
import type { Identity } from './identity.ts';
import type { BoardAnswer, Orchestrators } from './orchestrators.ts';
import { escalationBrief, escalationSource, escalationTitle, escalationTriage, type Escalation } from './escalationRules.ts';

/** What FFBox gets back for an escalation (docs/intake.md, "Escalations from Max"). */
export type EscalationAnswer =
  | { status: 'filed'; workId: string; triage: 'obvious-bug' | 'needs-human' }
  | { status: 'in_flight'; workId: string }
  | { status: 'done'; workId: string; version: string | null }
  | { status: 'skipped'; why: string }
  | { status: 'off' };
import type { BoardCheckMessage, ProviderRequestMessage, ResultMessage, WorkReply } from './providerProtocol.ts';
import { run } from './proc.ts';
import {
  bugBrief,
  bugSource,
  bugTitle,
  bundleVersionOf,
  capProblem,
  classifyBug,
  triageOf,
  cleanLine,
  ffboxReviewFrom,
  intakeSettings,
  parseBugThread,
  parseDevRequest,
  quoteUntrusted,
  cleanBlock,
  releaseDraft,
  isFfboxOwned,
  reporterProblem,
  requestBrief,
  requestSource,
  requestTitle,
  type BugReport,
  type DevRequest,
  type DiscordMessage,
  type IntakeSettings,
} from './intakeRules.ts';
import { mentionsScenario, nightlyAgainLine, nightlyDraft, nightlyKey, nightlySkip, type NightlyReport, type NightlyResult } from './nightlyRules.ts';
import { isOpen } from './work.ts';
import { checkObject, readJsonDurable, writeJsonDurable } from './durable.ts';
import type { IntakeEntry, IntakeSummary, MaxEvent, ProviderConversation, WorkItem, WorkSource, WorkSourceKind } from '../shared/types.ts';

const DISCORD_KINDS: readonly WorkSourceKind[] = ['discord-bug', 'discord-request'];
const FFBOX_KINDS: readonly WorkSourceKind[] = ['ffbox-branch', 'ffbox-diagnosis', 'ffbox-request'];
const NIGHTLY_KINDS: readonly WorkSourceKind[] = ['nightly'];
const KEEP_RECENT = 200;
const RELEASE_EVERY_MS = 10 * 60_000;
const RELEASE_LOOKBACK_MS = 30 * 86_400_000;
/** What FFBox acts on in a board answer: an update goes only when this changes, not for a new updatedAt or title. */
const boardDigest = (a: BoardAnswer) => JSON.stringify([a.verdict, a.matches.map((m) => [m.id, m.status, m.watch ?? null, m.version, m.mergedIn, m.branch])]);

/** Board answers FFBox follows: re-checked this often, for at most this long, at most this many. */
const BOARD_RECHECK_MS = 60_000;
const BOARD_FOLLOW_MS = 30 * 86_400_000;
const BOARD_MAX = 500;
const VERSION_FILE = 'ProjectSettings/ProjectSettings.asset';

/** What server/max.ts gives the intake: reads only, the token stays there. */
export interface DiscordReader {
  hasToken: boolean;
  guildId: string | undefined;
  botId?: string;
  channelIdOf(alias: string): string | undefined;
  channelName(id: string): Promise<string | undefined>;
  ensureBotId(): Promise<string | undefined>;
  forumThreads(channelId: string): Promise<{ id: string; parent_id?: string; name?: string; owner_id?: string; message_count?: number }[]>;
  message(channelId: string, messageId: string): Promise<unknown>;
  messagesAfter(channelId: string, after?: string): Promise<{ id: string }[]>;
}

export interface IntakeDeps {
  cfg: Config;
  store: Store;
  identity: Identity;
  orchestrators: Orchestrators;
  discord?: DiscordReader;
  /** Send FFBox a board answer again when it changed (server/providers.ts pushBoard); false when it could not go. */
  pushBoard?: (ref: string, answer: BoardAnswer) => boolean;
  /** git in the base clone; the default runs it there. */
  git?: (args: string[]) => Promise<{ code: number; stdout: string }>;
  now?: () => number;
}

interface Persisted {
  /** Per channel: the newest thread or message seen ("bug:<id>", "req:<id>"). */
  cursors: Record<string, string>;
  recent: IntakeEntry[];
  /** bundleVersion per version-bump commit. */
  versions: Record<string, string>;
  lastVersion?: string;
  checkedAt?: string;
  /** Escalations from FFBox already answered, by their ref: a resend gets the same answer and files nothing new. */
  escalations?: Record<string, { answer: EscalationAnswer; at: number }>;
  /** The last nightly report and what it came to (the Intake tab). */
  nightly?: NonNullable<IntakeSummary['nightly']>['last'];
  polledAt?: string;
  error?: string;
}

/** A snowflake for a moment: every Discord id made after it is larger. */
const snowflakeAt = (ms: number) => ((BigInt(ms) - 1420070400000n) << 22n).toString();
const newer = (a: string, b: string) => BigInt(a) > BigInt(b);

export class IntakeManager {
  private readonly d: IntakeDeps;
  private readonly file: string;
  private data: Persisted;
  private readonly timers: NodeJS.Timeout[] = [];
  private polling = false;
  private checking = false;
  private saveTimer?: NodeJS.Timeout;
  private emitTimer?: NodeJS.Timeout;
  readonly now: () => number;

  constructor(d: IntakeDeps) {
    this.d = d;
    this.now = d.now ?? Date.now;
    this.file = path.join(d.cfg.dataDir, 'intake.json');
    this.data = this.load();
  }

  get settings(): IntakeSettings {
    return intakeSettings(this.d.cfg);
  }

  /** Start the timers for what is switched on (not in unit tests, which call the steps by hand). */
  start() {
    const s = this.settings;
    const every = (ms: number, f: () => void, first: number) => {
      const a = setTimeout(f, first);
      a.unref();
      const b = setInterval(f, ms);
      b.unref();
      this.timers.push(a, b);
    };
    if (s.discord.enabled) every(s.discord.pollMinutes * 60_000, () => void this.pollDiscord(), 20_000);
    if (s.release.enabled) every(RELEASE_EVERY_MS, () => void this.checkReleases(), 60_000);
    // Board answers FFBox still follows are re-checked every minute; a change goes to it at once (docs/intake.md).
    every(BOARD_RECHECK_MS, () => this.recheckBoards(), BOARD_RECHECK_MS);
    return this;
  }

  close() {
    for (const t of this.timers) clearTimeout(t);
    clearTimeout(this.emitTimer);
    this.flush();
  }

  // ---------------------------------------------------------------- state

  private load(): Persisted {
    try {
      const d = readJsonDurable<Partial<Persisted>>(this.file, { check: checkObject });
      if (!d) throw new Error('none yet');
      return { cursors: d.cursors ?? {}, recent: d.recent ?? [], versions: d.versions ?? {}, lastVersion: d.lastVersion, checkedAt: d.checkedAt, polledAt: d.polledAt, error: d.error, nightly: d.nightly, escalations: d.escalations };
    } catch {
      return { cursors: {}, recent: [], versions: {} };
    }
  }

  flush() {
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      writeJsonDurable(this.file, this.data);
    } catch (e) {
      console.warn('intake: could not save its state:', (e as Error).message);
    }
  }

  private changed() {
    if (!this.saveTimer) {
      this.saveTimer = setTimeout(() => this.flush(), 1000);
      this.saveTimer.unref();
    }
    if (this.emitTimer) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = undefined;
      emit({ type: 'intake', intake: this.summary() });
    }, 300);
    this.emitTimer.unref();
  }

  private record(e: Omit<IntakeEntry, 'at'>) {
    this.data.recent = [{ at: new Date(this.now()).toISOString(), ...e, title: cleanLine(e.title, 140) }, ...this.data.recent].slice(0, KEEP_RECENT);
    this.changed();
  }

  /** What a filing came to, in the log. */
  private outcome(source: WorkSourceKind, title: string, url: string | undefined, r: ReturnType<Orchestrators['fileIntake']>): IntakeEntry['action'] {
    if (r.skipped) this.record({ source, action: 'skipped', title, why: r.skipped, url });
    else if (r.repeat) this.record({ source, action: 'repeat', title, workId: r.item!.id, why: 'the same thread or conversation again', url });
    else if (r.mergedInto) this.record({ source, action: 'repeat', title, workId: r.mergedInto, why: `the same bug as ${r.mergedInto}: merged into it`, url });
    else this.record({ source, action: 'filed', title, workId: r.item!.id, why: r.item!.approval?.state === 'pending' ? `waits for a person: ${r.item!.approval.why}` : 'auto-approved', url });
    return r.skipped ? 'skipped' : r.repeat || r.mergedInto ? 'repeat' : 'filed';
  }

  // ---------------------------------------------------------------- Discord

  private lastCheck = 0;

  /** The Intake tab's "Check Discord now": a poll now, at most every 30 s. */
  async checkNow(): Promise<{ ok: boolean; note?: string }> {
    if (!this.settings.discord.enabled) return { ok: false, note: 'the Discord intake is off (config intake.discord.enabled)' };
    const now = this.now();
    if (now - this.lastCheck < 30_000) return { ok: false, note: `checked ${Math.round((now - this.lastCheck) / 1000)} s ago; try again in a moment` };
    this.lastCheck = now;
    await this.pollDiscord();
    return { ok: true };
  }

  /** One poll of the bug and request channels. Returns what it filed (tests). */
  async pollDiscord(): Promise<void> {
    const s = this.settings.discord;
    const dc = this.d.discord;
    if (!s.enabled || !dc || this.polling) return;
    if (!dc.hasToken) {
      this.data.error = 'no bot token (docs/max.md, "The bot token")';
      return this.changed();
    }
    this.polling = true;
    const errors: string[] = [];
    // A bug channel configured by id is still FFBox's when that id is one of its channels.
    const ffboxIds = new Set(s.ffboxOwned.map((a) => dc.channelIdOf(a)).filter(Boolean));
    try {
      for (const alias of s.bugChannels) {
        if (ffboxIds.has(dc.channelIdOf(alias))) continue;
        try {
          await this.pollBugChannel(alias);
        } catch (e) {
          errors.push(`${alias}: ${cleanLine((e as Error).message, 160)}`);
        }
      }
      for (const alias of s.requestChannels) {
        if (ffboxIds.has(dc.channelIdOf(alias))) continue;
        try {
          await this.pollRequestChannel(alias);
        } catch (e) {
          errors.push(`${alias}: ${cleanLine((e as Error).message, 160)}`);
        }
      }
    } finally {
      this.polling = false;
      this.data.polledAt = new Date(this.now()).toISOString();
      this.data.error = errors.length ? errors.join('; ') : undefined;
      this.changed();
    }
  }

  private async pollBugChannel(alias: string) {
    const dc = this.d.discord!;
    const id = dc.channelIdOf(alias);
    if (!id) throw new Error(`no channel id for "${alias}" in the ffbox config's discord.channels`);
    const key = `bug:${id}`;
    const threads = await dc.forumThreads(id);
    // The first look only marks where "new" starts: threads from before the intake was switched on are not filed.
    const cursor = this.data.cursors[key];
    if (!cursor) {
      const newest = threads.at(-1)?.id;
      const now = snowflakeAt(this.now());
      this.data.cursors[key] = newest && newer(newest, now) ? newest : now;
      return this.changed();
    }
    const name = `#${(await dc.channelName(id).catch(() => undefined)) ?? alias.replace(/_/g, '-')}`;
    const botId = dc.botId;
    for (const t of threads.filter((x) => newer(x.id, cursor))) {
      this.data.cursors[key] = t.id;
      if (botId && t.owner_id === botId) continue;
      let starter: DiscordMessage | undefined;
      try {
        starter = (await dc.message(t.id, t.id)) as DiscordMessage;
      } catch {
        // no starter message readable: the title still makes a report
      }
      this.fileBug(parseBugThread(t, starter, { guildId: dc.guildId, channel: name }));
    }
  }

  private async pollRequestChannel(alias: string) {
    const dc = this.d.discord!;
    const id = dc.channelIdOf(alias);
    if (!id) throw new Error(`no channel id for "${alias}" in the ffbox config's discord.channels`);
    const key = `req:${id}`;
    const cursor = this.data.cursors[key];
    const msgs = (await dc.messagesAfter(id, cursor)) as DiscordMessage[];
    if (!cursor) {
      const newest = msgs.at(-1)?.id;
      const now = snowflakeAt(this.now());
      this.data.cursors[key] = newest && newer(newest, now) ? newest : now;
      return this.changed();
    }
    const botId = await this.d.discord!.ensureBotId();
    if (!botId) throw new Error('the bot id is unknown (the token check has not answered)');
    const name = `#${(await dc.channelName(id).catch(() => undefined)) ?? alias.replace(/_/g, '-')}`;
    for (const m of msgs) {
      if (!newer(m.id, this.data.cursors[key])) continue;
      this.data.cursors[key] = m.id;
      const r = parseDevRequest(m, botId, this.settings.discord.trusted, { guildId: dc.guildId, channelId: id });
      if (!r) continue;
      // Who wrote it is not shown: an untrusted person's name is not worth a line of the log.
      if ('ignored' in r) this.record({ source: 'discord-request', action: 'ignored', title: `a message to Max in ${name}`, why: r.ignored });
      else this.fileRequest(r, name);
    }
  }

  /** A bug report into the ledger, for the system payer. */
  fileBug(r: BugReport): IntakeEntry['action'] {
    const s = this.settings;
    const items = () => this.d.store.work.values();
    const now = this.now();
    const res = this.d.orchestrators.fileIntake({
      title: bugTitle(r),
      brief: bugBrief(r),
      source: bugSource(r),
      triage: classifyBug(r),
      requestedBy: this.d.identity.systemPayer(),
      autoApprove: { ...s.discord.autoApprove, allowed: s.discord.autoApprove.bugs },
      kinds: DISCORD_KINDS,
      lookbackDays: s.lookbackDays,
      limit: () => capProblem(items(), DISCORD_KINDS, s.discord.dailyCap, now) ?? reporterProblem(items(), r.reporterKey, s.discord.perReporterPerDay, now),
    });
    return this.outcome('discord-bug', r.title, r.url, res);
  }

  /** A trusted person's request to Max into the ledger, for that person. */
  fileRequest(r: DevRequest, channel: string): IntakeEntry['action'] {
    const s = this.settings;
    const person = this.d.identity.get(r.userId);
    if (!person) {
      this.record({ source: 'discord-request', action: 'ignored', title: `a message to Max in ${channel}`, why: `intake.discord.trusted maps its author to "${r.userId}", which is no login here` });
      return 'ignored';
    }
    const now = this.now();
    const source = requestSource(r, channel, person.displayName);
    const res = this.d.orchestrators.fileIntake({
      title: requestTitle(r),
      brief: requestBrief(r, person.displayName),
      source,
      triage: triageOf(source),
      requestedBy: person,
      autoApprove: { ...s.discord.autoApprove, allowed: s.discord.autoApprove.requests },
      kinds: DISCORD_KINDS,
      lookbackDays: s.lookbackDays,
      limit: () => capProblem(this.d.store.work.values(), DISCORD_KINDS, s.discord.dailyCap, now),
    });
    return this.outcome('discord-request', requestTitle(r), r.url, res);
  }

  /** Max replied in or closed a thread (server/max.ts onEvent): intake requests there record it. */
  onMaxEvent(ev: MaxEvent) {
    if (!ev.ok) return;
    if (ev.action === 'close') {
      const thread = ev.thread?.id ?? ev.channelId;
      if (thread) this.d.orchestrators.noteDelivery(thread, 'closedAt', ev.at);
    } else if ((ev.action === 'reply' || ev.action === 'post') && ev.channelId) {
      this.d.orchestrators.noteDelivery(ev.channelId, 'repliedAt', ev.at);
    }
  }

  // ---------------------------------------------------------------- FFBox

  /** A conversation from the connector: our own submissions record their progress; a fix branch becomes a review request. */
  onConversation(c: ProviderConversation) {
    this.d.orchestrators.ffboxConversation(c);
    const s = this.settings.ffbox;
    if (!s.enabled) return;
    // Its pull request merged or closed on FFBox's side: the review request for it needs nothing more.
    if (c.pr && c.pr.state !== 'open') {
      for (const w of this.d.store.work.values()) {
        if (w.source?.conversation !== c.id || !w.source.kind.startsWith('ffbox') || !['new', 'question', 'queued', 'active'].includes(w.status)) continue;
        this.d.orchestrators.closeIntake(w.id, `FFBox's PR #${c.pr.number} ${c.pr.state === 'merged' ? 'merged' : 'was closed'}`);
      }
    }
    const draft = ffboxReviewFrom(c, s);
    if (!draft) return;
    const now = this.now();
    const res = this.d.orchestrators.fileIntake({
      ...draft,
      triage: triageOf(draft.source, c.opener === 'fff' ? 'system' : c.opener),
      requestedBy: this.d.identity.systemPayer(),
      autoApprove: s.autoApprove,
      kinds: FFBOX_KINDS,
      lookbackDays: this.settings.lookbackDays,
      limit: () => capProblem(this.d.store.work.values(), FFBOX_KINDS, s.dailyCap, now),
    });
    // A conversation is reported again on every change: log only what is new.
    if (!res.repeat) this.outcome(draft.source.kind, draft.title, draft.source.url, res);
  }

  /** FFBox filed a request (the connector's "request" message); undefined while that is off. */
  onRequest(m: ProviderRequestMessage): { workId?: string; status: string; repeat?: boolean; why?: string } | undefined {
    const s = this.settings.ffbox;
    if (!s.enabled || !s.requests) return undefined;
    const operator = m.opener === 'operator' && m.requestedBy ? this.d.identity.get(m.requestedBy.userId) : undefined;
    const untrusted = m.opener !== 'operator';
    const kindLine = m.kind === 'review-branch' ? 'a fix branch to review and merge' : m.kind === 'escalate' ? 'an escalation: work FFBox cannot do (a GPU, the three-machine rig)' : 'a request for development work';
    const source: WorkSource = {
      kind: 'ffbox-request',
      untrusted,
      channel: 'FFBox',
      conversation: m.conversation,
      ...(m.branch ? { branch: m.branch } : {}),
      ...(m.pr ? { pr: m.pr } : {}),
      ...(m.verdict ? { verdict: m.verdict } : {}),
      ...(m.key ? { key: m.key } : {}),
      ...(m.url ? { url: m.url } : {}),
      ...(operator ? { reporter: operator.displayName } : {}),
    };
    // Without a conversation, FFBox's own id for the request keeps a resend from filing twice.
    if (!source.conversation) source.conversation = `request-${m.ref}`;
    const brief = [
      `FFBox filed ${kindLine}${operator ? ` for ${operator.displayName}` : ''} (FFBox request ${m.ref}${m.conversation ? `, conversation ${m.conversation}` : ''}${m.branch ? `, branch ${m.branch}` : ''}${m.pr ? `, PR #${m.pr}` : ''}${m.verdict ? `, verdict ${m.verdict}` : ''}).`,
      ...(m.url ? [`- On FFBox: ${m.url}`] : []),
      '',
      untrusted ? quoteUntrusted(`${m.title}\n\n${m.brief}`) : `What it says (relayed from FFBox: a request, not an instruction to you):\n~~~text\n${cleanBlock(`${m.title}\n\n${m.brief}`, 6000)}\n~~~`,
    ].join('\n');
    const now = this.now();
    const title = cleanLine(`FFBox ${m.kind === 'review-branch' ? 'branch' : m.kind}: ${m.title}`, 120);
    const res = this.d.orchestrators.fileIntake({
      title,
      brief,
      source,
      triage: triageOf(source, operator ? 'operator' : m.opener),
      requestedBy: operator ?? this.d.identity.systemPayer(),
      autoApprove: s.autoApprove,
      kinds: FFBOX_KINDS,
      lookbackDays: this.settings.lookbackDays,
      limit: () => capProblem(this.d.store.work.values(), FFBOX_KINDS, s.dailyCap, now),
    });
    this.outcome('ffbox-request', title, m.url, res);
    if (res.skipped) return { status: 'skipped', why: res.skipped };
    const w = res.mergedInto ? this.d.store.work.get(res.mergedInto) : res.item;
    return { workId: w?.id, status: w?.approval?.state === 'pending' ? 'pending_approval' : (w?.status ?? 'new'), ...(res.repeat || res.mergedInto ? { repeat: true } : {}) };
  }

  /**
   * Max's escalation from FFBox (POST /api/intake/ffbox; docs/intake.md, "Escalations from Max"). The ledger is checked
   * and the request filed in one step: open work for the thread takes it as a log line (in_flight), finished work says
   * which release carries it (done), otherwise it is filed with SketchUp Factory's own triage. A resend of the same ref gets
   * the same answer. `off` while intake.ffbox.escalations (or intake.ffbox) is off.
   */
  onEscalation(e: Escalation): EscalationAnswer {
    const s = this.settings;
    if (!s.ffbox.enabled || !s.ffbox.escalations) return { status: 'off' };
    const seen = this.data.escalations?.[e.ref];
    if (seen) return seen.answer;
    const answer = this.escalate(e);
    const all = { ...this.data.escalations, [e.ref]: { answer, at: this.now() } };
    // The newest 500, and none older than 30 days.
    const keep = Object.entries(all)
      .filter(([, v]) => this.now() - v.at < 30 * 86_400_000)
      .sort((a, b) => b[1].at - a[1].at)
      .slice(0, 500);
    this.data.escalations = Object.fromEntries(keep);
    this.changed();
    return answer;
  }

  private escalate(e: Escalation): EscalationAnswer {
    const s = this.settings;
    const title = escalationTitle(e);
    const board = this.d.orchestrators.boardCheck({ keys: [`discord:${e.threadId}`], conversation: e.conversation }, s.lookbackDays);
    const match = board.matches[0];
    if (board.verdict === 'in_flight' && match) {
      this.d.orchestrators.noteIntake(match.id, `Max escalated its thread again (${e.kind}, FFBox conversation ${e.conversation}): ${cleanLine(e.title, 160)}`);
      this.record({ source: 'ffbox-request', action: 'repeat', title, workId: match.id, why: 'the thread is already in flight', url: e.url });
      return { status: 'in_flight', workId: match.id };
    }
    if (board.verdict === 'done' && match) {
      this.record({ source: 'ffbox-request', action: 'repeat', title, workId: match.id, why: 'the thread was already fixed', url: e.url });
      return { status: 'done', workId: match.id, version: match.version ?? null };
    }
    const source = escalationSource(e);
    const triage = escalationTriage(e);
    const now = this.now();
    const res = this.d.orchestrators.fileIntake({
      title,
      brief: escalationBrief(e),
      source,
      triage,
      requestedBy: this.d.identity.systemPayer(),
      autoApprove: s.ffbox.autoApprove,
      kinds: FFBOX_KINDS,
      lookbackDays: s.lookbackDays,
      limit: () => capProblem(this.d.store.work.values(), FFBOX_KINDS, s.ffbox.dailyCap, now),
    });
    this.outcome('ffbox-request', title, e.url, res);
    if (res.skipped) return { status: 'skipped', why: res.skipped };
    const w = res.mergedInto ? this.d.store.work.get(res.mergedInto) : res.item;
    if (!w) return { status: 'skipped', why: 'not filed' };
    if (res.repeat || res.mergedInto) return { status: 'in_flight', workId: w.id };
    return { status: 'filed', workId: w.id, triage: triage.class === 'obvious-bug' ? 'obvious-bug' : 'needs-human' };
  }

  /** FFBox asks the ledger before it works a report; undefined while the check is off. */
  onBoardCheck(m: BoardCheckMessage): BoardAnswer | undefined {
    const s = this.settings;
    if (!s.ffbox.enabled || !s.ffbox.boardCheck) return undefined;
    // FFBox's board keys in the ledger's spelling: "pr#412" is PR 412, "spec-098" spec 098, "issue#7" a #7 reference.
    const keys = m.keys.flatMap((k) => {
      const l = k.toLowerCase();
      let x: RegExpExecArray | null;
      if ((x = /^pr#(\d+)$/.exec(l))) return [`pr:${Number(x[1])}`];
      if ((x = /^spec-(\d{2,4})$/.exec(l))) return [`spec:${x[1].padStart(3, '0')}`];
      if ((x = /^issue#(\d+)$/.exec(l))) return [`ref:${Number(x[1])}`];
      // Exact keys, as FFBox sends them for its bug_report and suggestion turns and its intake diagnoses.
      if ((x = /^discord:(\d{15,25})$/.exec(l))) return [`discord:${x[1]}`];
      if ((x = /^report:(\d{8}t\d{6}z-(?:crash|desync)-[0-9a-f]{6,32})$/.exec(l))) return [`report:${x[1].replace(/t/, 'T').replace(/z-/, 'Z-')}`];
      if (/^(branch|ffbox|pr|spec|ref):/.test(l)) return [l];
      return [l, `ffbox:${l}`];
    });
    const q = { keys, title: m.title ? cleanLine(m.title, 300) : undefined, conversation: m.conversation };
    const answer = this.d.orchestrators.boardCheck(q, s.lookbackDays);
    this.watchBoard(m.ref, q, answer);
    return answer;
  }

  // ---------------------------------------------------------------- board answers FFBox follows

  /** Per board_check ref: what was asked and the last answer sent. In memory: FFBox asks again after a reconnect. */
  private readonly boards = new Map<string, { q: { keys: string[]; title?: string; conversation?: string }; last: string; at: number }>();

  /**
   * Remember a board answer FFBox will follow: one in flight (until it is done), or done but not yet released (until the
   * version is known). A clear answer, or a released fix, needs no follow-up.
   */
  private watchBoard(ref: string, q: { keys: string[]; title?: string; conversation?: string }, answer: BoardAnswer) {
    const follow = answer.verdict === 'in_flight' || (answer.verdict === 'done' && answer.matches.some((m) => m.status === 'done' && !m.version));
    if (!follow) {
      this.boards.delete(ref);
      return;
    }
    this.boards.set(ref, { q, last: boardDigest(answer), at: this.now() });
    // Oldest first out, past the cap.
    while (this.boards.size > BOARD_MAX) this.boards.delete(this.boards.keys().next().value!);
  }

  /** Recompute every followed answer; push the ones that changed (a PR opened, a merge, a release). Returns how many went. */
  recheckBoards(): number {
    const s = this.settings;
    if (!s.ffbox.enabled || !s.ffbox.boardCheck || !this.d.pushBoard) return 0;
    let sent = 0;
    for (const [ref, b] of [...this.boards]) {
      if (this.now() - b.at > BOARD_FOLLOW_MS) {
        this.boards.delete(ref);
        continue;
      }
      const answer = this.d.orchestrators.boardCheck(b.q, s.lookbackDays);
      if (boardDigest(answer) === b.last) continue;
      if (!this.d.pushBoard(ref, answer)) continue;
      sent++;
      this.watchBoard(ref, b.q, answer);
      const kept = this.boards.get(ref);
      if (kept) kept.at = b.at;
    }
    return sent;
  }

  /** The connector→portal messages this portal takes now beyond the reports (a protocol 2 welcome's accepts). */
  portalAccepts(): string[] {
    const f = this.settings.ffbox;
    if (!f.enabled) return [];
    return [...(f.boardCheck ? ['board_check'] : []), ...(f.requests ? ['request'] : []), 'accepted', 'refused', 'result'];
  }

  /** FFBox accepted or refused a submit. */
  onWorkReply(m: WorkReply) {
    const w = [...this.d.store.work.values()].find((x) => x.ffbox?.requestId === m.ref);
    if (m.type === 'accepted') {
      const wrong = w && m.billedTo.toLowerCase() !== w.requestedBy.userId.toLowerCase() ? ` (NOT ${w.requestedBy.displayName}'s account, which it must be: tell Lothsahn)` : '';
      this.d.orchestrators.ffboxReply(m.ref, { state: 'accepted', conversation: m.conversation, billedTo: m.billedTo }, `accepted as conversation ${m.conversation}, billed to ${m.billedTo}${wrong}`);
    } else {
      this.d.orchestrators.ffboxReply(m.ref, { state: 'refused', reason: m.reason }, `refused: ${m.reason}${m.message ? ` (${cleanLine(m.message, 200)})` : ''}`);
    }
  }

  /** A turn we submitted finished. */
  onResult(m: ResultMessage) {
    const tail = [m.branch ? `branch ${m.branch}` : '', m.pr ? `PR #${m.pr}` : '', m.verdict ? `verdict ${m.verdict}` : '', m.noBranchReason ? `no branch: ${cleanLine(m.noBranchReason, 160)}` : ''].filter(Boolean).join(', ');
    this.d.orchestrators.ffboxReply(
      m.ref,
      { state: 'done', conversation: m.conversation, ...(m.branch ? { branch: m.branch } : {}), ...(m.pr ? { pr: m.pr } : {}), ...(m.verdict ? { verdict: m.verdict } : {}) },
      `${m.state}${tail ? `: ${tail}` : ''}`,
    );
  }

  // ---------------------------------------------------------------- the nightly e2e lab

  /**
   * A night's results from the lab (POST /api/intake/nightly). Each new regression, still-failing scenario and scenario
   * flaky intake.nightly.flakyNights nights running either joins the open request already on that scenario (a nightly
   * request, or a person's own that names the scenario id) or is filed; more to file than batchOver become one request
   * for the night. A still-failing scenario whose request a reviewer declined within the lookback is not filed again.
   * Undefined while intake.nightly is off.
   */
  onNightly(rep: NightlyReport): { scenario: string; action: 'filed' | 'attached' | 'skipped'; workId?: string; why?: string }[] | undefined {
    const s = this.settings;
    if (!s.nightly.enabled) return undefined;
    const now = this.now();
    const lookbackMs = s.lookbackDays * 86_400_000;
    const out: { scenario: string; action: 'filed' | 'attached' | 'skipped'; workId?: string; why?: string }[] = [];
    const toFile: NightlyResult[] = [];
    const work = () => [...this.d.store.work.values()];
    for (const r of rep.results) {
      const skip = nightlySkip(r, s.nightly);
      if (skip) {
        out.push({ scenario: r.scenario, action: 'skipped', why: skip });
        continue;
      }
      const key = nightlyKey(r.scenario);
      // The open request on it: a nightly one (or one that took a nightly line before), else a person's that names it.
      const open = work().filter((w) => isOpen(w) && !w.mergedInto);
      const target = open.find((w) => w.keys.includes(key)) ?? open.find((w) => w.source?.kind !== 'nightly' && mentionsScenario(`${w.title}\n${w.brief}`, r.scenario));
      if (target) {
        const added = this.d.orchestrators.attachNightly(target.id, { key, line: nightlyAgainLine(rep, r), night: rep.date, scenario: r.scenario, urgent: r.release?.shipped === 'yes' });
        if (added) this.record({ source: 'nightly', action: 'repeat', title: `${r.scenario} failed again (${rep.date})`, workId: target.id, why: `added to ${target.id}, open on it` });
        out.push({ scenario: r.scenario, action: 'attached', workId: target.id, why: added ? `added to ${target.id}, open on it` : `already on ${target.id} for ${rep.date}` });
        continue;
      }
      const declined = r.class !== 'new' && work().find((w) => w.source?.kind === 'nightly' && w.keys.includes(key) && w.approval?.state === 'declined' && now - Date.parse(w.updatedAt) < lookbackMs);
      if (declined) {
        out.push({ scenario: r.scenario, action: 'skipped', workId: declined.id, why: `${declined.id} for it was declined${declined.approval?.by && declined.approval.by !== 'auto' ? ` by ${declined.approval.by.displayName}` : ''}` });
        continue;
      }
      toFile.push(r);
    }
    const groups = toFile.length > s.nightly.batchOver ? [toFile] : toFile.map((r) => [r]);
    for (const g of groups) {
      const draft = nightlyDraft(rep, g);
      const res = this.d.orchestrators.fileIntake({
        ...draft,
        requestedBy: this.d.identity.systemPayer(),
        autoApprove: s.nightly.autoApprove,
        kinds: NIGHTLY_KINDS,
        lookbackDays: s.lookbackDays,
        limit: () => capProblem(this.d.store.work.values(), NIGHTLY_KINDS, s.nightly.dailyCap, now),
      });
      this.outcome('nightly', draft.title, draft.source.url, res);
      for (const r of g) {
        if (res.skipped) out.push({ scenario: r.scenario, action: 'skipped', why: res.skipped });
        else out.push({ scenario: r.scenario, action: res.repeat ? 'attached' : 'filed', workId: res.item?.id, ...(g.length > 1 ? { why: `the night's batch of ${g.length}` } : {}) });
      }
    }
    const count = (a: string) => out.filter((o) => o.action === a).length;
    this.data.nightly = { at: new Date(now).toISOString(), date: rep.date, lab: rep.lab, sha: rep.sha, filed: count('filed'), attached: count('attached'), skipped: count('skipped') };
    this.changed();
    return out;
  }

  // ---------------------------------------------------------------- releases

  private async git(args: string[]): Promise<{ code: number; stdout: string }> {
    if (this.d.git) return this.d.git(args);
    return run('git', ['-C', this.d.cfg.repo.basePath, ...args], { timeoutMs: 60_000 });
  }

  private async isAncestor(a: string, b: string): Promise<boolean> {
    return (await this.git(['merge-base', '--is-ancestor', a, b])).code === 0;
  }

  /**
   * Where each landed fix is: on the base branch, and in which release (the first bundleVersion bump on the base branch
   * that contains it, once it is delayMinutes old). A version's newly shipped fixes with a Discord thread get one
   * follow-up request that tells their reporters; it is approved by config intake.release itself.
   */
  async checkReleases(): Promise<void> {
    const s = this.settings;
    if (!s.release.enabled || this.checking) return;
    const now = this.now();
    const waiting = [...this.d.store.work.values()].filter((w) => w.delivery?.fixCommit && !w.delivery.releasedIn && now - Date.parse(w.updatedAt) < RELEASE_LOOKBACK_MS);
    this.checking = true;
    try {
      const base = this.d.cfg.defaultBase;
      const slash = base.indexOf('/');
      if (slash > 0) await this.git(['fetch', '--quiet', base.slice(0, slash), base.slice(slash + 1)]);
      const log = await this.git(['log', base, '--first-parent', '--format=%H %cI', '-n', '40', '-G', 'bundleVersion:', '--', VERSION_FILE]);
      const bumps = log.stdout
        .split('\n')
        .map((l) => l.trim().split(' '))
        .filter((p) => /^[0-9a-f]{40}$/.test(p[0] ?? ''))
        .map(([sha, at]) => ({ sha, at: Date.parse(at) }))
        .reverse();
      for (const b of bumps) {
        if (this.data.versions[b.sha]) continue;
        const v = bundleVersionOf((await this.git(['show', `${b.sha}:${VERSION_FILE}`])).stdout);
        if (v) this.data.versions[b.sha] = v;
      }
      if (bumps.length) this.data.lastVersion = this.data.versions[bumps.at(-1)!.sha] ?? this.data.lastVersion;
      const shipped = new Map<string, WorkItem[]>();
      for (const w of waiting) {
        const fix = w.delivery!.fixCommit!;
        if (!(await this.isAncestor(fix, base))) continue;
        if (!w.delivery!.landedAt) this.d.orchestrators.noteRelease(w.id, { landedAt: new Date(now).toISOString() }, `its fix ${fix.slice(0, 12)} is on ${base}`);
        for (const b of bumps) {
          const version = this.data.versions[b.sha];
          if (!version || !(await this.isAncestor(fix, b.sha))) continue;
          if (now - b.at < s.release.delayMinutes * 60_000) break;
          this.d.orchestrators.noteRelease(w.id, { releasedIn: version, releasedAt: new Date(b.at).toISOString() }, `shipped in ${version}`);
          // A thread in a channel FFBox owns hears from FFBox when the fix merges, not from a release follow-up.
          const threads = !isFfboxOwned(w.source?.channel) && (w.source?.threadId || w.source?.alsoThreads?.length);
          if (threads && !w.delivery?.announcedBy) shipped.set(version, [...(shipped.get(version) ?? []), w]);
          break;
        }
      }
      for (const [version, items] of shipped) {
        const draft = releaseDraft(version, items);
        const res = this.d.orchestrators.fileIntake({
          ...draft,
          triage: triageOf(draft.source),
          requestedBy: this.d.identity.systemPayer(),
          autoApprove: { enabled: false, maxPerDay: 0 },
          kinds: ['release'],
          lookbackDays: s.lookbackDays,
          approved: true,
        });
        const id = res.item?.id;
        if (id) for (const w of items) this.d.orchestrators.noteRelease(w.id, { announcedBy: id }, `release follow-up filed as ${id}`);
        this.outcome('release', draft.title, undefined, res);
      }
      this.data.checkedAt = new Date(now).toISOString();
    } catch (e) {
      this.data.error = `release check: ${cleanLine((e as Error).message, 200)}`;
    } finally {
      this.checking = false;
      this.changed();
    }
  }

  // ---------------------------------------------------------------- the page

  summary(): IntakeSummary {
    const s = this.settings;
    const now = this.now();
    const day = (iso: string) => now - Date.parse(iso) < 86_400_000;
    const intake = [...this.d.store.work.values()].filter((w) => w.source);
    return {
      discord: {
        enabled: s.discord.enabled,
        bugChannels: s.discord.bugChannels,
        requestChannels: s.discord.requestChannels,
        ffboxOwned: s.discord.ffboxOwned,
        trustedPeople: [...new Set(Object.values(s.discord.trusted))],
        dailyCap: s.discord.dailyCap,
        perReporterPerDay: s.discord.perReporterPerDay,
        autoApprove: s.discord.autoApprove,
        ...(this.data.polledAt ? { polledAt: this.data.polledAt } : {}),
        ...(this.data.error ? { error: this.data.error } : {}),
      },
      ffbox: {
        enabled: s.ffbox.enabled,
        branches: s.ffbox.branches,
        diagnoses: s.ffbox.diagnoses,
        requests: s.ffbox.requests,
        escalations: s.ffbox.escalations,
        boardCheck: s.ffbox.boardCheck,
        sendWork: s.ffbox.sendWork,
        dailyCap: s.ffbox.dailyCap,
        autoApprove: s.ffbox.autoApprove,
      },
      release: { enabled: s.release.enabled, delayMinutes: s.release.delayMinutes, ...(this.data.lastVersion ? { lastVersion: this.data.lastVersion } : {}), ...(this.data.checkedAt ? { checkedAt: this.data.checkedAt } : {}) },
      nightly: { ...s.nightly, ...(this.data.nightly ? { last: this.data.nightly } : {}) },
      reviewers: this.d.orchestrators.reviewers().map((r) => r.displayName),
      reviewerIds: this.d.orchestrators.reviewers().map((r) => r.userId),
      today: {
        filed: intake.filter((w) => day(w.createdAt)).length,
        skipped: this.data.recent.filter((e) => e.action === 'skipped' && day(e.at)).length,
        autoApproved: intake.filter((w) => day(w.createdAt) && w.approval?.by === 'auto').length,
        pending: intake.filter((w) => w.approval?.state === 'pending' && w.status === 'new').length,
      },
      recent: this.data.recent.slice(0, 50),
    };
  }
}
