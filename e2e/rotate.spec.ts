import fs from 'node:fs';
import path from 'node:path';
import type { Locator, Page, TestInfo } from '@playwright/test';
import { expect, go, sendMessage, startWorker, test, uniq } from './fixtures.ts';

/**
 * Turning a phone between portrait and landscape keeps the reader's place in the chat (w1164): at the bottom, the chat is
 * still at the bottom; scrolled up, the same message sits at the same place on the screen. The chat is narrower or wider
 * after the turn, so its text wraps differently and every row changes height.
 */

const PORTRAIT = { width: 390, height: 844 };
const LANDSCAPE = { width: 844, height: 390 };

const WORDS = 'the quick brown fox jumps over the lazy dog while the portal keeps every message where the reader left it'.split(' ');
/** A paragraph whose length differs per row, so rows wrap to different heights at different widths. */
const rowText = (i: number, tag: string) => `row ${i} ${tag} ${Array.from({ length: 18 + ((i * 7) % 30) }, (_, k) => WORDS[(i + k) % WORDS.length]).join(' ')}`;

const reply = (scope: Locator, tag: string, i: number) => scope.locator('.msg-assistant', { hasText: `row ${i} ${tag}` });
const gap = (sc: Locator) => sc.evaluate((el) => Math.round(el.scrollHeight - el.scrollTop - el.clientHeight));

/** The message at the top of the view (the first row ending below its top edge) and where its top sits: the place the reader is at. */
const anchorOf = (sc: Locator) =>
  sc.evaluate((box) => {
    const top = box.getBoundingClientRect().top;
    for (const c of Array.from(box.firstElementChild!.children)) {
      const r = c.getBoundingClientRect();
      const seq = c.getAttribute('data-seq');
      if (r.bottom > top + 1 && seq !== null) return { seq, off: Math.round(r.top - top) };
    }
    throw new Error('no message in view');
  });
/** Where the row with that seq sits below the top of the view now. */
const offOf = (sc: Locator, seq: string) => sc.evaluate((box, seq) => Math.round(box.querySelector(`[data-seq="${seq}"]`)!.getBoundingClientRect().top - box.getBoundingClientRect().top), seq);

async function scrollRowTo(row: Locator, where: number) {
  await row.evaluate((el, where) => {
    const sc = el.closest('.transcript-scroll')!;
    sc.scrollTop += el.getBoundingClientRect().top - sc.getBoundingClientRect().top - where;
  }, where);
  await row.page().waitForTimeout(400);
}

/** Turn the phone: the screen changes size, as the browser reports it. */
async function turn(page: Page, to: { width: number; height: number }) {
  await page.setViewportSize(to);
  await page.evaluate(() => window.dispatchEvent(new Event('orientationchange')));
  await page.waitForTimeout(800);
}

/** The screen as a picture: in the report, and in the folder named by ROTATE_SHOTS when set (the before/after pictures of the pull request). */
async function shot(page: Page, info: TestInfo, name: string) {
  const body = await page.screenshot();
  await info.attach(name, { body, contentType: 'image/png' });
  if (process.env.ROTATE_SHOTS) {
    fs.mkdirSync(process.env.ROTATE_SHOTS, { recursive: true });
    fs.writeFileSync(path.join(process.env.ROTATE_SHOTS, `${info.project.name}-${name}.png`), body);
  }
}

/**
 * A long chat of a worker of its own, on its full-width page: the Transcript is the one the orchestrator chat uses, and a chat
 * of its own is not grown by the messages other tests send to the owner's orchestrator (scrollKeep.spec.ts reads that one).
 */
async function longChat(page: Page, tag: string) {
  const s = await startWorker(page.request, `first ${tag}`, { title: `Turn ${tag}` });
  await go(page, `#/session/${s.id}`);
  for (let i = 0; i < 14; i++) await sendMessage(page.request, s.id, rowText(i, tag));
  const scope = page.locator('.session-view');
  await expect(reply(scope, tag, 13)).toHaveCount(1);
  return scope;
}

for (const [name, from, to] of [
  ['portrait to landscape and back', PORTRAIT, LANDSCAPE],
  ['landscape to portrait and back', LANDSCAPE, PORTRAIT],
] as const) {
  test(`rotating a phone, ${name}: a chat at the bottom stays at the bottom`, async ({ authed: page }, info) => {
    test.skip(info.project.name !== 'mobile-chrome' && info.project.name !== 'mobile-safari', 'a phone');
    await page.setViewportSize(from);
    const tag = uniq('rot');
    const scope = await longChat(page, tag);
    const sc = scope.locator('.transcript-scroll');
    await expect.poll(() => gap(sc)).toBeLessThanOrEqual(2);
    await shot(page, info, `1-${name}-pinned-before`);

    await turn(page, to);
    await shot(page, info, `2-${name}-pinned-turned`);
    await expect.poll(() => gap(sc), { message: 'after the first turn the chat left the bottom', timeout: 3_000 }).toBeLessThanOrEqual(2);

    await turn(page, from);
    await shot(page, info, `3-${name}-pinned-back`);
    await expect.poll(() => gap(sc), { message: 'after turning back the chat left the bottom', timeout: 3_000 }).toBeLessThanOrEqual(2);
  });

  test(`rotating a phone, ${name}: a chat scrolled up keeps the same message in the same place`, async ({ authed: page }, info) => {
    test.skip(info.project.name !== 'mobile-chrome' && info.project.name !== 'mobile-safari', 'a phone');
    await page.setViewportSize(from);
    const tag = uniq('rot');
    const scope = await longChat(page, tag);
    const sc = scope.locator('.transcript-scroll');
    const row = reply(scope, tag, 6);
    await scrollRowTo(row, 60);
    const at = await anchorOf(sc);
    await shot(page, info, `1-${name}-up-before`);

    await turn(page, to);
    await shot(page, info, `2-${name}-up-turned`);
    expect.soft(Math.abs((await offOf(sc, at.seq)) - at.off), 'after the first turn the message at the top of the chat moved').toBeLessThanOrEqual(3);

    await turn(page, from);
    await shot(page, info, `3-${name}-up-back`);
    expect.soft(Math.abs((await offOf(sc, at.seq)) - at.off), 'after turning back the message at the top of the chat moved').toBeLessThanOrEqual(3);
    expect.soft(await gap(sc), 'the chat was dragged to the bottom').toBeGreaterThan(100);
  });
}
