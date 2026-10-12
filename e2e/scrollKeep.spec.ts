import type { APIRequestContext, Locator, Page } from '@playwright/test';
import type { TranscriptEvent } from '../shared/types.ts';
import { ALPHA, appState, expect, go, openSandbox, sendMessage, sendToChat, startWorker, test, uniq } from './fixtures.ts';

/**
 * Leaving a page and coming back keeps the reader's place (w1100): at the bottom, a chat is still at the bottom, with what
 * came meanwhile; scrolled up, it is at the same message, with "New messages" for the newer ones. Lists keep theirs too.
 *
 * The chats are full of pictures, as real ones are: an image loads lazily, so a chat drawn again grows after it is drawn,
 * and the scroll handler once took that growth for the reader leaving the bottom (Transcript.tsx onScroll).
 */

const PIC_H = 260;
const pic = (n: number) =>
  `data:image/svg+xml;base64,${Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="500" height="${PIC_H}"><rect width="500" height="${PIC_H}" fill="#${(((n + 3) * 40013) % 0xffffff).toString(16).padStart(6, '0')}"/></svg>`).toString('base64')}`;
const rowText = (i: number, tag: string) => `row ${i} ${tag} ![pic](${pic(i)})`;

const reply = (scope: Locator, tag: string, i: number) => scope.locator('.msg-assistant', { hasText: `row ${i} ${tag}` });
const gap = (sc: Locator) => sc.evaluate((el) => Math.round(el.scrollHeight - el.scrollTop - el.clientHeight));
/** How far below the top of the chat a row starts. */
const topOf = (row: Locator) => row.evaluate((el) => Math.round(el.getBoundingClientRect().top - el.closest('.transcript-scroll')!.getBoundingClientRect().top));

/** At the bottom, and staying there while the pictures finish loading. */
async function expectAtBottom(sc: Locator) {
  await expect.poll(() => gap(sc), { timeout: 10_000 }).toBeLessThanOrEqual(2);
  await sc.page().waitForTimeout(1_200);
  expect(await gap(sc), 'late pictures pushed the end away').toBeLessThanOrEqual(2);
}

/** Scroll so `row` starts `where` px below the top of the chat. */
async function scrollRowTo(row: Locator, where: number) {
  await row.evaluate((el, where) => {
    const sc = el.closest('.transcript-scroll')!;
    sc.scrollTop += el.getBoundingClientRect().top - sc.getBoundingClientRect().top - where;
  }, where);
  await row.page().waitForTimeout(600);
}

async function expectRowAt(row: Locator, where: number) {
  await expect.poll(() => topOf(row), { timeout: 10_000 }).toBeGreaterThanOrEqual(where - 3);
  await row.page().waitForTimeout(1_200);
  expect(Math.abs((await topOf(row)) - where), 'the row is not where it was left').toBeLessThanOrEqual(3);
}

/** One chat, three ways: pinned to the bottom, scrolled up, and with a message that arrives while away. */
async function keepsPlace(opts: {
  /** The chat's box (its panel or page). */
  scope: () => Locator;
  /** Leave the chat for another page, and come back to it. */
  leave: () => Promise<void>;
  back: () => Promise<void>;
  send: (text: string) => Promise<void>;
}) {
  const { scope, leave, back } = opts;
  const tag = uniq('keep');
  for (let i = 0; i < 9; i++) await opts.send(rowText(i, tag));
  await back();
  const sc = () => scope().locator('.transcript-scroll');
  await expect(reply(scope(), tag, 8)).toHaveCount(1);
  await expectAtBottom(sc());

  // At the bottom: still there after the trip, with the message that came while away in view.
  await leave();
  await opts.send(rowText(9, tag));
  await back();
  await expect(reply(scope(), tag, 9)).toHaveCount(1);
  await expectAtBottom(sc());
  await expect(reply(scope(), tag, 9)).toBeInViewport();
  await expect(scope().locator('.jump-pill')).toHaveCount(0);

  // Scrolled up: at the same message, with the way back down offered and "New messages" for the one that came.
  const row = () => reply(scope(), tag, 3);
  await scrollRowTo(row(), 40);
  const where = await topOf(row());
  await expect(scope().locator('.jump-pill')).toBeVisible();
  await leave();
  await opts.send(rowText(10, tag));
  await back();
  await expect(reply(scope(), tag, 10)).toHaveCount(1);
  await expectRowAt(row(), where);
  await expect(scope().locator('.jump-pill.has-new')).toContainText('New messages');
  expect(await gap(sc())).toBeGreaterThan(100);

  // And one more trip with nothing new: the same place.
  await leave();
  await back();
  await expect(reply(scope(), tag, 10)).toHaveCount(1);
  await expectRowAt(row(), where);
}

test('the orchestrator chat keeps its place across a visit to the Dispatcher', async ({ authed: page }) => {
  const me = await appState(page.request);
  await go(page, '#/');
  await keepsPlace({
    scope: () => page.locator('.orch').first(),
    leave: async () => {
      await go(page, '#/dispatcher/conversation');
      await expect(page.locator('.dispatcher-panel')).toBeVisible();
    },
    back: async () => {
      await go(page, '#/');
      await expect(page.locator('.dispatcher-panel')).toHaveCount(0);
      await expect(page.locator('.orch .composer')).toBeVisible();
    },
    send: (text) => sendMessage(page.request, me.orchestratorId, text),
  });
});

test('a worker chat in a sandbox panel keeps its place across a visit to the Overview', async ({ authed: page }) => {
  const tag = uniq('wk');
  const s = await startWorker(page.request, `first ${tag}`, { title: `Keep ${tag}` });
  await openSandbox(page, ALPHA, s.id);
  await keepsPlace({
    scope: () => page.locator('.sb-panel'),
    leave: async () => {
      await go(page, '#/overview');
      await expect(page.getByTestId('overview')).toBeVisible();
    },
    back: async () => {
      await openSandbox(page, ALPHA, s.id);
    },
    send: (text) => sendMessage(page.request, s.id, text),
  });
});

test('a worker chat on its own full-width page keeps its place across the sandbox page', async ({ authed: page }) => {
  const tag = uniq('fw');
  const s = await startWorker(page.request, `first ${tag}`, { title: `Wide ${tag}` });
  await go(page, `#/session/${s.id}`);
  await keepsPlace({
    scope: () => page.locator('.session-view'),
    leave: async () => {
      await openSandbox(page, ALPHA, s.id);
    },
    back: async () => {
      await go(page, `#/session/${s.id}`);
      await expect(page.locator('.session-full')).toBeVisible();
    },
    send: (text) => sendMessage(page.request, s.id, text),
  });
});

