import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appState, expect, expectNoHorizontalOverflow, openSidebar, signIn, startWorker, test, uniq } from './fixtures.ts';

// The Bedrock backend in the UI (docs/bedrock.md): the badge, the Plan | Bedrock | Auto control, an agent's tag.
// The e2e server has bedrock.profile set and a probe that always answers "AWS works" (FFSB_BEDROCK_PROBE); AWS is
// never called. The tests change the one server-wide mode, so they run in order and put it back to Plan.

test.describe.configure({ mode: 'serial' });

test.beforeEach(async ({ page }) => {
  await signIn(page);
});

test.afterAll(async ({ request }) => {
  // The request fixture of afterAll carries no login: sign in through it.
  await request.post('/api/login', { data: { username: 'tester', password: 'e2e-password-123' } });
  await request.post('/api/backend/mode', { data: { mode: 'plan' } });
});

test('the badge says Plan by default and the mode control is there', async ({ page }) => {
  await page.goto('/');
  const sidebar = await openSidebar(page);
  const badge = sidebar.getByTestId('backend-badge');
  await expect(badge).toBeVisible();
  await expect(badge).toContainText('Plan');
  await expect(badge).toHaveAttribute('data-active', 'plan');
  await expect(sidebar.getByTestId('backend-mode')).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

test('Bedrock: confirm, the badge turns Bedrock, an agent shows its tag; Plan returns', async ({ page }) => {
  const request = page.request;
  await page.goto('/');
  const sidebar = await openSidebar(page);
  const asked: string[] = [];

  // A refused confirmation changes nothing.
  page.once('dialog', (d) => {
    asked.push(d.message());
    void d.dismiss();
  });
  await sidebar.getByTestId('backend-mode-bedrock').click();
  await expect.poll(() => asked.length).toBe(1);
  expect((await appState(request)).backend?.mode).not.toBe('bedrock');

  page.once('dialog', (d) => void d.accept());
  await sidebar.getByTestId('backend-mode-bedrock').click();
  await expect(sidebar.getByTestId('backend-badge')).toHaveAttribute('data-active', 'bedrock');
  await expect(sidebar.getByTestId('backend-badge')).toContainText('Bedrock');
  await expect(sidebar.getByTestId('backend-badge')).toContainText('of $200 today');
  await expect(sidebar.getByTestId('backend-mode-bedrock')).toHaveAttribute('aria-pressed', 'true');
  expect(asked.some((m) => /Bedrock/.test(m))).toBeTruthy();
  expect((await appState(request)).backend?.active).toBe('bedrock');

  // A new agent starts on Bedrock and its row says so; plan agents (the seeded one) carry no tag.
  const title = uniq('bk');
  const s = await startWorker(request, 'hello', { title });
  await expect.poll(async () => (await appState(request)).sessions.find((x) => x.id === s.id)?.backend).toBe('bedrock');
  const row = sidebar.getByTestId('fl-agent').filter({ hasText: title });
  await expect(row).toBeVisible();
  await expect(row.getByTestId('fl-agent-bedrock')).toBeVisible();
  await expect(sidebar.getByTestId('fl-agent').filter({ hasText: 'Seeded worker' }).getByTestId('fl-agent-bedrock')).toHaveCount(0);

  // The spend block, opened on demand.
  const foot = sidebar.locator('.sys-foot');
  if (!(await foot.getAttribute('class'))?.includes('open')) await foot.locator('.sys-toggle').click();
  const spend = sidebar.getByTestId('bedrock-spend');
  await spend.locator('summary').click();
  await expect(spend).toContainText('Estimated from token counts at Bedrock list prices');
  await expect(spend).toContainText('of $200');

  await sidebar.getByTestId('backend-mode-plan').click();
  await expect(sidebar.getByTestId('backend-badge')).toHaveAttribute('data-active', 'plan');
  await expect(sidebar.getByTestId('backend-mode-plan')).toHaveAttribute('aria-pressed', 'true');
  expect((await appState(request)).backend?.mode).toBe('plan');
});

// The script's way in (scripts/backend.ts): a key minted --scope backend, no login, reaches the switch and nothing else.
test('a backend-scoped key switches the mode without a login, and reaches nothing else', async ({ playwright, baseURL }, info) => {
  const port = new URL(baseURL!).port;
  const key = fs.readFileSync(path.join(os.tmpdir(), `ffsb-e2e-${port}`, 'backend-key.txt'), 'utf8').trim();
  const bare = await playwright.request.newContext({ baseURL: baseURL!, extraHTTPHeaders: { authorization: `Bearer ${key}` } });
  try {
    const set = await bare.post('/api/backend/mode', { data: { mode: 'bedrock' } });
    expect(set.ok(), info.project.name).toBeTruthy();
    expect((await set.json()).mode).toBe('bedrock');
    const got = await bare.get('/api/backend');
    expect((await got.json()).backend.mode).toBe('bedrock');
    expect((await bare.post('/api/backend/mode', { data: { mode: 'sideways' } })).status()).toBe(400);
    expect((await bare.get('/api/sessions')).status()).toBe(401); // the key opens the switch only
    const back = await bare.post('/api/backend/mode', { data: { mode: 'plan' } });
    expect((await back.json()).mode).toBe('plan');
  } finally {
    await bare.dispose();
  }
  const mate = fs.readFileSync(path.join(os.tmpdir(), `ffsb-e2e-${port}`, 'teammate-key.txt'), 'utf8').trim();
  const other = await playwright.request.newContext({ baseURL: baseURL!, extraHTTPHeaders: { authorization: `Bearer ${mate}` } });
  try {
    expect((await other.post('/api/backend/mode', { data: { mode: 'bedrock' } })).status()).toBe(403); // an MCP key is not a backend key
  } finally {
    await other.dispose();
  }
});
