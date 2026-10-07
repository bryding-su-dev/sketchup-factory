import { SOCKET_PING_MS } from '../../shared/types';
import type {
  AppSettings,
  TimersAnswer,
  AppState,
  CreateSandboxRequest,
  DelegationRequest,
  ImageFile,
  ImageInput,
  Machine,
  NotifyPrefs,
  IntakeGroups,
  MaxEvent,
  MaxInboundChannel,
  MaxInboundItem,
  ProviderConversation,
  ProviderIntakeEvent,
  PermissionMode,
  Sandbox,
  SearchHit,
  ServerEvent,
  SessionInfo,
  StandingAgent,
  StandingAgentInput,
  StartSessionRequest,
  TranscriptEvent,
} from '../../shared/types';
import type { TranscribeResult, VoiceStatus } from '../../shared/voice';

export class UnauthorizedError extends Error {
  constructor() {
    super('Not logged in');
  }
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Called whenever any request comes back 401, so the app can flip to the login screen. */
let onUnauthorized: () => void = () => {};
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}
/** For requests made outside request() (the attachment uploader's XMLHttpRequest). */
export const notifyUnauthorized = () => onUnauthorized();

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    // Every write is JSON, even an empty one: the server refuses other content types (CSRF).
    headers: method === 'GET' ? undefined : { 'Content-Type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
  if (res.status === 401) {
    if (path !== '/api/login') onUnauthorized();
    throw new UnauthorizedError();
  }
  const text = await res.text();
  let data: unknown = undefined;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    if (data && typeof data === 'object' && 'error' in data) msg = String((data as { error: unknown }).error);
    else if (typeof data === 'string' && data) msg = data.slice(0, 300);
    throw new ApiError(res.status, msg);
  }
  return data as T;
}

const enc = encodeURIComponent;

/** A host sandbox, a machine's main clone, or a machine sandbox (machine and sandbox). */
export type BranchTarget = { sandbox: string; machine?: string } | { machine: string; sandbox?: string };

