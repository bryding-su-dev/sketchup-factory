import { expect, test as base, type APIRequestContext, type Cookie, type Locator, type Page } from '@playwright/test';
import type { AppState, SessionInfo } from '../shared/types.ts';

export const USER = 'tester';
export const PASSWORD = 'e2e-password-123';

export const isMobile = (page: Page) => (page.viewportSize()?.width ?? 1440) <= 860;

/** This worker's session cookie per server: one login per worker and project, not one per test. */
const sessionCookies = new Map<string, Cookie[]>();

/** Sign in through the API (sets the session cookie on the page's context). */
export async function signIn(page: Page) {
  const base = test.info().project.use.baseURL!;
  const cached = sessionCookies.get(base);
  if (cached) return page.context().addCookies(cached);
  // The server hashes at most two passwords at once and answers the rest "Busy, try again in a
  // moment" (429); parallel workers log in at the same time, so do as it says.
  await expect(async () => {
    const r = await page.request.post('/api/login', { data: { username: USER, password: PASSWORD } });
    expect(r.ok(), await r.text()).toBeTruthy();
  }).toPass({ intervals: [100, 200, 400, 800], timeout: 15_000 });
  sessionCookies.set(base, await page.context().cookies(base));
}

export async function appState(request: APIRequestContext): Promise<AppState> {
  const r = await request.get('/api/state');
  expect(r.ok()).toBeTruthy();
  return r.json();
}

/** Start a worker agent in a sandbox through the API; the fake agent answers `prompt` at once. */
export async function startWorker(request: APIRequestContext, prompt: string, opts: { sandbox?: string; title?: string; permissionMode?: string } = {}): Promise<SessionInfo> {
  const r = await request.post('/api/sessions', { data: { sandboxId: opts.sandbox ?? 'alpha', prompt, title: opts.title, permissionMode: opts.permissionMode } });
  expect(r.ok(), await r.text()).toBeTruthy();
  return r.json();
}

/** A unique tag per test and project, so parallel tests on one server never read each other's text. */
export function uniq(prefix = 't') {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Wait for entrances to finish (a sheet sliding up, a modal scaling in); looping animations are ignored. */
export async function settle(page: Page) {
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
        .map((a) => a.finished.catch(() => undefined)),
    ),
  );
}

/** No element makes the page scroll sideways. */
export async function expectNoHorizontalOverflow(page: Page) {
  const o = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, body: document.body.scrollWidth, vw: window.innerWidth }));
  expect(Math.max(o.doc, o.body), `page is ${Math.max(o.doc, o.body)} px wide in a ${o.vw} px viewport`).toBeLessThanOrEqual(o.vw);
}

/** The element is entirely inside the viewport (not cut off, not under the keyboard line). */
export async function expectFullyVisible(page: Page, selector: string) {
  const box = await page.locator(selector).first().boundingBox();
  expect(box, `${selector} has no box`).not.toBeNull();
  const vp = page.viewportSize()!;
  expect(box!.x).toBeGreaterThanOrEqual(-0.5);
  expect(box!.y).toBeGreaterThanOrEqual(-0.5);
  expect(box!.x + box!.width).toBeLessThanOrEqual(vp.width + 0.5);
  expect(box!.y + box!.height).toBeLessThanOrEqual(vp.height + 0.5);
}

/** Every visible, enabled control matched by `selector` is at least `min` px in both directions (touch targets). */
export async function expectTapTargets(page: Page, selector: string, min = 44) {
  const small = await page.locator(selector).evaluateAll(
    (els, min) =>
      els
        .filter((e) => {
          const r = e.getBoundingClientRect();
          const s = getComputedStyle(e);
          return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && !(e as HTMLButtonElement).disabled;
        })
        .map((e) => {
          const r = e.getBoundingClientRect();
          return { what: (e.getAttribute('aria-label') ?? e.textContent ?? e.className).trim().slice(0, 40), w: Math.round(r.width), h: Math.round(r.height) };
        })
        .filter((r) => r.w < min || r.h < min),
    min,
  );
  expect(small, `touch targets under ${min} px`).toEqual([]);
}

/** Send a message to a session through the API (as the composer does). */
export async function sendMessage(request: APIRequestContext, sessionId: string, text: string) {
  const r = await request.post(`/api/sessions/${sessionId}/message`, { data: { text } });
  expect(r.ok(), await r.text()).toBeTruthy();
}

/** Send a message to any chat, the dispatcher's included (this fork's people chat with the dispatcher directly). */
export const sendToChat = sendMessage;

