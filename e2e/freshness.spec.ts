import type { Page, WebSocketRoute } from '@playwright/test';
import { BOX, boxText, expect, signIn, test, uniq } from './fixtures.ts';

// A tab left open across a deploy reloads itself into the new UI (web/src/freshness.ts, w285). A deploy is
// played here as the server going away and coming back with another web build: the socket drops, and the
// state the next connection sends names a build this page did not load.

const DEPLOYED = 'deployed0001';

/** The page's socket to the real server, except that every connection after the first reports the DEPLOYED build. */
async function deployOnReconnect(page: Page): Promise<{ restart: () => Promise<void> }> {
  const sockets: WebSocketRoute[] = [];
  await page.routeWebSocket(/\/ws$/, (ws) => {
    const n = sockets.push(ws);
    const server = ws.connectToServer();
    ws.onMessage((m) => server.send(m));
    server.onMessage((m) => {
      try {
        const ev = JSON.parse(String(m));
        if (ev.type === 'state' && n > 1) ev.state.app = { ...ev.state.app, web: DEPLOYED };
        ws.send(JSON.stringify(ev));
      } catch {
        ws.send(m);
      }
    });
  });
  return { restart: async () => sockets[0].close() };
}

/** Whether this is still the page marked before the deploy (mid-reload counts as yes, so a poll asks again). */
const oldPage = (page: Page) => page.evaluate(() => (window as { oldPage?: boolean }).oldPage === true).catch(() => true);
const markPage = (page: Page) => page.evaluate(() => ((window as { oldPage?: boolean }).oldPage = true));

test('the page names the build it was served, as /api/health does, and is fetched fresh every time', async ({ page }) => {
  await signIn(page);
  const res = await page.goto('/');
  expect(res?.headers()['cache-control']).toBe('no-cache');
  const health = await (await page.request.get('/api/health')).json();
  expect(health.web).toMatch(/^[0-9a-f]{12}$/);
  await expect(page.locator('meta[name="ff-build"]')).toHaveAttribute('content', health.web);
  expect(res?.headers().etag).toBe(`"${health.web}"`);
});

test('an idle tab reloads itself into a new build, keeps the typed draft, and does not loop', async ({ page }) => {
  await signIn(page);
  const { restart } = await deployOnReconnect(page);
  await page.goto('/');
  const box = page.locator(`.orch ${BOX}`);
  const draft = `half a thought ${uniq('fresh')}`;
  await box.fill(draft);
  await box.blur();
  await markPage(page);

  await restart();
  await expect.poll(() => oldPage(page), { timeout: 15_000 }).toBe(false);
  await expect.poll(() => boxText(box)).toBe(draft);

  // The server still says DEPLOYED, which this page did not get (a stale copy somewhere): it offers the reload once more instead of looping.
  const bar = page.locator('.gbar', { hasText: 'A new version of FF Factory is ready' });
  await expect(bar).toBeVisible();
  await markPage(page);
  await page.waitForTimeout(1500);
  expect(await oldPage(page)).toBe(true);
});

test('a tab being typed in shows the new-version bar instead, and reloads once it is in the background', async ({ page }) => {
  await signIn(page);
  const { restart } = await deployOnReconnect(page);
  await page.goto('/');
  const box = page.locator(`.orch ${BOX}`);
  const draft = `still typing ${uniq('fresh')}`;
  await box.fill(draft);
  await box.focus();
  await markPage(page);

  await restart();
  const bar = page.locator('.gbar', { hasText: 'A new version of FF Factory is ready' });
  await expect(bar).toBeVisible({ timeout: 15_000 });
  expect(await oldPage(page)).toBe(true);
  await expect(bar.getByRole('button', { name: 'Reload', exact: true })).toBeVisible();

  // The user switches to another tab.
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(() => oldPage(page), { timeout: 15_000 }).toBe(false);
  await expect.poll(() => boxText(box)).toBe(draft);
});
