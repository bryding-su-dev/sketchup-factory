import { useEffect, useState, useSyncExternalStore } from 'react';
import type { AppVersion, CompactionTrigger, ImageInput, Machine, MachineSandbox, MaxSummary, PermissionMode, Provider, Sandbox, SessionInfo, WorkItem, WorkStatus, SessionStatus, UnityState, SandboxStatus, StandingAgent, StandingRunOutcome, StandingTrigger } from '../../shared/types';
import { displayName, isUnused } from '../../shared/labels';

export { displayName, isUnused };

// ---------- formatting ----------

export function fmtBytes(n: number | undefined): string {
  if (n === undefined || !isFinite(n)) return '–';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

export function fmtCost(usd: number | undefined): string {
  if (!usd) return '$0.00';
  return usd < 0.01 ? '<$0.01' : `$${usd.toFixed(2)}`;
}

/** A token count as the dashboard shows it: "940", "182k", "1.02M". */
export function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

const COMPACTED_BY: Record<CompactionTrigger, string> = {
  person: 'asked by a person',
  tokens: 'automatically, past its token threshold',
  cost: 'automatically, after a costly turn',
  self: 'at its own request',
  claude: 'by Claude Code at its limit',
};

/**
 * An orchestrator's context and its last compaction (w535), for its header and menu: `short` ("182k") and the whole
 * line ("context 182k tokens · compacted 2h ago (276k → 31k, automatically, past its token threshold)"). Undefined
 * until either is known.
 */
export function contextGlance(s: Pick<SessionInfo, 'contextTokens' | 'lastCompaction'>, now: number): { short: string; line: string } | undefined {
  const c = s.lastCompaction;
  if (s.contextTokens === undefined && !c) return undefined;
  const ctx = s.contextTokens !== undefined ? `context ${fmtTokens(s.contextTokens)} tokens` : 'context not measured yet';
  const last = c ? `compacted ${fmtRelative(c.at, now)} (${fmtTokens(c.before)} → ${c.after !== undefined ? fmtTokens(c.after) : '?'}, ${COMPACTED_BY[c.trigger] ?? c.trigger})` : 'not compacted yet';
  return { short: s.contextTokens !== undefined ? fmtTokens(s.contextTokens) : '–', line: `${ctx} · ${last}` };
}

export function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function fmtRelative(iso: string | undefined, now: number): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (isNaN(t)) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function fmtClock(iso: string): string {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** Re-render every `ms` so relative times stay fresh. */
export function useNow(ms = 15000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

// ---------- status vocab ----------

export type Tone = 'green' | 'amber' | 'blue' | 'grey' | 'red';

export function sessionTone(s: SessionStatus): Tone {
  switch (s) {
    case 'running':
    case 'starting':
      return 'blue';
    case 'waiting_permission':
      return 'amber';
    case 'error':
      return 'red';
    case 'idle':
    case 'stopped':
      return 'grey';
  }
}

export const sessionLabel: Record<SessionStatus, string> = {
  starting: 'Starting',
  running: 'Working',
  idle: 'Idle',
  waiting_permission: 'Needs you',
  stopped: 'Stopped',
  error: 'Error',
};

export function unityTone(s: UnityState): Tone {
  return s === 'running' ? 'green' : s === 'crashed' ? 'red' : s === 'blocked' ? 'amber' : s === 'stopped' ? 'grey' : 'blue';
}

export const unityLabel: Record<UnityState, string> = {
  stopped: 'Unity off',
  starting: 'Unity starting',
  running: 'Unity running',
  stopping: 'Unity stopping',
  crashed: 'Unity crashed',
  blocked: 'Unity blocked',
};

export function machineTone(m: Machine): Tone {
  if (m.status === 'deploying') return 'blue';
  if (m.status === 'error') return 'red';
  return m.online ? 'green' : 'grey';
}

export function machineLabel(m: Machine): string {
  if (m.status === 'deploying') return 'Setting up';
  if (m.status === 'error') return 'Error';
  return m.online ? 'Online' : 'Offline';
}

export function sandboxTone(s: SandboxStatus): Tone {
  return s === 'ready' ? 'green' : s === 'error' ? 'red' : 'blue';
}

// ---------- standing agents ----------

export function standingTone(a: StandingAgent): Tone {
  if (a.state === 'running' || a.state === 'waiting') return 'blue';
  const last = lastRun(a);
  if (last && (last.outcome === 'error' || last.outcome === 'budget' || last.outcome === 'timeout')) return 'red';
  return 'grey';
}

export const standingLabel: Record<StandingAgent['state'], string> = {
  asleep: 'Asleep',
  waiting: 'Waiting for a slot',
  running: 'Running',
  paused: 'Paused',
};

export function outcomeTone(o: StandingRunOutcome): Tone {
  switch (o) {
    case 'ok':
      return 'green';
    case 'running':
      return 'blue';
    case 'skipped':
    case 'stopped':
    case 'interrupted':
      return 'grey';
    default:
      return 'red';
  }
}

export const outcomeLabel: Record<StandingRunOutcome, string> = {
  running: 'Running',
  ok: 'Done',
  error: 'Error',
  budget: 'Budget hit',
  timeout: 'Timed out',
  stopped: 'Stopped',
  skipped: 'Skipped',
  interrupted: 'Interrupted',
};

/** A summary's headline: its first line with words in it, without markdown decoration. */
export function headline(summary: string | undefined): string {
  for (const line of (summary ?? '').split('\n')) {
    const t = line.replace(/^[\s#>*_`~|-]+|[\s*_`~|]+$/g, '').trim();
    if (/[\p{L}\p{N}]/u.test(t)) return t;
  }
  return '';
}

/** The latest run that is not a skip, or the latest of all. */
export function lastRun(a: StandingAgent) {
  for (let i = a.runs.length - 1; i >= 0; i--) if (a.runs[i].outcome !== 'skipped') return a.runs[i];
  return a.runs[a.runs.length - 1];
}

export function describeTrigger(t: StandingTrigger): string {
  if (t.kind === 'interval') return t.minutes % 60 === 0 ? `every ${t.minutes / 60} h` : `every ${t.minutes} min`;
  if (t.kind === 'cron') return `cron ${t.expr}`;
  return 'manual only';
}

/** Local-day key, as the server counts the daily budget. */
export function todayKey(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function spentToday(a: StandingAgent): number {
  return a.spend.day === todayKey() ? a.spend.usd : 0;
}

/** "in 12m", "in 3h", or "now" for a time in the future. */
export function fmtUntil(iso: string | undefined, now: number): string {
  if (!iso) return '';
  const s = Math.round((Date.parse(iso) - now) / 1000);
  if (s <= 30) return 'now';
  const m = Math.round(s / 60);
  if (m < 60) return `in ${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `in ${h}h${m % 60 ? ` ${m % 60}m` : ''}`;
  return `in ${Math.round(h / 24)}d`;
}

export function isBusy(s: SessionInfo | undefined): boolean {
  return !!s && (s.status === 'running' || s.status === 'starting' || s.status === 'waiting_permission');
}

// ---------- the work ledger (docs/orchestrators.md) ----------

export const workLabel: Record<WorkStatus, string> = {
  new: 'New',
  question: 'Question',
  queued: 'Queued',
  active: 'Active',
  merged: 'Merged',
  done: 'Done',
  rejected: 'Declined',
  cancelled: 'Cancelled',
};

export function workTone(s: WorkStatus): Tone {
  if (s === 'active') return 'blue';
  if (s === 'question') return 'amber';
  if (s === 'done') return 'green';
  return 'grey';
}

export const isOpenWork = (w: Pick<WorkItem, 'status'>) => w.status === 'new' || w.status === 'question' || w.status === 'queued' || w.status === 'active';

/** Whose orchestrator a session is (a person's own), or undefined for the dispatcher and every other session. */
export const chatOwner = (s: SessionInfo | undefined) => (s?.kind === 'orchestrator' && s.orchestratorRole === 'personal' ? s.requestedBy : undefined);

/**
 * The dispatcher at a glance for its sidebar row and page: its open requests by state (questions first). Blue while it
 * works a turn; amber only when one of its questions waits on `me`.
 */
export function dispatcherGlance(dispatcher: SessionInfo | undefined, work: WorkItem[], me?: string): Glance {
  const count = (st: WorkStatus) => work.filter((w) => w.status === st).length;
  const mine = me ? work.some((w) => w.status === 'question' && w.requestedBy.userId.toLowerCase() === me.toLowerCase()) : false;
  const parts = [
    [count('question'), 'question'],
    [count('active'), 'active'],
    [count('queued'), 'queued'],
    [count('new'), 'new'],
  ].filter(([n]) => n) as [number, string][];
  const busy = isBusy(dispatcher);
  const tone: Tone = busy ? 'blue' : mine ? 'amber' : 'grey';
  const label = parts.length ? parts.slice(0, 2).map(([n, w]) => `${n} ${n > 1 && w === 'question' ? 'questions' : w}`).join(' · ') : busy ? 'Working' : 'Nothing open';
  return { tone, label, attention: 0 };
}

// ---------- at a glance: what a sandbox, machine or standing agent is doing ----------

/** A place's state for the lists and headers: a tone, the word for it, and what it is about. */
export interface Glance {
  tone: Tone;
  /** "Working", "Needs you", "Unity blocked", "Idle", "Free", … */
  label: string;
  /** The agent it is about (when that says more than the place's own name), or a short reason. */
  detail?: string;
  /** How many things here wait on the user: permission requests, a blocked editor, delegation requests. */
  attention: number;
  /** The session the state is about, to open it. */
  sessionId?: string;
  /** Something is being set up or torn down. */
  progress?: boolean;
}

const TITLE_NOISE = new Set(['the', 'a', 'an', 'and', 'of', 'for', 'in', 'on', 'to', 'with', 'agent', 'sandbox', 'slot']);
const titleWords = (s: string) => new Set(s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w && !TITLE_NOISE.has(w)));

/** Two titles that say the same thing, e.g. an agent "Lighting pass (AAA space look)" in a sandbox "Lighting pass: AAA space look". */
export function sameTitle(a: string, b: string): boolean {
  const A = titleWords(a);
  const B = titleWords(b);
  if (!A.size || !B.size) return false;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  return shared / Math.min(A.size, B.size) >= 0.75;
}

/** The agent that says most about a place: one waiting on the user, else one working, else the newest. */
export function leadSession(sessions: SessionInfo[]): SessionInfo | undefined {
  return sessions.find((s) => s.pendingPermissions.length > 0) ?? sessions.findLast(isBusy) ?? sessions.findLast((s) => s.status === 'error') ?? sessions.at(-1);
}

const firstLine = (s: string | undefined) => s?.split('\n').find((l) => l.trim())?.trim();

function agentsGlance(name: string, sessions: SessionInfo[], attention: number, unity?: Sandbox['unity'], unused = false): Glance {
  const about = (s: SessionInfo) => (sameTitle(s.title, name) ? undefined : s.title);
  const waiting = sessions.find((s) => s.pendingPermissions.length > 0);
  if (waiting) return { tone: 'amber', label: 'Needs you', detail: about(waiting), attention, sessionId: waiting.id };
  if (unity?.state === 'blocked') return { tone: 'amber', label: 'Unity blocked', detail: unity.blocked?.title ? `“${unity.blocked.title}”` : undefined, attention };
  if (unity?.state === 'crashed') return { tone: 'red', label: 'Unity crashed', attention };
  const busy = sessions.findLast(isBusy);
  if (busy) return { tone: 'blue', label: 'Working', detail: about(busy), attention, sessionId: busy.id };
  const failed = sessions.findLast((s) => s.status === 'error');
  if (failed) return { tone: 'red', label: 'Agent error', detail: about(failed), attention, sessionId: failed.id };
  if (unity?.state === 'starting') return { tone: 'blue', label: 'Unity starting', attention };
  if (unused) return { tone: 'grey', label: 'Free', attention };
  const last = sessions.at(-1);
  if (!last) return { tone: 'grey', label: 'No agents', attention };
  return { tone: 'grey', label: 'Idle', detail: about(last), attention, sessionId: last.id };
}

export function sandboxGlance(sb: Sandbox, sessions: SessionInfo[]): Glance {
  const attention = sessions.reduce((n, s) => n + s.pendingPermissions.length, 0) + (sb.unity.state === 'blocked' ? 1 : 0);
  if (sb.status === 'creating') return { tone: 'blue', label: 'Creating', detail: sb.statusDetail, attention, progress: true };
  if (sb.status === 'deleting') return { tone: 'blue', label: 'Deleting', detail: sb.statusDetail, attention, progress: true };
  if (sb.status === 'error') return { tone: 'red', label: 'Failed', detail: firstLine(sb.statusDetail), attention };
  return agentsGlance(displayName(sb), sessions, attention, sb.unity, isUnused(sb.purpose));
}

export function machineSandboxGlance(sb: MachineSandbox, sessions: SessionInfo[]): Glance {
  const attention = sessions.reduce((n, s) => n + s.pendingPermissions.length, 0);
  if (sb.status === 'creating') return { tone: 'blue', label: 'Creating', detail: sb.statusDetail, attention, progress: true };
  if (sb.status === 'deleting') return { tone: 'blue', label: 'Deleting', detail: sb.statusDetail, attention, progress: true };
  if (sb.status === 'error') return { tone: 'red', label: 'Failed', detail: firstLine(sb.statusDetail), attention };
  return agentsGlance(displayName(sb), sessions, attention, sb.unity, isUnused(sb.purpose));
}

export function machineGlance(m: Machine, sessions: SessionInfo[], now: number): Glance {
  const attention = sessions.reduce((n, s) => n + s.pendingPermissions.length, 0);
  if (m.status === 'deploying') return { tone: 'blue', label: 'Setting up', detail: m.statusDetail, attention, progress: true };
  if (m.status === 'error') return { tone: 'red', label: 'Error', detail: firstLine(m.statusDetail), attention };
  if (!m.online) return { tone: 'grey', label: 'Offline', detail: m.lastSeen ? `seen ${fmtRelative(m.lastSeen, now)}` : 'never connected', attention };
  const g = agentsGlance(displayName(m), sessions, attention, undefined, false);
  return g.label === 'Idle' || g.label === 'No agents' ? { ...g, tone: 'green', label: 'Online' } : g;
}

/** FFBox at a glance: switched off, waiting for its connector, offline, or online with its free slots. */
export function providerGlance(p: Provider, now: number): Glance {
  if (!p.enabled) return { tone: 'grey', label: 'Switched off', attention: 0 };
  if (!p.tokenSet) return { tone: 'amber', label: 'No connector token', attention: 0 };
  if (!p.online) return { tone: p.lastSeen ? 'red' : 'grey', label: p.lastSeen ? 'Connector offline' : 'Waiting for the connector', detail: p.lastSeen ? `seen ${fmtRelative(p.lastSeen, now)}` : undefined, attention: 0 };
  const c = p.capacity;
  const free = c ? c.classes.reduce((n, k) => n + k.free, 0) : undefined;
  if (c && c.state !== 'running') return { tone: 'amber', label: c.state === 'draining' ? 'Draining' : c.state === 'updating' ? 'Updating' : 'Stopped', attention: 0 };
  if (p.counts.active) return { tone: 'blue', label: `${p.counts.active} running`, detail: free !== undefined ? `${free} free` : undefined, attention: 0 };
  return { tone: 'green', label: 'Online', detail: free !== undefined ? `${free} free` : undefined, attention: 0 };
}

/** Max at a glance: the token's health first, then a recent failure, then when it last posted. */
export function maxGlance(m: MaxSummary, now: number): Glance {
  const h = m.health;
  const last = m.lastPost ? `posted ${fmtRelative(m.lastPost.at, now)}` : undefined;
  if (h.state === 'no_token') return { tone: 'grey', label: 'No token', detail: last, attention: 0 };
  if (h.state === 'error') return { tone: 'red', label: 'Token error', detail: last, attention: 0 };
  const recentError = m.lastError && now - Date.parse(m.lastError.at) < 24 * 3600_000 && (!m.lastPost || Date.parse(m.lastError.at) > Date.parse(m.lastPost.at));
  if (recentError) return { tone: 'amber', label: 'Error', detail: last ?? fmtRelative(m.lastError!.at, now), attention: 0 };
  return { tone: h.state === 'ok' ? 'green' : 'grey', label: h.state === 'ok' ? 'OK' : 'Not checked', detail: last, attention: 0 };
}

export function standingGlance(a: StandingAgent, pendingDelegations: number, now: number): Glance {
  const attention = pendingDelegations;
  if (pendingDelegations) return { tone: 'amber', label: 'Needs you', detail: `${pendingDelegations} request${pendingDelegations === 1 ? '' : 's'}`, attention };
  if (a.state === 'running') return { tone: 'blue', label: 'Running', attention };
  if (a.state === 'waiting') return { tone: 'blue', label: 'Waiting for a slot', attention };
  const last = lastRun(a);
  if (last && (last.outcome === 'error' || last.outcome === 'budget' || last.outcome === 'timeout')) {
    return { tone: 'red', label: outcomeLabel[last.outcome], detail: a.state === 'paused' ? 'paused' : undefined, attention };
  }
  if (a.state === 'paused') return { tone: 'grey', label: 'Paused', attention };
  return { tone: 'grey', label: a.nextRunAt ? `Next run ${fmtUntil(a.nextRunAt, now)}` : a.enabled ? 'Runs by hand' : 'Paused', attention };
}

/** A time divider's text: "10:02", "Yesterday 18:40", "Mon 18:40", "20 Sep, 18:40". */
export function fmtDivider(iso: string, now: number): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((day(new Date(now)) - day(d)) / 86_400_000);
  if (days === 0) return `Today ${time}`;
  if (days === 1) return `Yesterday ${time}`;
  if (days < 7) return `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`;
  return `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })}, ${time}`;
}

export const PERMISSION_MODES: { value: PermissionMode; label: string; hint: string }[] = [
  { value: 'default', label: 'Ask', hint: 'Ask before risky tools' },
  { value: 'acceptEdits', label: 'Accept edits', hint: 'Auto-approve file edits' },
  { value: 'auto', label: 'Auto', hint: 'Classifier decides' },
  { value: 'plan', label: 'Plan', hint: 'Read-only planning' },
  { value: 'bypassPermissions', label: 'Bypass', hint: 'Never ask (dangerous)' },
];

// ---------- routing (hash based, so the phone back button works) ----------

export type Route =
  | { view: 'home' }
  /** Someone else's own orchestrator, read only (docs/orchestrators.md). */
  | { view: 'chat'; userId: string }
  /** The dispatcher: its requests (the ledger), one request (a work id), or its conversation. */
  | { view: 'dispatcher'; tab?: string }
  | { view: 'sandbox'; sandboxId: string; sessionId?: string }
  | { view: 'session'; sessionId: string }
  | { view: 'agent'; agentId: string; tab?: string }
  | { view: 'machine'; machineId: string; sessionId?: string }
  /** A sandbox on a machine (docs/machines.md, "Machine sandboxes"): #/machine/lothdesktop/sandbox/sb1. */
  | { view: 'msandbox'; machineId: string; sandboxId: string; sessionId?: string }
  /** Every computer and what it is working on, as a board. */
  | { view: 'overview' }
  | { view: 'provider'; providerId: string; tab?: string }
  | { view: 'max'; tab?: string }
  | { view: 'search'; q?: string };

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  if (parts[0] === 'chat' && parts[1]) return { view: 'chat', userId: parts[1] };
  if (parts[0] === 'dispatcher') return { view: 'dispatcher', tab: parts[1] };
  if (parts[0] === 'sandbox' && parts[1]) return { view: 'sandbox', sandboxId: parts[1], sessionId: parts[2] };
  if (parts[0] === 'session' && parts[1]) return { view: 'session', sessionId: parts[1] };
  if (parts[0] === 'search') return { view: 'search', q: parts[1] };
  if (parts[0] === 'machine' && parts[1] && parts[2] === 'sandbox' && parts[3]) return { view: 'msandbox', machineId: parts[1], sandboxId: parts[3], sessionId: parts[4] };
  if (parts[0] === 'machine' && parts[1]) return { view: 'machine', machineId: parts[1], sessionId: parts[2] };
  if (parts[0] === 'overview') return { view: 'overview' };
  if (parts[0] === 'agent' && parts[1]) return { view: 'agent', agentId: parts[1], tab: parts[2] };
  if (parts[0] === 'provider' && parts[1]) return { view: 'provider', providerId: parts[1], tab: parts[2] };
  if (parts[0] === 'max') return { view: 'max', tab: parts[1] };
  return { view: 'home' };
}

export function href(r: Route): string {
  switch (r.view) {
    case 'home':
      return '#/';
    case 'chat':
      return `#/chat/${encodeURIComponent(r.userId)}`;
    case 'dispatcher':
      return `#/dispatcher${r.tab ? '/' + encodeURIComponent(r.tab) : ''}`;
    case 'sandbox':
      return `#/sandbox/${encodeURIComponent(r.sandboxId)}${r.sessionId ? '/' + encodeURIComponent(r.sessionId) : ''}`;
    case 'session':
      return `#/session/${encodeURIComponent(r.sessionId)}`;
    case 'search':
      return `#/search${r.q ? '/' + encodeURIComponent(r.q) : ''}`;
    case 'machine':
      return `#/machine/${encodeURIComponent(r.machineId)}${r.sessionId ? '/' + encodeURIComponent(r.sessionId) : ''}`;
    case 'msandbox':
      return `#/machine/${encodeURIComponent(r.machineId)}/sandbox/${encodeURIComponent(r.sandboxId)}${r.sessionId ? '/' + encodeURIComponent(r.sessionId) : ''}`;
    case 'overview':
      return '#/overview';
    case 'agent':
      return `#/agent/${encodeURIComponent(r.agentId)}${r.tab ? '/' + encodeURIComponent(r.tab) : ''}`;
    case 'provider':
      return `#/provider/${encodeURIComponent(r.providerId)}${r.tab ? '/' + encodeURIComponent(r.tab) : ''}`;
    case 'max':
      return `#/max${r.tab ? '/' + encodeURIComponent(r.tab) : ''}`;
  }
}

export function navigate(r: Route, replace = false) {
  const h = href(r);
  if (replace) history.replaceState(null, '', h);
  else location.hash = h;
  window.dispatchEvent(new HashChangeEvent('hashchange'));
}

function subscribeHash(cb: () => void) {
  window.addEventListener('hashchange', cb);
  return () => window.removeEventListener('hashchange', cb);
}

export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribeHash, () => location.hash);
  return parseRoute(hash);
}

