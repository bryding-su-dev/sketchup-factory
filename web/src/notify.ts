// Notifications on this device (server/notify.ts): Web Push through the service worker, or, when
// this device has no push subscription, an in-page notification while the tab is in the background.
import { useSyncExternalStore } from 'react';
import type { NotifyKind, NotifyPrefs } from '../../shared/types';
import { api } from './api';
import { lsGet, lsSet, navigate, parseRoute } from './util';

export const DEFAULT_PREFS: NotifyPrefs = { permission: true, person: true, turnEnd: true, error: true, standing: true, delegation: true, unity: true, host: true };

export interface PushState {
  /** This browser can do Web Push at all. */
  supported: boolean;
  /** iOS only allows push for an app added to the Home Screen. */
  needsHomeScreen: boolean;
  permission: NotificationPermission | 'unsupported';
  /** This device's subscription, if it has one. */
  endpoint?: string;
  prefs: NotifyPrefs;
  busy: boolean;
}

const isIos = /iPhone|iPad|iPod/.test(navigator.userAgent);
const standalone = matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;

let state: PushState = {
  supported: 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window,
  needsHomeScreen: isIos && !standalone,
  permission: 'Notification' in window ? Notification.permission : 'unsupported',
  prefs: { ...DEFAULT_PREFS, ...JSON.parse(lsGet('ffsb.notify.prefs') ?? '{}') },
  busy: false,
};
const listeners = new Set<() => void>();
const set = (p: Partial<PushState>) => {
  state = { ...state, ...p };
  if (p.prefs) lsSet('ffsb.notify.prefs', JSON.stringify(p.prefs));
  listeners.forEach((l) => l());
};

export function usePush(): PushState {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => state,
  );
}

let registration: ServiceWorkerRegistration | undefined;

/** Register the service worker and learn whether this device is subscribed. Called once at boot. */
export async function initNotifications() {
  if (!('serviceWorker' in navigator)) return;
  try {
    registration = await navigator.serviceWorker.register('/sw.js');
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data?.type === 'navigate' && typeof e.data.hash === 'string') navigate(parseRoute(e.data.hash));
    });
    const sub = await registration.pushManager?.getSubscription();
    if (sub) {
      set({ endpoint: sub.endpoint });
      // Re-register it (the server may have been reset) and take the server's copy of this device's choices.
      const r = await api.pushSubscribe(sub.toJSON(), state.prefs).catch(() => undefined);
      if (r) set({ prefs: r.prefs });
    }
  } catch (e) {
    console.warn('service worker:', e);
  }
}

function keyBytes(b64: string) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

/** Ask for permission and subscribe this device. */
export async function enablePush() {
  set({ busy: true });
  try {
    const permission = await Notification.requestPermission();
    set({ permission });
    if (permission !== 'granted') throw new Error('Notifications are blocked for this site in the browser settings.');
    registration ??= await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
    const { publicKey } = await api.push();
    const sub = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
    const r = await api.pushSubscribe(sub.toJSON(), state.prefs);
    set({ endpoint: sub.endpoint, prefs: r.prefs });
  } finally {
    set({ busy: false });
  }
}

export async function disablePush() {
  set({ busy: true });
  try {
    const sub = await registration?.pushManager.getSubscription();
    if (sub) {
      await api.pushUnsubscribe(sub.endpoint).catch(() => undefined);
      await sub.unsubscribe();
    }
    set({ endpoint: undefined });
  } finally {
    set({ busy: false });
  }
}

export async function setPref(kind: NotifyKind, on: boolean) {
  const prefs = { ...state.prefs, [kind]: on };
  set({ prefs });
  if (state.endpoint) set({ prefs: (await api.pushPrefs(state.endpoint, { [kind]: on })).prefs });
}

/** A test to this device: through push when subscribed, else in-page. */
export async function testNotification(): Promise<string> {
  if (state.endpoint) {
    const r = await api.pushTest(state.endpoint);
    return r.delivered ? 'Sent. It should appear in a moment (even with this tab in front).' : 'The push service did not take it; try turning notifications off and on.';
  }
  if (state.permission !== 'granted') throw new Error('Turn notifications on first.');
  await show({ title: 'SketchUp Factory', body: 'Test notification: this tab will tell you while it is in the background.', url: '#/', tag: 'test' });
  return 'Shown.';
}

async function show(n: { title: string; body: string; url: string; tag: string }) {
  const opts = { body: n.body, tag: n.tag, icon: '/icon-192.png', data: { url: n.url } };
  if (registration) return registration.showNotification(n.title, opts);
  const note = new Notification(n.title, opts);
  note.onclick = () => {
    window.focus();
    navigate(parseRoute(n.url));
  };
}

/** A `notify` event from the server: shown here only if this device has no push subscription. */
export function onNotice(n: { kind: NotifyKind; title: string; body: string; url: string; tag: string }) {
  if (state.endpoint || state.permission !== 'granted' || !state.prefs[n.kind]) return;
  if (document.visibilityState === 'visible' && document.hasFocus()) return;
  void show(n);
}