test("the dispatcher's own conversation keeps its place across its other tabs", async ({ authed: page }) => {
  const me = await appState(page.request);
  await go(page, '#/dispatcher/conversation');
  const panel = page.locator('.dispatcher-panel');
  await keepsPlace({
    scope: () => panel,
    leave: async () => {
      await panel.getByRole('tab', { name: /Requests/ }).click();
      await expect(panel.locator('.transcript')).toHaveCount(0);
    },
    back: async () => {
      if (!(await panel.getByRole('tab', { name: 'Conversation', selected: true }).count())) await panel.getByRole('tab', { name: 'Conversation' }).click();
      await expect(panel.locator('.transcript')).toBeVisible();
    },
    send: (text) => sendToChat(page.request, me.dispatcherId!, text),
  });
});

/** Make a list long enough to scroll: a rule in the page's head survives the list being drawn again. */
async function tall(page: Page, selector: string) {
  await page.addStyleTag({ content: `${selector}::after { content: ''; display: block; flex: none; grid-column: 1 / -1; height: 3000px; }` });
}

async function scrolled(list: Locator, to: number) {
  await list.evaluate((el, to) => el.scrollTo({ top: to }), to);
  await expect.poll(() => list.evaluate((el) => Math.round(el.scrollTop))).toBeGreaterThan(to - 5);
  await list.page().waitForTimeout(300);
  return list.evaluate((el) => Math.round(el.scrollTop));
}

test('the Overview board keeps its scroll position across another page', async ({ authed: page }) => {
  await go(page, '#/overview');
  await tall(page, '.board');
  const board = page.locator('.board');
  const at = await scrolled(board, 600);
  await go(page, '#/');
  await expect(page.locator('.board')).toHaveCount(0);
  await go(page, '#/overview');
  await expect.poll(() => board.evaluate((el) => Math.round(el.scrollTop))).toBe(at);
});

test('the Requests list keeps its scroll position across the Dispatcher conversation tab', async ({ authed: page }) => {
  const me = await appState(page.request);
  const tag = uniq('rq');
  const events = async () => (await (await page.request.get(`/api/sessions/${me.orchestratorId}/events?limit=500`)).json()) as TranscriptEvent[];
  const before = (await events()).at(-1)?.seq ?? 0;
  await sendMessage(page.request, me.orchestratorId, `#tool request_work ${JSON.stringify({ title: `Keep the list ${tag}`, brief: `Nothing ${tag}.` })}`);
  await expect.poll(async () => (await events()).some((e) => e.seq > before && e.kind === 'assistant' && e.text.startsWith('Called request_work:')), { timeout: 15_000 }).toBe(true);
  await go(page, '#/dispatcher');
  const panel = page.locator('.dispatcher-panel');
  await expect(panel.locator('.sa-scroll')).toBeVisible();
  await tall(page, '.dispatcher-panel .sa-scroll');
  const list = panel.locator('.sa-scroll');
  const at = await scrolled(list, 500);
  await panel.getByRole('tab', { name: 'Conversation' }).click();
  await expect(panel.locator('.sa-scroll')).toHaveCount(0);
  await panel.getByRole('tab', { name: /Requests/ }).click();
  await expect.poll(() => list.evaluate((el) => Math.round(el.scrollTop))).toBe(at);
});
