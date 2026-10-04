import type { APIRequestContext, Browser, BrowserContext, BrowserContextOptions, Page } from '@playwright/test';
import { BOX, appState, expect, go, isMobile, openSidebar, sendMessage, test, uniq } from './fixtures.ts';
import type { ServerEvent, TranscriptEvent, WorkItem } from '../shared/types.ts';

/**
 * People's own orchestrators and the dispatcher (docs/orchestrators.md), in the browser and over the API. The test
 * server's logins are tester (the owner) and teammate ("Team Mate", a member), e2e/server.ts. The fake agent calls a
 * tool of its session's belt when a person's message says "#tool <name> <json>" (e2e/fakeAgent.ts), so the ledger's
 * filing, overlap check and decisions run through the real tools. Tests share one server per project: each works with
 * its own tag and its own spec number.
 */

const MATE = { userId: 'teammate', displayName: 'Team Mate' };

/** A browser context signed in as the teammate, with the project's device. */
async function mateContext(browser: Browser): Promise<BrowserContext> {
  const ctx = await browser.newContext(test.info().project.use as BrowserContextOptions);
  // The server hashes at most two passwords at once; parallel workers retry as it asks.
  await expect(async () => {
    const r = await ctx.request.post('/api/login', { data: { username: MATE.userId, password: 'e2e-teammate-456' } });
    expect(r.ok(), await r.text()).toBeTruthy();
  }).toPass({ intervals: [100, 200, 400, 800], timeout: 15_000 });
  return ctx;
}

async function transcript(request: APIRequestContext, id: string): Promise<TranscriptEvent[]> {
  const r = await request.get(`/api/sessions/${id}/events?limit=500`);
  expect(r.ok()).toBeTruthy();
  return r.json();
}

/** What a harness message said to a session, by its tag at a line start ("[dispatch]", "[worker update]"). */
async function heard(request: APIRequestContext, id: string, tag: string, containing = ''): Promise<string[]> {
  return (await transcript(request, id)).filter((e) => e.kind === 'user' && e.from === 'system' && e.text.split('\n').some((l) => l.startsWith(tag)) && e.text.includes(containing)).map((e) => (e as { text: string }).text);
}

/** Ask an orchestrator's fake model to call one of its tools; resolves to what the tool answered. */
async function useTool(request: APIRequestContext, chatId: string, tool: string, args: Record<string, unknown>): Promise<string> {
  const before = (await transcript(request, chatId)).at(-1)?.seq ?? 0;
  await sendMessage(request, chatId, `#tool ${tool} ${JSON.stringify(args)}`);
  let answer = '';
  await expect
    .poll(async () => {
      const r = (await transcript(request, chatId)).find((e) => e.seq > before && e.kind === 'assistant' && e.text.startsWith(`Called ${tool}:`));
      answer = r && r.kind === 'assistant' ? r.text : '';
      return answer;
    }, { timeout: 15_000 })
    .not.toBe('');
  return answer.slice(`Called ${tool}: `.length);
}

async function workTitled(request: APIRequestContext, title: string): Promise<WorkItem> {
  let item: WorkItem | undefined;
  await expect
    .poll(async () => {
      item = (await appState(request)).work?.find((w) => w.title === title);
      return !!item;
    })
    .toBe(true);
  return item!;
}

/** The 'notify' events a page's socket receives. */
function notices(page: Page): { tag: string; users?: string[] }[] {
  const got: { tag: string; users?: string[] }[] = [];
  page.on('websocket', (ws) =>
    ws.on('framereceived', (f) => {
      try {
        const e = JSON.parse(String(f.payload)) as ServerEvent;
        if (e.type === 'notify') got.push({ tag: e.notice.tag, users: e.users });
      } catch {
        // not JSON
      }
    }),
  );
  return got;
}

