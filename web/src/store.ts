import { useSyncExternalStore } from 'react';
import type { AppState, ServerEvent, SessionInfo, TranscriptEvent } from '../../shared/types';
import { api, connectSocket, setUnauthorizedHandler, UnauthorizedError, type WsStatus } from './api';
import { noteServedBuild } from './freshness';
import { initNotifications, onNotice } from './notify';

export type AuthState = 'unknown' | 'needed' | 'ok';

export interface StoreState {
  auth: AuthState;
  app: AppState | null;
  ws: WsStatus;
  /** Persisted transcript per session id, ordered by seq, de-duplicated. */
  transcripts: Record<string, TranscriptEvent[]>;
  /** Live streamed assistant text for a turn in flight, per session id. */
  streaming: Record<string, string>;
  /** Session ids whose history has been fetched at least once. */
  loaded: Record<string, true>;
  /** A permission request the UI should scroll to (set by the "needs you" jump). */
  focusRequestId: string | null;
  toasts: Toast[];
  /** A transcript event to scroll to and flash (a search hit). */
  focusEvent: { sessionId: string; seq: number } | null;
  /** The full-size image viewer, when open. */
  lightbox: { items: LightboxItem[]; index: number } | null;
  /** A sandbox or machine whose details should open (the attention list's "Unity is stuck"). */
  focusDetails: string | null;
  /** The phone's navigation drawer is open. */
  drawer: boolean;
}

export interface LightboxItem {
  src: string;
  name: string;
  /** A video (MP4/WebM): shown with player controls instead of as an image. */
  video?: boolean;
}

export interface Toast {
  id: number;
  text: string;
  tone: 'error' | 'info';
}

let state: StoreState = {
  auth: 'unknown',
  app: null,
  ws: 'closed',
  transcripts: {},
  streaming: {},
  loaded: {},
  focusRequestId: null,
  toasts: [],
  lightbox: null,
  focusEvent: null,
  focusDetails: null,
  drawer: false,
};

const listeners = new Set<() => void>();

/** Inside flushEvents: changes are applied but the listeners hear of them once, at the end. */
let batching = false;
let dirty = false;

function set(patch: Partial<StoreState> | ((s: StoreState) => Partial<StoreState>)) {
  // A change from outside the socket (a fetch, a click) lands after the server events that came before it.
  if (!batching && queue.length) flushEvents();
  const p = typeof patch === 'function' ? patch(state) : patch;
  if (!Object.keys(p).length) return;
  state = { ...state, ...p };
  if (batching) dirty = true;
  else listeners.forEach((l) => l());
}

// ---------- server events, one render per frame ----------

/**
 * Server events wait for the next frame and are applied together, so a burst (agents' tool calls, streamed text,
 * meters) costs the page one render rather than one each: typing stays responsive while agents work. A timer
 * backs up the frame, which a hidden tab never draws.
 */
const queue: ServerEvent[] = [];
let frame = 0;
let timer: ReturnType<typeof setTimeout> | undefined;

function enqueueEvent(ev: ServerEvent) {
  // A notice has no state to batch, and may need to reach a hidden page at once.
  if (ev.type === 'notify') return onNotice(ev.notice);
  queue.push(ev);
  if (timer !== undefined) return;
  frame = requestAnimationFrame(flushEvents);
  timer = setTimeout(flushEvents, 100);
}

/** Applies every queued server event, then tells the page once. Exported for the tests. */
export function flushEvents() {
  cancelAnimationFrame(frame);
  clearTimeout(timer);
  timer = undefined;
  if (!queue.length) return;
  const events = queue.splice(0);
  batching = true;
  try {
    for (const ev of events) applyEvent(ev);
  } finally {
    batching = false;
  }
  if (dirty) {
    dirty = false;
    listeners.forEach((l) => l());
  }
}

export function getState() {
  return state;
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Outside React (voice mode watches for a turn's reply): called after every change. */
export const subscribeStore = subscribe;

export function useStore<T>(selector: (s: StoreState) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state));
}

const indexes = new WeakMap<SessionInfo[], Map<string, SessionInfo>>();

/** Sessions by id, built once per sessions list (a portal holds thousands: never look them up with find). */
export function sessionIndex(sessions: SessionInfo[]): Map<string, SessionInfo> {
  let m = indexes.get(sessions);
  if (!m) {
    m = new Map(sessions.map((s) => [s.id, s]));
    indexes.set(sessions, m);
  }
  return m;
}

