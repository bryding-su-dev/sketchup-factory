import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { ALPHA, BOX, appState, expect, expectNoHorizontalOverflow, isMobile, sendToChat, test, uniq } from './fixtures.ts';
import type { TranscriptEvent, WorkItem } from '../shared/types.ts';
import { REPLY_MARK } from '../shared/replies.ts';

/**
 * Replying to a message and reacting to it in your own orchestrator chat (w866, docs/orchestrators.md "Replies and
 * reactions"). The fake agent echoes what a person says ("Echo: ..."), so its answer shows what the orchestrator was
 * handed: the words, FF Factory's mark and the quoted message for a reply; the `[reaction]` line for a reaction.
 */

async function transcript(request: APIRequestContext, id: string): Promise<TranscriptEvent[]> {
  const r = await request.get(`/api/sessions/${id}/events?limit=500`);
  expect(r.ok()).toBeTruthy();
  return r.json();
}

/** Say `text` in your chat through the composer. */
async function say(page: Page, text: string) {
  const box = page.locator(`.orch ${BOX}`);
  await box.fill(text);
  if (isMobile(page)) await page.locator('.orch .composer').getByRole('button', { name: 'Send' }).click();
  else await box.press('Enter');
}

/** Show a message's Reply and React buttons the way the device does: hover with a pointer, a tap on a touch screen. */
async function showActions(page: Page, message: Locator) {
  if (isMobile(page)) await message.locator('.md, .bubble, .notice-text').first().tap();
  else await message.hover();
  await expect(message.getByRole('toolbar', { name: 'Message actions' })).toBeVisible();
}

/**
 * Press one of a message's buttons. Other tests share this chat and its answers scroll the page, which ends a hover, so
 * showing the buttons and pressing one is retried together.
 */