export function useMediaQuery(q: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia(q);
      m.addEventListener('change', cb);
      return () => m.removeEventListener('change', cb);
    },
    () => window.matchMedia(q).matches,
  );
}

// ---------- text boxes that are not form fields ----------

/**
 * For boxes that take free text (a message, a prompt, a charter): nothing for Safari's AutoFill (on an
 * iPad with a hardware keyboard it floats a passwords/cards/contacts bar over any field it may fill)
 * or a password manager to offer. The composer is also in no <form>, and has no name or id.
 */
export const FREE_TEXT = {
  autoComplete: 'off',
  autoCorrect: 'on',
  autoCapitalize: 'sentences',
  spellCheck: true,
  inputMode: 'text',
  'data-1p-ignore': 'true',
  'data-lpignore': 'true',
  'data-bwignore': 'true',
  'data-form-type': 'other',
} as const;

/** The same for a search term or a short name: no capitals or corrections either. */
export const PLAIN_TEXT = { ...FREE_TEXT, autoCorrect: 'off', autoCapitalize: 'none', spellCheck: false } as const;

// ---------- tiny local storage wrapper (per-viewer conveniences only) ----------

export function lsGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function lsSet(key: string, value: string | null) {
  try {
    if (value === null || value === '') localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

// ---------- images ----------

/** Claude's sweet spot: the long edge at most this many pixels (larger is scaled down server-side anyway). */
const MAX_EDGE = 1568;
const MAX_BYTES = 3_500_000;

function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => reject(r.error ?? new Error('could not read the image'));
    r.readAsDataURL(blob);
  });
}