/** The sessions with these ids, in that order, skipping any that are gone. */
export function sessionsByIds(sessions: SessionInfo[], ids: string[]): SessionInfo[] {
  const byId = sessionIndex(sessions);
  const out: SessionInfo[] = [];
  for (const id of ids) {
    const s = byId.get(id);
    if (s) out.push(s);
  }
  return out;
}

// ---------- merge helpers ----------

function upsertById<T extends { id: string }>(list: T[], item: T): T[] {
  const i = list.findIndex((x) => x.id === item.id);
  if (i === -1) return [...list, item];
  const next = list.slice();
  next[i] = item;
  return next;
}

function mergeEvents(existing: TranscriptEvent[] | undefined, incoming: TranscriptEvent[]): TranscriptEvent[] {
  if (!existing || existing.length === 0) {
    return dedupeSorted([...incoming].sort((a, b) => a.seq - b.seq));
  }
  if (incoming.length === 1) {
    const ev = incoming[0];
    const last = existing[existing.length - 1];
    if (ev.seq > last.seq) return [...existing, ev];
    // Same seq again: the server may re-send an entry with updated fields (e.g. a permission decision).
    const i = existing.findIndex((e) => e.seq === ev.seq);
    if (i !== -1) {
      const next = existing.slice();
      next[i] = ev;
      return next;
    }
  }
  return dedupeSorted([...existing, ...incoming].sort((a, b) => a.seq - b.seq));
}

function dedupeSorted(list: TranscriptEvent[]): TranscriptEvent[] {
  const out: TranscriptEvent[] = [];
  for (const e of list) {
    if (out.length && out[out.length - 1].seq === e.seq) out[out.length - 1] = e;
    else out.push(e);
  }
  return out;
}

function omit<T>(rec: Record<string, T>, key: string): Record<string, T> {
  if (!(key in rec)) return rec;
  const next = { ...rec };
  delete next[key];
  return next;
}

const TERMINAL: SessionInfo['status'][] = ['idle', 'stopped', 'error'];

// ---------- server events ----------