export const api = {
  login: (username: string, password: string) => request<{ username: string }>('POST', '/api/login', { username, password }),
  logout: () => request<unknown>('POST', '/api/logout'),
  state: () => request<AppState>('GET', '/api/state'),
  // FFBox, as its connector reported it (docs/ffbox-integration.md): newest first.
  providerConversations: (limit = 100) => request<ProviderConversation[]>('GET', `/api/providers/ffbox/conversations?limit=${limit}`),
  providerIntake: (limit = 200) => request<ProviderIntakeEvent[]>('GET', `/api/providers/ffbox/intake?limit=${limit}`),
  providerSignatures: () => request<IntakeGroups>('GET', '/api/providers/ffbox/signatures'),
  // Max, the Discord bot (docs/max.md): what agents did as Max, and a read-only look at a few channels.
  maxActivity: (limit = 200) => request<MaxEvent[]>('GET', `/api/max/activity?limit=${limit}`),
  maxInbound: () => request<(MaxInboundChannel & { items: MaxInboundItem[] })[]>('GET', '/api/max/inbound'),
  maxSeen: (alias: string) => request<{ ok: boolean }>('POST', `/api/max/inbound/${encodeURIComponent(alias)}/seen`),
  refreshUsage: () => request<{ started: boolean; machines: number }>('POST', '/api/usage/refresh'),
  maxRefresh: () => request<{ ok: boolean; note?: string }>('POST', '/api/max/refresh'),
  events: (sessionId: string, limit = 500) =>
    request<TranscriptEvent[]>('GET', `/api/sessions/${enc(sessionId)}/events?limit=${limit}`),
  /** `note` is set for a standing agent: what the message did (started a run, joined one, waited). */
  sendMessage: (sessionId: string, text: string, images?: ImageInput[], attachments?: string[]) =>
    request<{ note?: string }>('POST', `/api/sessions/${enc(sessionId)}/message`, { text, ...(images?.length ? { images } : {}), ...(attachments?.length ? { attachments } : {}) }),
  /** Compact an orchestrator's conversation now (w518): what `/compact [focus]` typed in its chat does. */
  compact: (sessionId: string, instructions?: string) => request<{ note?: string }>('POST', `/api/sessions/${enc(sessionId)}/compact`, instructions ? { instructions } : {}),
  // Attachments (docs/attachments.md): an upload starts here; web/src/upload.ts sends the chunks.
  beginAttachment: (name: string, size: number) => request<{ uploadId: string; name: string; size: number; received: number; chunkBytes: number }>('POST', '/api/attachments', { name, size }),
  attachmentUpload: (uploadId: string) => request<{ received: number; size: number }>('GET', `/api/attachments/uploads/${enc(uploadId)}`),
  cancelAttachment: (uploadId: string) => request<unknown>('DELETE', `/api/attachments/uploads/${enc(uploadId)}`),
  push: () => request<{ publicKey: string; subscriptions: { endpoint: string; device: string; prefs: NotifyPrefs }[] }>('GET', '/api/push'),
  pushSubscribe: (subscription: PushSubscriptionJSON, prefs: NotifyPrefs) => request<{ prefs: NotifyPrefs }>('POST', '/api/push/subscribe', { subscription, prefs }),
  pushPrefs: (endpoint: string, prefs: Partial<NotifyPrefs>) => request<{ prefs: NotifyPrefs }>('POST', '/api/push/prefs', { endpoint, prefs }),
  pushUnsubscribe: (endpoint: string) => request<unknown>('POST', '/api/push/unsubscribe', { endpoint }),
  pushTest: (endpoint?: string) => request<{ delivered: number }>('POST', '/api/push/test', { endpoint }),
  switchBranch: (target: BranchTarget, branch: string, createFrom?: string) =>
    request<{ note: string }>(
      'POST',
      `${target.machine && target.sandbox ? `/api/machines/${enc(target.machine)}/sandboxes/${enc(target.sandbox)}` : target.machine ? `/api/machines/${enc(target.machine)}` : `/api/sandboxes/${enc(target.sandbox!)}`}/switch-branch`,
      { branch, createFrom },
    ),
  setSettings: (patch: Partial<AppSettings>) => request<AppSettings>('POST', '/api/settings', patch),
  search: (q: { q: string; sandbox?: string; machine?: string; agent?: string; since?: string; until?: string }) =>
    request<{ hits: SearchHit[]; scanned: number; ms: number }>('GET', `/api/search?${new URLSearchParams(Object.entries(q).filter(([, v]) => v) as [string, string][])}`),
  eventsFrom: (sessionId: string, seq: number) => request<TranscriptEvent[]>('GET', `/api/sessions/${enc(sessionId)}/events?from=${seq}`),
  screenshots: (place: { sandbox: string } | { machine: string }) => request<ImageFile[]>('GET', `/api/screenshots?${new URLSearchParams(place)}`),
  renameSession: (sessionId: string, title: string) => request<{ title: string }>('POST', `/api/sessions/${enc(sessionId)}/title`, { title }),
  seen: (sessionId: string) => request<unknown>('POST', `/api/sessions/${enc(sessionId)}/seen`),
  interrupt: (sessionId: string) => request<unknown>('POST', `/api/sessions/${enc(sessionId)}/interrupt`),
  permission: (sessionId: string, requestId: string, allow: boolean, message?: string) =>
    request<unknown>('POST', `/api/sessions/${enc(sessionId)}/permission`, { requestId, allow, message }),
  setMode: (sessionId: string, mode: PermissionMode) =>
    request<unknown>('POST', `/api/sessions/${enc(sessionId)}/mode`, { mode }),
  startSession: (req: StartSessionRequest) => request<SessionInfo>('POST', '/api/sessions', req),
  deleteSession: (sessionId: string) => request<unknown>('DELETE', `/api/sessions/${enc(sessionId)}`),
  /** A fresh conversation: your own orchestrator's, or the dispatcher's (the owner only). */
  resetOrchestrator: (which: 'mine' | 'dispatcher' = 'mine') => request<{ id: string }>('POST', '/api/orchestrator/reset', { which }),
  // An orchestrator's timers (docs/orchestrators.md "Timers"): your own orchestrator's, and the dispatcher's for owners.
  timers: (sessionId: string) => request<TimersAnswer>('GET', `/api/timers/${encodeURIComponent(sessionId)}`),
  timerAction: (sessionId: string, timerId: string, action: 'pause' | 'resume' | 'cancel') =>
    request<TimersAnswer>('POST', `/api/timers/${encodeURIComponent(sessionId)}/${encodeURIComponent(timerId)}`, { action }),
  /** The intake (docs/intake.md): a person approves or declines a Discord or FFBox request. */
  approveWork: (id: string) => request<{ id: string; status: string }>('POST', `/api/work/${encodeURIComponent(id)}/approve`, {}),
  intakePoll: () => request<{ ok: boolean; note?: string }>('POST', '/api/intake/poll', {}),
  declineWork: (id: string, note?: string) => request<{ id: string; status: string }>('POST', `/api/work/${encodeURIComponent(id)}/decline`, { note }),
  /** A host sandbox, or (once the host's own daemon holds them, docs/beast-machine.md) where the daemon is making it. */
  createSandbox: (req: CreateSandboxRequest) => request<Sandbox | { machine: string; id: string; note: string }>('POST', '/api/sandboxes', req),
  deleteSandbox: (id: string) => request<unknown>('DELETE', `/api/sandboxes/${enc(id)}`),
  unity: (id: string, action: 'start' | 'stop') =>
    request<unknown>('POST', `/api/sandboxes/${enc(id)}/unity`, { action }),
  unityLog: (id: string, lines = 200) =>
    request<{ lines: string[] }>('GET', `/api/sandboxes/${enc(id)}/unity-log?lines=${lines}`),
  addMachine: (req: { id: string; host?: string; portalUrl?: string; repoPath?: string; maxSessions?: number; appDir?: string; unityEditorRoot?: string; unityPath?: string; tempDir?: string }) =>
    request<Machine>('POST', '/api/machines', req),
  redeployMachine: (id: string, force = false) => request<Machine>('POST', `/api/machines/${enc(id)}/redeploy`, { force }),
  machineDaemon: (id: string, action: 'start' | 'stop' | 'restart', force = false) => request<{ note: string }>('POST', `/api/machines/${enc(id)}/daemon`, { action, force }),
  labelMachine: (id: string, purpose: string) => request<Machine>('POST', `/api/machines/${enc(id)}/label`, { purpose }),
  removeMachine: (id: string) => request<{ note: string }>('DELETE', `/api/machines/${enc(id)}`),
  machineSandboxUnity: (machine: string, sandbox: string, action: 'start' | 'stop') =>
    request<{ note: string }>('POST', `/api/machines/${enc(machine)}/sandboxes/${enc(sandbox)}/unity`, { action }),
  machineSandboxLog: (machine: string, sandbox: string, lines = 200) =>
    request<{ lines: string[] }>('GET', `/api/machines/${enc(machine)}/sandboxes/${enc(sandbox)}/unity-log?lines=${lines}`),
  createStanding: (req: StandingAgentInput) => request<StandingAgent>('POST', '/api/standing', req),
  updateStanding: (id: string, patch: Partial<StandingAgentInput>) => request<StandingAgent>('POST', `/api/standing/${enc(id)}`, patch),
  deleteStanding: (id: string) => request<unknown>('DELETE', `/api/standing/${enc(id)}`),
  runStanding: (id: string) => request<{ note: string }>('POST', `/api/standing/${enc(id)}/run`),
  stopStanding: (id: string) => request<{ note: string }>('POST', `/api/standing/${enc(id)}/stop`),
  pauseStanding: (id: string, pause: boolean) => request<StandingAgent>('POST', `/api/standing/${enc(id)}/${pause ? 'pause' : 'resume'}`),
  voiceStatus: () => request<VoiceStatus>('GET', '/api/voice'),
  /** `tts`: voice mode is starting; load text-to-speech as well. */
  voiceWarm: (tts = false) => request<VoiceStatus>('POST', '/api/voice/warm', { tts }),
  /** Text -> WAV bytes from local Kokoro. */
  voiceSpeak: async (text: string, voice?: string, speed?: number, signal?: AbortSignal): Promise<ArrayBuffer> => {
    const res = await fetch('/api/voice/tts', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, ...(voice ? { voice } : {}), ...(speed && speed !== 1 ? { speed } : {}) }),
      signal,
    });
    if (res.status === 401) {
      onUnauthorized();
      throw new UnauthorizedError();
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new ApiError(res.status, body.error ?? `${res.status} ${res.statusText}`);
    }
    return res.arrayBuffer();
  },
  voiceInstall: () => request<VoiceStatus>('POST', '/api/voice/install'),
  /** `audio`: base64 of a 16 kHz mono 16-bit WAV. */
  voiceTranscribe: (audio: string) => request<TranscribeResult>('POST', '/api/voice/transcribe', { audio }),
  decideDelegation: (id: string, approve: boolean, note?: string) =>
    request<DelegationRequest>('POST', `/api/delegations/${enc(id)}/${approve ? 'approve' : 'reject'}`, { note }),
};

