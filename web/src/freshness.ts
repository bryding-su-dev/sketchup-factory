// A tab left open across a deploy would keep running the old UI against the new server (w285: the FFBox
// panes that did not scroll, the red dot that never showed). The server names the build it serves
// (server/webStatic.ts: index.html's <meta>, and `app.web` in the state and /api/health); when it differs
// from the build this page loaded, the page reloads itself. Not while that would lose something: then a
// bar offers the reload, and it happens by itself once the tab is in the background. A typed message is
// kept anyway (the composer saves its draft when the page goes).
import { useSyncExternalStore } from 'react';
import { BUILD_META, freshnessAction } from '../../shared/freshness';
import { hasPendingFiles } from './upload';

const loaded = document.querySelector<HTMLMetaElement>(`meta[name="${BUILD_META}"]`)?.content || undefined;
/** The build the last automatic reload went for (per tab): a reload that does not bring it is not repeated. */
const TRIED = 'ffsb.reloadedFor';

function triedFor(): string | null {
  try {
    return sessionStorage.getItem(TRIED);
  } catch {
    return null;
  }
}

function setTried(build: string | undefined) {
  try {
    if (build) sessionStorage.setItem(TRIED, build);
    else sessionStorage.removeItem(TRIED);
  } catch {
    /* ignore */
  }
}

if (loaded && triedFor() === loaded) setTried(undefined);

let served: string | undefined;
let offer = false;
const holds = new Set<string>();
const listeners = new Set<() => void>();

/** Whether a reload now would lose something. Hidden, the page has no caret to lose. */
function busy(): boolean {
  if (holds.size || hasPendingFiles() || document.querySelector('[aria-modal]')) return true;
  if (document.visibilityState === 'hidden') return false;
  const a = document.activeElement as HTMLElement | null;
  return !!a && (a.isContentEditable || a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT');
}

function check() {
  const action = freshnessAction({ loaded, served, triedFor: triedFor(), busy: busy() });
  if (action === 'reload') return reloadNow();
  if (offer !== (action === 'banner')) {
    offer = action === 'banner';
    listeners.forEach((l) => l());
  }
}

/** The server's build, from the state it sent (every connect, so after each restart) or from /api/health. */
export function noteServedBuild(build: string | undefined) {
  if (!build) return;
  served = build;
  check();
}

export function reloadNow() {
  setTried(served);
  location.reload();
}

async function askServer() {
  try {
    const r = await fetch('/api/health', { cache: 'no-store' });
    if (r.ok) noteServedBuild(((await r.json()) as { web?: string }).web);
  } catch {
    /* offline: the socket's reconnect brings the state */
  }
}

/** While `on`, keep this page (something a reload would lose, such as images attached to an unsent message). */
export function holdReload(key: string, on: boolean) {
  if (on) holds.add(key);
  else if (holds.delete(key)) check();
}

/** Whether a newer build waits for the user's reload. */
export function useNewVersion(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => offer,
  );
}

if (loaded) {
  // Back from the background (a rebuild without a restart says nothing over the socket); off to it, the reload
  // that waited for the user can happen unseen.
  document.addEventListener('visibilitychange', () => (document.visibilityState === 'visible' ? void askServer() : check()));
  // A lazily loaded part (the diagram renderer) whose file a rebuild removed: this page is out of date.
  window.addEventListener('vite:preloadError', () => void askServer());
}