test('two people chat at the same time: each in their own orchestrator, and neither chat gets the other’s messages', async ({ authed: page, browser }) => {
  const mine = notices(page);
  // The fixture opened the page before this listened: a fresh socket, heard from the start.
  await page.reload();
  const mateCtx = await mateContext(browser);
  try {
    const matePage = await mateCtx.newPage();
    const theirs = notices(matePage);
    await matePage.goto('/');
    await expect(matePage.locator(`.orch ${BOX}`)).toBeVisible();
    await expect(page.locator(`.orch ${BOX}`)).toBeVisible();
    const [a, b] = [uniq('mine'), uniq('theirs')];
    const say = async (p: Page, text: string) => {
      const box = p.locator(`.orch ${BOX}`);
      await box.fill(text);
      if (isMobile(p)) await p.locator('.orch .composer').getByRole('button', { name: 'Send' }).click();
      else await box.press('Enter');
    };
    await Promise.all([say(page, `the owner asks ${a}`), say(matePage, `the teammate asks ${b}`)]);

    await expect(page.locator('.orch .msg-assistant', { hasText: `Echo: the owner asks ${a}` })).toBeVisible();
    await expect(matePage.locator('.orch .msg-assistant', { hasText: `Echo: the teammate asks ${b}` })).toBeVisible();
    await expect(page.locator('.orch', { hasText: b })).toHaveCount(0);
    await expect(matePage.locator('.orch', { hasText: a })).toHaveCount(0);

    const [me, mate] = [await appState(page.request), await appState(mateCtx.request)];
    expect(me.me).toMatchObject({ userId: 'tester', role: 'owner' });
    expect(mate.me).toMatchObject({ userId: 'teammate', role: 'member' });
    expect(me.orchestratorId).not.toBe(mate.orchestratorId);
    expect(me.dispatcherId).toBe(mate.dispatcherId);
    const authors = async (r: APIRequestContext, id: string) => [...new Set((await transcript(r, id)).filter((e) => e.kind === 'user' && e.from === 'human').map((e) => (e.kind === 'user' ? e.requestedBy?.userId : '')))];
    expect(await authors(page.request, me.orchestratorId)).toEqual(['tester']);
    expect(await authors(page.request, mate.orchestratorId)).toEqual(['teammate']);

    // Only its person writes to a chat; only the owner to the dispatcher.
    expect((await mateCtx.request.post(`/api/sessions/${me.orchestratorId}/message`, { data: { text: 'let me in' } })).status()).toBe(403);
    expect((await page.request.post(`/api/sessions/${mate.orchestratorId}/message`, { data: { text: 'let me in' } })).status()).toBe(403);
    expect((await mateCtx.request.post(`/api/sessions/${me.dispatcherId}/message`, { data: { text: 'let me in' } })).status()).toBe(403);

    // Each page heard only its own chat's news.
    await expect.poll(() => mine.filter((n) => n.tag === `turn-${me.orchestratorId}`).length).toBeGreaterThan(0);
    expect(theirs.filter((n) => n.tag === `turn-${me.orchestratorId}`)).toEqual([]);
    expect(mine.filter((n) => n.tag === `turn-${mate.orchestratorId}`)).toEqual([]);

    // The owner can read the teammate's conversation, and not write in it.
    const sidebar = await openSidebar(page);
    await sidebar.getByRole('button', { name: /^Team Mate/ }).click();
    const theirChat = page.locator('.orch-readonly');
    await expect(theirChat.locator('.orch-name')).toHaveText('Team Mate');
    await expect(theirChat.locator('.msg-user', { hasText: b })).toBeVisible();
    await expect(theirChat.getByTestId('read-only-note')).toContainText('only Team Mate writes here');
    await expect(theirChat.locator('.composer')).toHaveCount(0);
  } finally {
    await mateCtx.close();
  }
});