export type WsStatus = 'connecting' | 'open' | 'closed';

export interface SocketHandlers {
  onEvent: (ev: ServerEvent) => void;
  onStatus: (status: WsStatus) => void;
  /** Fired on every successful (re)connect after the first. */
  onReconnect: () => void;
  /** Fired after a failed attempt; return false to stop reconnecting (e.g. logged out). */
  onFailure: () => Promise<boolean>;
}

/** Heard nothing (not even the server's ping) for this long: the socket is dead, even if it still reads open. */
export const SOCKET_STALE_MS = SOCKET_PING_MS * 3;

/** A self-healing WebSocket to /ws with exponential backoff. */
export function connectSocket(h: SocketHandlers): () => void {
  let ws: WebSocket | null = null;
  let stopped = false;
  let attempt = 0;
  let everOpened = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** When the open socket last delivered anything. */
  let heard = 0;

  const url = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`;

  const open = () => {
    if (stopped) return;
    h.onStatus('connecting');
    let opened = false;
    const sock = new WebSocket(url);
    ws = sock;
    sock.onopen = () => {
      opened = true;
      attempt = 0;
      heard = Date.now();
      h.onStatus('open');
      if (everOpened) h.onReconnect();
      everOpened = true;
    };
    sock.onmessage = (m) => {
      heard = Date.now();
      let ev: ServerEvent;
      try {
        ev = JSON.parse(typeof m.data === 'string' ? m.data : '');
      } catch {
        return;
      }
      if (ev.type !== 'ping') h.onEvent(ev);
    };
    sock.onclose = async () => {
      if (ws !== sock) return;
      ws = null;
      if (stopped) return;
      h.onStatus('closed');
      if (!opened) {
        const keepGoing = await h.onFailure().catch(() => true);
        if (!keepGoing || stopped) return;
      }
      const delay = Math.min(15000, 500 * 2 ** attempt) * (0.75 + Math.random() * 0.5);
      attempt++;
      timer = setTimeout(open, delay);
    };
  };

  // A socket that died without a close (a laptop asleep, a phone that suspended the tab, a dropped
  // connection) still reads open and just goes quiet: everything sent meanwhile, such as a message
  // typed on another device, would never show here. Replace it; the reconnect refetches the gap.
  const dropIfStale = () => {
    if (!ws || stopped || ws.readyState !== WebSocket.OPEN || Date.now() - heard < SOCKET_STALE_MS) return false;
    const dead = ws;
    ws = null; // its onclose, if it ever comes, is then ignored
    dead.close();
    return true;
  };

  // Reconnect promptly when a phone wakes up / the tab comes back.
  const wake = () => {
    if (document.visibilityState === 'visible' && !stopped && (!ws || dropIfStale())) {
      clearTimeout(timer);
      attempt = 0;
      open();
    }
  };
  document.addEventListener('visibilitychange', wake);
  window.addEventListener('online', wake);
  const watchdog = setInterval(() => {
    if (dropIfStale()) {
      clearTimeout(timer);
      attempt = 0;
      open();
    }
  }, SOCKET_PING_MS);

  open();
  return () => {
    stopped = true;
    clearTimeout(timer);
    clearInterval(watchdog);
    document.removeEventListener('visibilitychange', wake);
    window.removeEventListener('online', wake);
    ws?.close();
  };
}