async function press(page: Page, message: Locator, name: string) {
  await expect(async () => {
    await showActions(page, message);
    await message.getByRole('button', { name, exact: true }).click({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
}

const answerTo = (page: Page, tag: string) => page.locator('.orch .msg-assistant', { hasText: `Echo: ${tag}` }).first();

test('reply: Reply on the orchestrator’s answer quotes it above the new message, and the orchestrator is handed it after the words', async ({ authed: page }) => {
  const tag = uniq('reply');
  await say(page, `first ${tag}`);
  const first = answerTo(page, `first ${tag}`);
  await expect(first).toBeVisible();

  await press(page, first, 'Reply');
  const bar = page.getByTestId('composer-reply');
  await expect(bar).toContainText('Replying to Orchestrator');
  await expect(bar).toContainText(`Echo: first ${tag}`);

  // The bar can be dropped: the next message is a plain one.
  await bar.getByRole('button', { name: 'Cancel the reply' }).click();
  await expect(bar).toHaveCount(0);
  await first.scrollIntoViewIfNeeded();
  await press(page, first, 'Reply');
  await expect(bar).toBeVisible();

  await say(page, `yes, that one ${tag}`);
  const mine = page.locator('.orch .msg-user', { hasText: `yes, that one ${tag}` });
  await expect(mine).toBeVisible();
  await expect(bar).toHaveCount(0);
  // The chat shows the reply linked to what it answers, and only the words in the bubble.
  const quote = mine.getByTestId('reply-quote');
  await expect(quote).toContainText('Orchestrator');
  await expect(quote).toContainText(`Echo: first ${tag}`);
  await expect(mine.locator('.bubble-text')).toHaveText(`yes, that one ${tag}`);
  await expect(mine).not.toContainText(REPLY_MARK);

  // What the orchestrator was handed: his words, then the mark, then the message quoted by the server.
  const answer = page.locator('.orch .msg-assistant', { hasText: `Echo: yes, that one ${tag}` });
  await expect(answer).toBeVisible();
  const events = await transcript(page.request, (await appState(page.request)).orchestratorId);
  const sent = events.find((e) => e.kind === 'user' && e.from === 'human' && e.text.startsWith(`yes, that one ${tag}`));
  expect(sent && sent.kind === 'user' ? sent.text : '').toMatch(new RegExp(`^yes, that one ${tag}\\n\\n${REPLY_MARK.replace(/[[\]]/g, '\\$&')}\\n#\\d+ · the orchestrator · \\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d UTC\\n> Echo: first ${tag}`));
  await expect
    .poll(async () => {
      const echoed = (await transcript(page.request, (await appState(page.request)).orchestratorId)).find((e) => e.kind === 'assistant' && e.text.startsWith(`Echo: yes, that one ${tag}`));
      return echoed && echoed.kind === 'assistant' ? echoed.text : '';
    })
    .toContain(`${REPLY_MARK}\n#`);

  // Pressing the quote goes to the message (and the page does not scroll sideways).
  await quote.click();
  await expect(first).toHaveClass(/flash/);
  await expectNoHorizontalOverflow(page);
});

test('reply: your own message and a relayed worker update can be replied to too', async ({ authed: page }) => {
  test.skip(isMobile(page), 'the worker is started through the dispatcher once; the desktop project is enough');
  const tag = uniq('upd');
  const me = await appState(page.request);
  const call = async (chatId: string, tool: string, args: Record<string, unknown>) => {
    const before = (await transcript(page.request, chatId)).at(-1)?.seq ?? 0;
    await sendToChat(page.request, chatId, `#tool ${tool} ${JSON.stringify(args)}`);
    let answer = '';
    await expect
      .poll(async () => {
        const r = (await transcript(page.request, chatId)).find((e) => e.seq > before && e.kind === 'assistant' && e.text.startsWith(`Called ${tool}:`));
        answer = r && r.kind === 'assistant' ? r.text : '';
        return answer;
      })
      .not.toBe('');
    return answer;
  };
  await call(me.orchestratorId, 'request_work', { title: `Skip button ${tag}`, brief: 'Add a skip button.' });
  let w: WorkItem | undefined;
  await expect.poll(async () => (w = (await appState(page.request)).work?.find((x) => x.title === `Skip button ${tag}`)) !== undefined).toBe(true);
  await call(me.dispatcherId!, 'start_agent', { sandbox: ALPHA, prompt: `add a skip button ${tag}`, title: `Skip ${tag}`, work_id: w!.id });
  const notice = page.locator('.orch .notice', { hasText: `Skip ${tag}` });
  await expect(notice).toBeVisible();

  await press(page, notice, 'Reply');
  await expect(page.getByTestId('composer-reply')).toContainText('Replying to Worker update');
  await say(page, `thanks ${tag}`);
  const mine = page.locator('.orch .msg-user', { hasText: `thanks ${tag}` });
  await expect(mine.getByTestId('reply-quote')).toContainText('Worker update');
  await expect(mine.getByTestId('reply-quote')).toContainText(`Skip ${tag}`);

  // Your own message too.
  await press(page, mine, 'Reply');
  await expect(page.getByTestId('composer-reply')).toContainText('Replying to You');
  await page.getByTestId('composer-reply').getByRole('button', { name: 'Cancel the reply' }).click();
});

test('reaction: an emoji shows on the message, reaches the orchestrator as a short response with the message quoted, and can be taken back', async ({ authed: page }) => {
  const tag = uniq('react');
  await say(page, `shall we ${tag}`);
  const asked = answerTo(page, `shall we ${tag}`);
  await expect(asked).toBeVisible();
  const orchestratorId = (await appState(page.request)).orchestratorId;

  await press(page, asked, 'React');
  await asked.getByRole('button', { name: 'React 👍' }).click();
  const chip = asked.getByTestId('msg-reactions').getByRole('button', { name: 'Take back your 👍 reaction' });
  await expect(chip).toBeVisible();

  // The orchestrator answers it like a message; the harness line itself is not a row of the chat.
  const reaction = page.locator('.orch .msg-assistant', { hasText: 'Echo: [reaction]' }).filter({ hasText: `Echo: shall we ${tag}` });
  await expect(reaction).toBeVisible();
  await expect(reaction).toContainText('reacted 👍 to a message in this chat');
  await expect(reaction).toContainText(`Echo: shall we ${tag}`);
  await expect(reaction).toContainText("It is a click, not tester's own words");
  await expect(page.locator('.orch .notice', { hasText: '[reaction]' })).toHaveCount(0);
  const events = await transcript(page.request, orchestratorId);
  // Other tests share this chat: find our reaction line by the message it quotes.
  const sent = events.find((e) => e.kind === 'user' && e.text.startsWith('[reaction]') && e.text.includes(`> Echo: shall we ${tag}`));
  expect(sent && sent.kind === 'user' ? [sent.from, sent.text.startsWith('[reaction] tester reacted 👍 to a message in this chat:\n#')] : []).toEqual(['system', true]);

  // It stays across a reload (the chat is the record), then one press takes it back; nothing more is sent to the orchestrator.
  await page.reload();
  const again = answerTo(page, `shall we ${tag}`);
  await expect(again.getByTestId('msg-reactions')).toContainText('👍');
  // Other tests share this chat: count the reaction lines only.
  const reactionLines = async () => (await transcript(page.request, orchestratorId)).filter((e) => e.kind === 'user' && e.text.startsWith('[reaction]')).length;
  const count = await reactionLines();
  await again.getByRole('button', { name: 'Take back your 👍 reaction' }).click();
  await expect(again.getByTestId('msg-reactions')).toHaveCount(0);
  await expect.poll(async () => (await transcript(page.request, orchestratorId)).filter((e) => e.kind === 'system').some((e) => e.kind === 'system' && e.text.startsWith('[reaction removed] 👍 #'))).toBe(true);
  expect(await reactionLines()).toBe(count);
  await expectNoHorizontalOverflow(page);
});

test('reply and reaction over the API: only a message of your own orchestrator chat, only your own chat', async ({ authed: page }) => {
  test.skip(isMobile(page), 'server behaviour; the desktop project is enough');
  const tag = uniq('api');
  const me = await appState(page.request);
  await sendToChat(page.request, me.orchestratorId, `hello ${tag}`);
  await expect.poll(async () => (await transcript(page.request, me.orchestratorId)).some((e) => e.kind === 'assistant' && e.text === `Echo: hello ${tag}`)).toBe(true);
  const msg = (await transcript(page.request, me.orchestratorId)).find((e) => e.kind === 'assistant' && e.text === `Echo: hello ${tag}`)!;
  const tool = (await transcript(page.request, me.orchestratorId)).find((e) => e.kind === 'tool_use');
  const post = (path: string, data: unknown) => page.request.post(path, { data });

  expect((await post(`/api/sessions/${me.orchestratorId}/react`, { seq: msg.seq, emoji: 'nope' })).status()).toBe(400);
  expect((await post(`/api/sessions/${me.orchestratorId}/react`, { seq: 99999, emoji: '👍' })).status()).toBe(400);
  if (tool) expect((await post(`/api/sessions/${me.orchestratorId}/react`, { seq: tool.seq, emoji: '👍' })).status()).toBe(400);
  expect((await post(`/api/sessions/${me.orchestratorId}/message`, { text: 'x', replyTo: 99999 })).status()).toBe(400);
  expect((await post(`/api/sessions/${me.orchestratorId}/message`, { text: '/compact', replyTo: msg.seq })).ok(), 'a reply is a message, never a command').toBeTruthy();
  expect((await transcript(page.request, me.orchestratorId)).some((e) => e.kind === 'user' && e.text.startsWith('/compact\n\n'))).toBe(true);
  expect((await post(`/api/sessions/${me.orchestratorId}/react`, { seq: msg.seq, emoji: '🎉' })).ok()).toBeTruthy();
  expect(await (await post(`/api/sessions/${me.orchestratorId}/react`, { seq: msg.seq, emoji: '🎉' })).json()).toEqual({ changed: false });
  expect(await (await post(`/api/sessions/${me.orchestratorId}/react`, { seq: msg.seq, emoji: '🎉', on: false })).json()).toEqual({ changed: true });

  // Workers have no reactions, the dispatcher's chat is nobody's.
  const worker = (await appState(page.request)).sessions.find((s) => s.kind === 'worker');
  if (worker) expect((await post(`/api/sessions/${worker.id}/react`, { seq: 1, emoji: '👍' })).status()).toBe(400);
  expect((await post(`/api/sessions/${me.dispatcherId}/react`, { seq: 1, emoji: '👍' })).status()).toBeGreaterThanOrEqual(400);
});