/** The e2e server's main host sandbox (upstream names it by machine, "pc/alpha"). */
export const ALPHA = 'alpha';

/** Change the route without reloading the page (the app's routes live in the hash). */
export async function go(page: Page, hash: string) {
  await page.evaluate((h) => {
    location.hash = h;
  }, hash);
}

/** Show the sidebar: always there on desktop; on a phone it is a drawer behind the top bar's Menu button. */
export async function openSidebar(page: Page) {
  if (!isMobile(page)) return page.locator('.sidebar');
  // Conversation pages hide the top bar on a phone (they have their own back button).
  if (!(await page.getByRole('button', { name: 'Menu' }).isVisible())) await go(page, '#/');
  await page.getByRole('button', { name: 'Menu' }).click();
  await expect(page.locator('.shell.drawer-open')).toBeAttached();
  // The drawer slides in: wait until it has arrived before tapping inside it.
  await expect.poll(async () => (await page.locator('.sidebar').boundingBox())?.x ?? -1).toBeGreaterThanOrEqual(0);
  return page.locator('.sidebar');
}

/** A sandbox's (or one of its agents') page; on a wide desktop it sits beside the orchestrator. */
export async function openSandbox(page: Page, sandboxId: string, sessionId?: string) {
  await go(page, `#/sandbox/${sandboxId}${sessionId ? `/${sessionId}` : ''}`);
  const panel = page.locator('.sb-panel');
  await expect(panel).toBeVisible();
  return panel;
}

/** A composer's message box: contenteditable, not a textarea (web/src/editable.ts). */
export const BOX = '.composer [role="textbox"]';

/**
 * What a message box says, as the app reads it: its text, less the extra line break a browser adds
 * after a final one (so that the empty last line shows). Playwright's toHaveValue is for form fields.
 */
export function boxText(box: Locator): Promise<string> {
  return box.evaluate((el) => (el.textContent ?? '').replace(/\n\n$/, '\n'));
}

/** A clipboard paste of a PNG into `selector` (a text box), as the browser fires it for a pasted screenshot. */
export async function pastePng(page: Page, selector: string, base64: string, name = 'pasted.png') {
  await page.locator(selector).evaluate(
    (el, { base64, name }) => {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], name, { type: 'image/png' }));
      // A plain event carrying clipboardData: WebKit's ClipboardEvent constructor ignores the init's clipboardData.
      const ev = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(ev, 'clipboardData', { value: dt });
      el.dispatchEvent(ev);
    },
    { base64, name },
  );
}

export const test = base.extend<{ authed: Page }>({
  authed: async ({ page }, use) => {
    await signIn(page);
    await page.goto('/');
    await expect(page.locator('.sidebar')).toBeAttached();
    await use(page);
  },
});

export { expect };

/**
 * Safari's and Chrome's on-screen keyboards, and an iPad's shortcut bar, as the page sees them: a
 * window.visualViewport the test moves (a browser here has neither). Add it with page.addInitScript
 * before the page loads, then moveViewport(page, inset, pan): the bottom `inset` px are covered and the
 * view is panned down by `pan`, as Safari does to reveal a field; `quiet` skips the events (Safari does
 * not always fire one for the last step).
 */
export function standInViewport() {
  const vv = new EventTarget();
  let inset = 0;
  let pan = 0;
  const props: Record<string, () => number> = {
    height: () => window.innerHeight - inset,
    width: () => window.innerWidth,
    offsetTop: () => pan,
    offsetLeft: () => 0,
    pageTop: () => window.scrollY + pan,
    pageLeft: () => window.scrollX,
    scale: () => 1,
  };
  for (const [k, get] of Object.entries(props)) Object.defineProperty(vv, k, { get });
  Object.defineProperty(window, 'visualViewport', { configurable: true, get: () => vv });
  (window as unknown as { __vv: unknown }).__vv = {
    set(i: number, p: number, quiet = false) {
      inset = i;
      pan = p;
      if (quiet) return;
      vv.dispatchEvent(new Event('resize'));
      vv.dispatchEvent(new Event('scroll'));
    },
  };
}

type StandIn = { __vv: { set(inset: number, pan: number, quiet?: boolean): void } };

export function moveViewport(page: Page, inset: number, pan = 0, quiet = false) {
  return page.evaluate(([i, p, q]) => (window as unknown as StandIn).__vv.set(i as number, p as number, q as boolean), [inset, pan, quiet] as const);
}

/** A phone's or tablet's own keyboard, over the bottom of the screen (height as on an iPhone). */
export const ON_SCREEN_KEYBOARD = 336;