function canvasBlob(c: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('could not encode the image'))), type, quality));
}

/**
 * An image ready to send: PNG/JPEG/GIF/WebP, long edge ≤ 1568 px, a few MB at most. Phone photos are
 * re-encoded as JPEG; screenshots stay PNG when that is small enough.
 */
export async function shrinkImage(file: Blob): Promise<ImageInput> {
  const ok = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
  const bmp = await createImageBitmap(file).catch(() => null);
  if (!bmp) throw new Error(`${(file as File).name ?? 'That file'} is not an image this browser can read`);
  const long = Math.max(bmp.width, bmp.height);
  if (ok.includes(file.type) && long <= MAX_EDGE && file.size <= MAX_BYTES) return { mediaType: file.type, data: await toBase64(file) };
  const scale = Math.min(1, MAX_EDGE / long);
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(bmp.width * scale));
  c.height = Math.max(1, Math.round(bmp.height * scale));
  c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
  let out = file.type === 'image/png' ? await canvasBlob(c, 'image/png') : null;
  if (!out || out.size > MAX_BYTES) out = await canvasBlob(c, 'image/jpeg', 0.86);
  return { mediaType: out.type, data: await toBase64(out) };
}

/** Put an image (by URL) on the clipboard. Browsers take PNG only, so others are converted. */
export async function copyImage(src: string): Promise<boolean> {
  if (!navigator.clipboard || typeof ClipboardItem === 'undefined') throw new Error('This browser cannot copy images; use Download');
  const png = (async () => {
    const blob = await (await fetch(src, { credentials: 'same-origin' })).blob();
    if (blob.type === 'image/png') return blob;
    const bmp = await createImageBitmap(blob);
    const c = document.createElement('canvas');
    c.width = bmp.width;
    c.height = bmp.height;
    c.getContext('2d')!.drawImage(bmp, 0, 0);
    return canvasBlob(c, 'image/png');
  })();
  // Safari wants the ClipboardItem created synchronously in the click, with a promise inside.
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
  return true;
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

/** "v0.1.0 · 1a2b3c4": the running server's version and commit. */
export function versionLabel(v: AppVersion): string {
  return `v${v.version}${v.sha ? ` · ${v.sha}` : ''}`;
}