function applyEvent(ev: ServerEvent) {
  switch (ev.type) {
    case 'state':
      set({ app: ev.state });
      noteServedBuild(ev.state.app?.web);
      return;
    case 'system':
      set((s) => (s.app ? { app: { ...s.app, system: ev.system } } : {}));
      return;
    case 'host':
      set((s) => (s.app ? { app: { ...s.app, host: ev.host } } : {}));
      return;
    case 'usage':
      set((s) => (s.app ? { app: { ...s.app, usage: ev.usage } } : {}));
      return;
    case 'accounts':
      set((s) => (s.app ? { app: { ...s.app, accounts: ev.accounts } } : {}));
      return;
    case 'machine_stats':
      set((s) => {
        if (!s.app) return {};
        const machineStats = { ...s.app.machineStats };
        if (ev.stats) machineStats[ev.id] = ev.stats;
        else delete machineStats[ev.id];
        return { app: { ...s.app, machineStats } };
      });
      return;
    case 'sandbox':
      set((s) => (s.app ? { app: { ...s.app, sandboxes: upsertById(s.app.sandboxes, ev.sandbox) } } : {}));
      return;
    case 'machine':
      set((s) => (s.app ? { app: { ...s.app, machines: upsertById(s.app.machines, ev.machine) } } : {}));
      return;
    case 'provider': {
      // Only a provider that is switched on or has a token is listed (as /api/state does).
      const p = ev.provider;
      const keep = p.enabled || p.tokenSet;
      set((s) => (s.app ? { app: { ...s.app, ffbox: p.id === 'ffbox' ? p : s.app.ffbox, providers: keep ? upsertById(s.app.providers ?? [], p) : (s.app.providers ?? []).filter((x) => x.id !== p.id) } } : {}));
      return;
    }
    case 'max':
      set((s) => (s.app ? { app: { ...s.app, max: ev.max } } : {}));
      return;
    case 'machine_removed':
      set((s) => (s.app ? { app: { ...s.app, machines: s.app.machines.filter((x) => x.id !== ev.id) } } : {}));
      return;
    case 'standing':
      set((s) => (s.app ? { app: { ...s.app, standingAgents: upsertById(s.app.standingAgents, ev.agent) } } : {}));
      return;
    case 'standing_removed':
      set((s) => (s.app ? { app: { ...s.app, standingAgents: s.app.standingAgents.filter((x) => x.id !== ev.id) } } : {}));
      return;
    case 'delegation':
      set((s) => (s.app ? { app: { ...s.app, delegations: upsertById(s.app.delegations, ev.request) } } : {}));
      return;
    case 'work':
      set((s) => (s.app ? { app: { ...s.app, work: upsertById(s.app.work ?? [], ev.item) } } : {}));
      return;
    case 'intake':
      set((s) => (s.app ? { app: { ...s.app, intake: ev.intake } } : {}));
      return;
    case 'sandbox_removed':
      set((s) => (s.app ? { app: { ...s.app, sandboxes: s.app.sandboxes.filter((x) => x.id !== ev.id) } } : {}));
      return;
    case 'session':
      set((s) => {
        if (!s.app) return {};
        const patch: Partial<StoreState> = { app: { ...s.app, sessions: upsertById(s.app.sessions, ev.session) } };
        if (TERMINAL.includes(ev.session.status)) patch.streaming = omit(s.streaming, ev.session.id);
        return patch;
      });
      return;
    case 'session_removed':
      set((s) => ({
        app: s.app ? { ...s.app, sessions: s.app.sessions.filter((x) => x.id !== ev.id) } : s.app,
        transcripts: omit(s.transcripts, ev.id),
        streaming: omit(s.streaming, ev.id),
        loaded: omit(s.loaded, ev.id),
      }));
      return;
    case 'transcript':
      // Only chats on screen or cached keep their live events; any other is fetched when it opens (a portal's
      // running agents would otherwise pile up every tool call they make in the page's memory).
      if (!openSessions.has(ev.sessionId) && !state.loaded[ev.sessionId]) return;
      set((s) => {
        const patch: Partial<StoreState> = {
          transcripts: { ...s.transcripts, [ev.sessionId]: mergeEvents(s.transcripts[ev.sessionId], [ev.event]) },
        };
        if (ev.event.kind === 'assistant' || ev.event.kind === 'result') {
          patch.streaming = omit(s.streaming, ev.sessionId);
        }
        return patch;
      });
      return;
    case 'settings':
      set((s) => (s.app ? { app: { ...s.app, settings: ev.settings } } : {}));
      return;
    case 'notify':
      onNotice(ev.notice);
      return;
    case 'delta':
      if (!openSessions.has(ev.sessionId)) return;
      set((s) => ({ streaming: { ...s.streaming, [ev.sessionId]: (s.streaming[ev.sessionId] ?? '') + ev.text } }));
      return;
  }
}

// ---------- transcripts ----------

/** Ref-counted set of sessions currently on screen; refetched after a reconnect. */
const openSessions = new Map<string, number>();
/** Chats that left the screen, oldest first: the last few stay cached (instant to reopen), older ones are dropped. */
const closedSessions: string[] = [];
const KEEP_CLOSED = 6;

export async function loadTranscript(sessionId: string) {
  try {
    const events = await api.events(sessionId, 500);
    set((s) => ({
      transcripts: { ...s.transcripts, [sessionId]: mergeEvents(s.transcripts[sessionId], events) },
      loaded: { ...s.loaded, [sessionId]: true },
    }));
  } catch (e) {
    if (!(e instanceof UnauthorizedError)) toastError(e);
  }
}

export function openSession(sessionId: string): () => void {
  openSessions.set(sessionId, (openSessions.get(sessionId) ?? 0) + 1);
  const i = closedSessions.indexOf(sessionId);
  if (i !== -1) closedSessions.splice(i, 1);
  if (!state.loaded[sessionId]) void loadTranscript(sessionId);
  return () => {
    const n = (openSessions.get(sessionId) ?? 1) - 1;
    if (n > 0) return void openSessions.set(sessionId, n);
    openSessions.delete(sessionId);
    closedSessions.push(sessionId);
    const drop = closedSessions.splice(0, Math.max(0, closedSessions.length - KEEP_CLOSED));
    if (drop.length) {
      set((s) => {
        let { transcripts, loaded, streaming } = s;
        for (const id of drop) {
          transcripts = omit(transcripts, id);
          loaded = omit(loaded, id);
          streaming = omit(streaming, id);
        }
        return { transcripts, loaded, streaming };
      });
    }
  };
}

// ---------- lifecycle ----------

let disconnect: (() => void) | null = null;

