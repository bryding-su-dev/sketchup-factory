import type { APIRequestContext, Browser, BrowserContext, BrowserContextOptions } from '@playwright/test';
import { BOX, appState, boxText, expect, go, sendMessage, test, uniq } from './fixtures.ts';
import type { TranscriptEvent } from '../shared/types.ts';

/**
 * w518 (asked by Lothsahn): `/compact [focus]` typed in an orchestrator's chat compacts its conversation instead of
 * reaching the model as text, says so in the chat with the context before and after, and leaves its wake_me check-in
 * alone; the dispatcher, which nobody chats with, has an owner-only Compact conversation; `/clear` asks before starting
 * a new conversation. The fake agent answers "/compact" as the CLI does (e2e/fakeAgent.ts). The orchestrator is shared
 * by the tests on a server, so a compaction refused because another test's turn is running is tried again.
 */

async function mateContext(browser: Browser): Promise<BrowserContext> {
  const ctx = await browser.newContext(test.info().project.use as BrowserContextOptions);
  await expect(async () => {
    const r = await ctx.request.post('/api/login', { data: { username: 'teammate', password: 'e2e-teammate-456' } });
    expect(r.ok(), await r.text()).toBeTruthy();
  }).toPass({ intervals: [100, 200, 400, 800], timeout: 15_000 });
  return ctx;
}

async function transcript(request: APIRequestContext, id: string): Promise<TranscriptEvent[]> {
  const r = await request.get(`/api/sessions/${id}/events?limit=500`);
  expect(r.ok()).toBeTruthy();
  return r.json();
}

test('/compact in your own chat compacts the conversation, says the context before and after', async ({ authed: page }) => {
  const tag = uniq('compact');
  const me = await appState(page.request);
  const id = me.orchestratorId;
  await sendMessage(page.request, id, `before compacting ${tag}`);
  await expect(page.locator('.orch .msg-assistant', { hasText: `Echo: before compacting ${tag}` })).toBeVisible({ timeout: 15_000 });

  const box = page.locator(`.orch ${BOX}`);
  await box.fill(`/compact keep ${tag}`);
  // Sent once it is between turns (the box empties); a refusal leaves the text in the box to send again.
  await expect(async () => {
    if ((await boxText(box)) !== '') await page.locator('.orch .composer').getByRole('button', { name: 'Send' }).click();
    await expect.poll(() => boxText(box), { timeout: 1_000 }).toBe('');
  }).toPass({ timeout: 20_000 });

  await expect(page.locator('.orch .sys-line', { hasText: `with the focus: keep ${tag}` })).toBeVisible();
  await expect(page.locator('.orch .sys-line', { hasText: /^Compacted: the context went from [\d,]+ tokens to 18,000 tokens/ }).last()).toBeVisible({ timeout: 15_000 });
  const evs = await transcript(page.request, id);
  // The command never reached the model as a message.
  expect(evs.some((e) => e.kind === 'user' && e.text.includes(`/compact keep ${tag}`))).toBe(false);
});

test("the dispatcher's Compact conversation is an owner's only", async ({ authed: page, browser }) => {
  const me = await appState(page.request);
  const dispatcher = me.dispatcherId!;
  const mateCtx = await mateContext(browser);
  try {
    const mate = await mateCtx.request.post(`/api/sessions/${dispatcher}/compact`, { data: {} });
    expect(mate.status()).toBe(403);
  } finally {
    await mateCtx.close();
  }
  await sendMessage(page.request, dispatcher, `a dispatcher turn ${uniq('disp')}`);
  await expect(async () => {
    const r = await page.request.post(`/api/sessions/${dispatcher}/compact`, { data: {} });
    expect(r.ok(), await r.text()).toBeTruthy();
  }).toPass({ timeout: 20_000 });
  await expect.poll(async () => (await transcript(page.request, dispatcher)).filter((e) => e.kind === 'system' && e.text.startsWith('Compacted:')).length, { timeout: 15_000 }).toBe(1);

  // The same from its page: the owner's menu.
  await go(page, '#/dispatcher/conversation');
  const panel = page.locator('.dispatcher-panel');
  await panel.getByRole('button', { name: 'Dispatcher options' }).click();
  await page.getByRole('button', { name: 'Compact conversation' }).click();
  await expect(panel.locator('.sys-line', { hasText: /^Compacted:/ })).toHaveCount(2, { timeout: 15_000 });
});

test('/compact mid-turn is refused with why', async ({ authed: page }) => {
  const me = await appState(page.request);
  await sendMessage(page.request, me.orchestratorId, `take your time #slow ${uniq('slow')}`);
  const r = await page.request.post(`/api/sessions/${me.orchestratorId}/message`, { data: { text: '/compact' } });
  expect(r.status()).toBe(409);
  expect(((await r.json()) as { error: string }).error).toMatch(/^Not compacted: it is mid-turn/);
});

test('/clear asks before starting a new conversation, as the menu does', async ({ authed: page }) => {
  const box = page.locator(`.orch ${BOX}`);
  await box.fill('/clear');
  await page.locator('.orch .composer').getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText('Start a new conversation?')).toBeVisible();
  await expect.poll(() => boxText(box)).toBe('');
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByText('Start a new conversation?')).toHaveCount(0);
});