test('the ledger dedupes: the overlap is found at once, a repeat is the same request, and the dispatcher merges it', async ({ authed: page, browser }) => {
  test.skip(isMobile(page), 'server behaviour; the desktop project is enough');
  const mateCtx = await mateContext(browser);
  try {
    const tag = uniq('dedupe');
    const spec = String(1000 + Math.floor(Math.random() * 9000));
    const [me, mate] = [await appState(page.request), await appState(mateCtx.request)];
    const dispatcher = me.dispatcherId!;

    const first = await useTool(page.request, me.orchestratorId, 'request_work', { title: `Fix belt splitter desync (spec ${spec}) ${tag}`, brief: 'Players desync when a splitter feeds three belts.', priority: 'high' });
    expect(first).toMatch(/^Filed w\d+ with the dispatcher\./);
    const a = await workTitled(page.request, `Fix belt splitter desync (spec ${spec}) ${tag}`);

    const second = await useTool(mateCtx.request, mate.orchestratorId, 'request_work', { title: `Belt splitter desync on load ${tag}`, brief: `Seen on spec ${spec} builds after loading a save.` });
    expect(second).toContain(`Possible overlap: ${a.id} "Fix belt splitter desync (spec ${spec}) ${tag}" (same spec ${spec}, similar title, strong)`);
    const b = await workTitled(mateCtx.request, `Belt splitter desync on load ${tag}`);
    expect(b.overlaps[0]).toMatchObject({ ref: a.id, kind: 'work', score: 0.8 });

    expect(await useTool(mateCtx.request, mate.orchestratorId, 'request_work', { title: `belt splitter desync ON LOAD ${tag}`, brief: 'Again.' })).toBe(`Already filed as ${b.id} (new); the new text is in its log. To change what it asks for, use update_work with a note.`);
    expect((await appState(page.request)).work!.filter((w) => w.title.toLowerCase().includes(`desync on load ${tag}`))).toHaveLength(1);

    // Starting the repeat needs a reason; merging it is the answer.
    expect(await useTool(page.request, dispatcher, 'start_agent', { sandbox: 'alpha', prompt: `fix ${tag}`, title: `Belt ${tag}`, work_id: b.id })).toMatch(new RegExp(`^ERROR: ${b.id} may repeat work in flight: ${a.id} `));
    expect(await useTool(page.request, dispatcher, 'decide_work', { id: b.id, action: 'merge', into: a.id, note: `Same fix ${tag}` })).toMatch(new RegExp(`^${b.id} merged: merged into ${a.id} `));

    const now = await appState(page.request);
    expect(now.work!.find((w) => w.id === b.id)).toMatchObject({ status: 'merged', mergedInto: a.id });
    expect(now.work!.find((w) => w.id === a.id)!.requesters.map((r) => r.userId)).toEqual(['tester', 'teammate']);
    // The teammate's orchestrator hears the decision; the owner's does not (the merge answers the teammate's request).
    await expect.poll(async () => (await heard(page.request, mate.orchestratorId, '[dispatch]', `${b.id} `)).length).toBe(1);
    expect(await heard(page.request, me.orchestratorId, '[dispatch]', `${b.id} `)).toEqual([]);
    const matePage = await mateCtx.newPage();
    await matePage.goto('/');
    await expect(matePage.locator('.orch .notice', { hasText: `Merged into ${a.id}: “Belt splitter desync on load ${tag}”` })).toBeVisible();

    // The dispatcher page lists them: the merged one under the closed ones.
    await page.goto('/#/dispatcher');
    const panel = page.locator('.dispatcher-panel');
    await expect(panel.getByTestId(`work-${a.id}`)).toContainText(`New · ${a.id} · tester, Team Mate`);
    await expect(panel.getByTestId(`work-${b.id}`)).toHaveCount(0);
    await panel.getByRole('button', { name: /closed$/ }).click();
    await expect(panel.getByTestId(`work-${b.id}`)).toContainText(`Merged into ${a.id}`);
  } finally {
    await mateCtx.close();
  }
});

test("worker updates go to the chats of the people the work is for, never to the dispatcher's or anyone else's", async ({ authed: page, browser }) => {
  test.skip(isMobile(page), 'server behaviour; the desktop project is enough');
  const mateCtx = await mateContext(browser);
  try {
    const tag = uniq('route');
    const [me, mate] = [await appState(page.request), await appState(mateCtx.request)];
    const dispatcher = me.dispatcherId!;

    // A request of the owner's, started by the dispatcher: its updates reach the owner's chat.
    await useTool(page.request, me.orchestratorId, 'request_work', { title: `Make the tutorial skippable ${tag}`, brief: 'Add a skip button.' });
    const w = await workTitled(page.request, `Make the tutorial skippable ${tag}`);
    const started = await useTool(page.request, dispatcher, 'start_agent', { sandbox: 'alpha', prompt: `add a skip button ${tag}`, title: `Skip ${tag}`, work_id: w.id });
    const worker = /Started agent (\w+)/.exec(started)![1];
    expect((await appState(page.request)).sessions.find((s) => s.id === worker)!.requestedBy?.userId).toBe('tester');
    await expect.poll(async () => (await heard(page.request, me.orchestratorId, '[worker update]', `Echo: add a skip button ${tag}`)).length).toBe(1);
    expect(await heard(page.request, mate.orchestratorId, '[worker update]', tag)).toEqual([]);
    expect(await heard(page.request, dispatcher, '[worker update]', tag)).toEqual([]);
    const item = (await appState(page.request)).work!.find((x) => x.id === w.id)!;
    expect(item).toMatchObject({ status: 'active', sessionIds: [worker], outcome: `Echo: add a skip button ${tag}` });
    await page.goto('/');
    await expect(page.locator('.orch .notice', { hasText: `Skip ${tag} finished a turn` })).toBeVisible();

    // A follow-up from the teammate's orchestrator to the teammate's own worker: the teammate hears it, nobody else.
    const r = await mateCtx.request.post('/api/sessions', { data: { sandboxId: 'alpha', prompt: `look at the inventory ${tag}`, title: `Inventory ${tag}` } });
    expect(r.ok(), await r.text()).toBeTruthy();
    const v = (await r.json()) as { id: string };
    expect(await useTool(mateCtx.request, mate.orchestratorId, 'message_agent', { session_id: v.id, text: `also the tooltips ${tag}` })).toBe('Sent, for Team Mate.');
    await expect.poll(async () => (await heard(page.request, mate.orchestratorId, '[worker update]', `Echo: also the tooltips ${tag}`)).length).toBe(1);
    expect(await heard(page.request, me.orchestratorId, '[worker update]', `Inventory ${tag}`)).toEqual([]);
    // And the owner's orchestrator may not follow up on the teammate's worker.
    expect(await useTool(page.request, me.orchestratorId, 'message_agent', { session_id: v.id, text: 'mine now' })).toBe(`ERROR: ${v.id} "Inventory ${tag}" is Team Mate's work: follow up only on tester's own workers; for anything else, request_work`);
  } finally {
    await mateCtx.close();
  }
});