function startSocket() {
  if (disconnect) return;
  disconnect = connectSocket({
    onEvent: enqueueEvent,
    onStatus: (ws) => set({ ws }),
    onReconnect: () => {
      // Deltas from the gap are gone; the persisted transcript is the truth.
      set({ streaming: {} });
      for (const id of openSessions.keys()) void loadTranscript(id);
    },
    onFailure: async () => {
      try {
        const app = await api.state();
        set({ app });
        return true;
      } catch (e) {
        return !(e instanceof UnauthorizedError);
      }
    },
  });
}

function stopSocket() {
  disconnect?.();
  disconnect = null;
}

setUnauthorizedHandler(() => {
  stopSocket();
  set({ auth: 'needed' });
});

export async function boot() {
  try {
    const app = await api.state();
    set({ app, auth: 'ok' });
    startSocket();
    void initNotifications();
  } catch (e) {
    if (e instanceof UnauthorizedError) set({ auth: 'needed' });
    else {
      // Server unreachable: keep trying; the socket loop will pick it up.
      set({ auth: 'ok' });
      toastError(e);
      startSocket();
    }
  }
}

export async function logout() {
  try {
    await api.logout();
  } finally {
    set({ auth: 'needed', transcripts: {}, loaded: {}, streaming: {} });
  }
}

export async function login(username: string, password: string) {
  await api.login(username, password);
  set({ auth: 'unknown', transcripts: {}, loaded: {}, streaming: {} });
  await boot();
}

// ---------- ui helpers ----------

export function focusPermission(requestId: string | null) {
  set({ focusRequestId: requestId });
}

/** Open the details of this sandbox or machine when its page shows (null: done). */
export function focusDetails(id: string | null) {
  set({ focusDetails: id });
}

export function setDrawer(open: boolean) {
  set({ drawer: open });
}

/** Jump to an event in a session's transcript, loading older history if it is not there yet. */
export function focusEvent(sessionId: string, seq: number) {
  set({ focusEvent: { sessionId, seq } });
  const have = state.transcripts[sessionId];
  if (!have?.length || have[0].seq > seq) void loadFrom(sessionId, Math.max(1, seq - 20));
}

export function clearFocusEvent() {
  set({ focusEvent: null });
}

async function loadFrom(sessionId: string, seq: number) {
  try {
    const events = await api.eventsFrom(sessionId, seq);
    set((s) => ({
      transcripts: { ...s.transcripts, [sessionId]: mergeEvents(s.transcripts[sessionId], events) },
      loaded: { ...s.loaded, [sessionId]: true },
    }));
  } catch (e) {
    toastError(e);
  }
}

export function openLightbox(items: LightboxItem[], index = 0) {
  set({ lightbox: { items, index } });
}

export function closeLightbox() {
  set({ lightbox: null });
}

let toastSeq = 0;
export function toast(text: string, tone: Toast['tone'] = 'info') {
  const id = ++toastSeq;
  set((s) => ({ toasts: [...s.toasts, { id, text, tone }] }));
  setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), tone === 'error' ? 7000 : 3500);
}

export function toastError(e: unknown) {
  if (e instanceof UnauthorizedError) return;
  toast(e instanceof Error ? e.message : String(e), 'error');
}

/** Run an API call, surfacing failures as a toast. Returns undefined on failure. */
export async function attempt<T>(p: Promise<T>): Promise<T | undefined> {
  try {
    return await p;
  } catch (e) {
    toastError(e);
    return undefined;
  }
}

// Seed a freshly started session into state so navigation works before its WS event lands.
export function upsertSession(session: SessionInfo) {
  applyEvent({ type: 'session', session });
}

export function upsertSandbox(sandbox: import('../../shared/types').Sandbox) {
  applyEvent({ type: 'sandbox', sandbox });
}

export function upsertMachine(machine: import('../../shared/types').Machine) {
  applyEvent({ type: 'machine', machine });
}

export function upsertStanding(agent: import('../../shared/types').StandingAgent) {
  applyEvent({ type: 'standing', agent });
}

/** Drop a session's cached transcript and fetch it again (after a reset). */
export function reloadTranscript(sessionId: string) {
  set((s) => ({
    transcripts: omit(s.transcripts, sessionId),
    loaded: omit(s.loaded, sessionId),
    streaming: omit(s.streaming, sessionId),
  }));
  void loadTranscript(sessionId);
}
