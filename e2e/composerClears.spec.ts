import type { APIRequestContext, Page } from '@playwright/test';
import { BOX, appState, boxText, expect, isMobile, test, uniq } from './fixtures.ts';
import type { TranscriptEvent } from '../shared/types.ts';

/**
 * The orchestrator chat's message box empties as soon as the message is taken, in every path (w893: "Sometimes when I
 * send you a message, the message doesn't clear and I have to manually clear it"). A send that fails keeps the words
 * and says so. Tests share one server and its owner's chat: find your lines by a unique tag.
 */

const MESSAGE = '**/api/sessions/*/message';

// WebKit does not route the requests of a page a service worker controls.
test.use({ serviceWorkers: 'block' });

async function mine(request: APIRequestContext, tag: string): Promise<TranscriptEvent[]> {
  const id = (await appState(request)).orchestratorId;
  const r = await request.get(`/api/sessions/${id}/events?limit=500`);
  expect(r.ok()).toBeTruthy();
  return ((await r.json()) as TranscriptEvent[]).filter((e) => e.kind === 'user' && e.from === 'human' && e.text.includes(tag));
}

/** Type `text` into the chat's box and send it, the way the device does (Enter, or the Send button on a phone). */
async function say(page: Page, text: string) {
  const box = page.locator(`.orch ${BOX}`);
  await box.fill(text);
  if (isMobile(page)) await page.locator('.orch .composer').getByRole('button', { name: 'Send' }).click();
  else await box.press('Enter');
}

const draftKey = async (page: Page) => `ffsb.draft.${(await appState(page.request)).orchestratorId}`;
const savedDraft = async (page: Page) => page.evaluate(async (k) => localStorage.getItem(k), await draftKey(page));

test('a slow answer does not keep the text in the box: it empties when the message is sent, and the message arrives once', async ({ authed: page }) => {
  const tag = uniq('slow-answer');
  await page.route(MESSAGE, async (route) => {
    await new Promise((r) => setTimeout(r, 2500));
    await route.continue();
  });
  await say(page, `slow answer ${tag}`);
  // The server has not answered yet.
  await expect.poll(() => boxText(page.locator(`.orch ${BOX}`)), { timeout: 1_000 }).toBe('');
  await expect(page.locator('.orch .msg-user', { hasText: tag })).toHaveCount(1);
  expect(await mine(page.request, tag)).toHaveLength(1);
});

test('sending while the orchestrator is mid-turn: each message empties the box and is queued', async ({ authed: page }) => {
  const tag = uniq('busy');
  await say(page, `#slow first ${tag}`);
  await expect(page.locator(`.orch ${BOX}`)).toHaveText('');
  await expect(page.locator('.orch .composer').getByRole('button', { name: 'Stop' }).first()).toBeVisible();
  await say(page, `second ${tag}`);
  await expect.poll(() => boxText(page.locator(`.orch ${BOX}`)), { timeout: 3_000 }).toBe('');
  await expect.poll(async () => (await mine(page.request, tag)).length, { timeout: 10_000 }).toBe(2);
  await page.waitForTimeout(1_000);
  expect(await savedDraft(page)).toBeNull();
});

test('a message the server refuses stays in the box, with the reason', async ({ authed: page }) => {
  const tag = uniq('refused');
  await page.route(MESSAGE, (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'the orchestrator is starting' }) }));
  await say(page, `refused ${tag}`);
  const toast = page.locator('.toast', { hasText: 'Not sent' });
  await expect(toast).toContainText('the orchestrator is starting');
  await expect.poll(() => boxText(page.locator(`.orch ${BOX}`))).toBe(`refused ${tag}`);
  expect(await mine(page.request, tag)).toHaveLength(0);
  // The words are kept as a draft too, so a reload does not lose them.
  await expect.poll(() => savedDraft(page)).toBe(`refused ${tag}`);
});

test('an answer lost after the message got through: the text comes back, and sending it again does not say it twice', async ({ authed: page }) => {
  const tag = uniq('lost');
  await page.route(MESSAGE, async (route) => {
    await route.fetch();
    await route.abort('connectionreset');
  });
  await say(page, `lost answer ${tag}`);
  await expect(page.locator('.toast', { hasText: 'Not sent' }).first()).toBeVisible();
  await expect.poll(() => boxText(page.locator(`.orch ${BOX}`))).toBe(`lost answer ${tag}`);
  // The server did get it.
  expect(await mine(page.request, tag)).toHaveLength(1);
  // Sending the restored text again is the same message: the server takes it once.
  await page.unroute(MESSAGE);
  await say(page, `lost answer ${tag}`);
  await expect.poll(() => boxText(page.locator(`.orch ${BOX}`)), { timeout: 3_000 }).toBe('');
  await page.waitForTimeout(1_000);
  expect(await mine(page.request, tag)).toHaveLength(1);
});

test('the page reloads while a message is on its way: no draft of it comes back', async ({ authed: page }) => {
  const tag = uniq('reload');
  await page.route(MESSAGE, async (route) => {
    await route.fetch();
    // Never answered: the page goes away first.
    await new Promise(() => {});
  });
  await say(page, `reload ${tag}`);
  await expect.poll(async () => (await mine(page.request, tag)).length).toBe(1);
  await page.reload();
  const box = page.locator(`.orch ${BOX}`);
  await expect(box).toBeVisible();
  expect(await boxText(box)).toBe('');
  expect(await savedDraft(page)).toBeNull();
});