test('one person messages another: it waits unread in their own chat, opens there, and the answer goes back the same way', async ({ authed: page, browser }) => {
  const tag = uniq('person');
  const mateCtx = await mateContext(browser);
  try {
    const me = await appState(page.request);
    const mateChat = (await appState(mateCtx.request)).orchestratorId;
    const matePage = await mateCtx.newPage();
    const theirs = notices(matePage);
    await matePage.goto('/#/overview');
    const text = `Could you run the firewall script on BEAST once? ${tag}`;
    const sidebar = await openSidebar(matePage);
    const row = sidebar.getByRole('button', { name: /^Orchestrator/ });
    // Other tests share this server, and a message the teammate writes to their own chat reads it (and lets the owner
    // write again): send until the unread count is seen.
    await expect(async () => {
      await sendMessage(mateCtx.request, mateChat, `ready ${tag}`);
      expect(await useTool(page.request, me.orchestratorId, 'message_person', { to: 'teammate', text })).toMatch(/^Sent to Team Mate's orchestrator/);
      await expect(row.getByTestId('unread-people')).toHaveAttribute('title', 'Unread: 1 message from tester', { timeout: 3000 });
    }).toPass({ timeout: 60_000 });
    await expect(row.getByTestId('unread-people')).toHaveText('1');
    const [m] = await heard(mateCtx.request, mateChat, '[person message]', tag);
    expect(m).toMatch(/^\[person message\] From tester's orchestrator \(user id tester\), written for tester:/);
    // The notification is the teammate's alone.
    await expect.poll(() => theirs.filter((n) => n.tag === 'person-tester').map((n) => n.users)).toContainEqual(['teammate']);

    // Opening the chat shows it, and reads it.
    await row.click();
    const notice = matePage.locator('.orch .notice.notice-attn', { hasText: tag }).last();
    await expect(notice.locator('.notice-text')).toHaveText(`tester: ${text}`);
    await expect(notice.locator('.notice-body')).toHaveText(text);
    await expect.poll(async () => (await appState(mateCtx.request)).sessions.find((s) => s.id === mateChat)?.personMessages).toBeUndefined();
    // Nobody marks someone else's chat read.
    expect((await page.request.post(`/api/sessions/${mateChat}/seen`, { data: {} })).status()).toBe(403);

    // The answer: the same tool, from the teammate's orchestrator to the owner's; the dispatcher sees neither.
    expect(await useTool(mateCtx.request, mateChat, 'message_person', { to: 'tester', text: `Done, it is allowed now. ${tag}` })).toMatch(/^Sent to tester's orchestrator/);
    await expect.poll(async () => (await heard(page.request, me.orchestratorId, '[person message]', tag)).length).toBe(1);
    expect((await heard(page.request, me.orchestratorId, '[person message]', tag))[0]).toMatch(/^\[person message\] From Team Mate's orchestrator \(user id teammate\)/);
    expect(await heard(page.request, me.dispatcherId!, '[person message]', tag)).toEqual([]);
  } finally {
    await mateCtx.close();
  }
});

test('the Dispatcher page lists your own requests first within a status and priority, for each login, with a "yours" cue', async ({ authed: page, browser }) => {
  const mateCtx = await mateContext(browser);
  try {
    const tag = uniq('mine');
    const me = await appState(page.request);
    const mate = await appState(mateCtx.request);
    // The teammate's is older, so the ledger alone would list it first.
    await useTool(mateCtx.request, mate.orchestratorId, 'request_work', { title: `Repaint the conveyor icons ${tag}`, brief: 'Teal.' });
    const theirs = await workTitled(page.request, `Repaint the conveyor icons ${tag}`);
    await useTool(page.request, me.orchestratorId, 'request_work', { title: `Speed up loading big saves ${tag}`, brief: 'Minutes now.' });
    const mine = await workTitled(page.request, `Speed up loading big saves ${tag}`);
    expect([theirs.status, mine.status, theirs.priority, mine.priority]).toEqual(['new', 'new', 'normal', 'normal']);

    const order = (p: Page) => p.locator('.dispatcher-panel .work-row').evaluateAll((rows) => rows.map((r) => r.getAttribute('data-testid')));
    const before = (ids: (string | null)[], a: string, b: string) => ids.indexOf(`work-${a}`) < ids.indexOf(`work-${b}`);

    await page.goto('/#/dispatcher');
    const panel = page.locator('.dispatcher-panel');
    await expect(panel.getByTestId(`work-${theirs.id}`)).toBeVisible();
    expect(before(await order(page), mine.id, theirs.id)).toBe(true);
    await expect(panel.getByTestId(`work-${mine.id}`).getByTestId('work-yours')).toHaveText('· yours');
    await expect(panel.getByTestId(`work-${theirs.id}`).getByTestId('work-yours')).toHaveCount(0);

    const matePage = await mateCtx.newPage();
    await matePage.goto('/#/dispatcher');
    const matePanel = matePage.locator('.dispatcher-panel');
    await expect(matePanel.getByTestId(`work-${mine.id}`)).toBeVisible();
    expect(before(await order(matePage), theirs.id, mine.id)).toBe(true);
    await expect(matePanel.getByTestId(`work-${theirs.id}`).getByTestId('work-yours')).toHaveText('· yours');
    await expect(matePanel.getByTestId(`work-${mine.id}`).getByTestId('work-yours')).toHaveCount(0);
  } finally {
    await mateCtx.close();
  }
});

test('w362: your orchestrator sets a timer, your Timers button lists it with pause and cancel, and nobody else sees it', async ({ authed: page, browser }) => {
  const me = await appState(page.request);
  const title = `desync scan ${uniq('timer')}`;
  const answer = await useTool(page.request, me.orchestratorId, 'set_timer', { title, note: 'Check FFBox for new desync PRs.', schedule: { every_minutes: 60 } });
  expect(answer).toMatch(/^Timer t-[0-9a-f]{8} ".*": every 1 h, next at /);
  const id = /Timer (t-[0-9a-f]{8})/.exec(answer)![1];
  await page.reload();
  await page.locator('.orch [data-testid="timers-button"]').click();
  const row = page.locator(`[data-testid="timer-${id}"]`);
  await expect(row).toContainText(title);
  await expect(row).toContainText('every 1 h');
  await expect(row).toContainText('Check FFBox for new desync PRs.');
  await row.getByRole('button', { name: `Pause ${title}` }).click();
  await expect(row).toContainText('paused');
  await expect(row.getByRole('button', { name: `Resume ${title}` })).toBeVisible();
  const mine = await (await page.request.get(`/api/timers/${me.orchestratorId}`)).json();
  expect(mine.timers.find((x: { id: string }) => x.id === id).state).toBe('paused');
  // Someone else's timers are not theirs to see or touch.
  const mateCtx = await mateContext(browser);
  try {
    expect((await mateCtx.request.get(`/api/timers/${me.orchestratorId}`)).status()).toBe(403);
    expect((await mateCtx.request.post(`/api/timers/${me.orchestratorId}/${id}`, { data: { action: 'cancel' } })).status()).toBe(403);
  } finally {
    await mateCtx.close();
  }
  await row.getByRole('button', { name: `Cancel ${title}` }).click();
  await expect(row).toContainText('ended');
});
