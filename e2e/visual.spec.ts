import type { Page } from '@playwright/test';
import { expect, openSandbox, openSidebar, signIn, test } from './fixtures.ts';

// Visual baselines (e2e/__screenshots__/<project>/, Linux renders from CI). Element shots, so the
// sidebar (which shows what parallel tests create) stays out; the clock is frozen for relative times,
// and anything still volatile is hidden or masked.

const NOW = new Date('2026-09-24T12:00:00Z');

async function open(page: Page, hash = '') {
  await page.clock.setFixedTime(NOW);
  await signIn(page);
  await page.goto(`/${hash}`);
  await expect(page.locator('.sidebar')).toBeAttached();
}

test('visual: login', async ({ page }) => {
  await page.clock.setFixedTime(NOW);
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await expect(page).toHaveScreenshot('login.png');
});

test('visual: orchestrator home', async ({ page }) => {
  await open(page);
  const orch = page.locator('section.orch');
  await expect(orch.locator('.composer-box')).toBeVisible();
  // The orchestrator is shared with the chat tests running alongside: its conversation and state are
  // theirs, and while one of their turns runs the composer shows Stop and a follow-up placeholder; the
  // phone's needs-you bell counts their permission requests. The frame (header, composer) is compared. The context
  // size (w535) shows once a turn has run, so it is left out, not hidden: the header is as before it existed.
  await page.addStyleTag({
    content: `
      section.orch .transcript-inner, section.orch .orch-state, section.orch .hb-on, section.orch .needs-you, section.orch .drawer-dot { visibility: hidden !important; }
      section.orch [data-testid="context-size"],
      section.orch .composer-hint, section.orch .jump-pill, section.orch .btn-stop-main, section.orch .btn-stop-mini,
      section.orch .composer-actions [aria-label="Voice mode"] { display: none !important; }
      section.orch .composer-input::before { color: transparent !important; }
    `,
  });
  await expect(orch).toHaveScreenshot('orchestrator.png');
});

test('visual: the seeded sandbox page', async ({ page }) => {
  await open(page);
  const panel = await openSandbox(page, 'gallery');
  await expect(panel.locator('.msg-assistant[data-turn-end="ok"]')).toBeVisible();
  await expect(panel).toHaveScreenshot('sandbox-gallery.png');
});

test('visual: the settings sheet', async ({ page }) => {
  await open(page);
  const sidebar = await openSidebar(page);
  await sidebar.getByRole('button', { name: 'Settings' }).click();
  const sheet = page.locator('.modal');
  await expect(sheet.getByTestId('about-version')).toBeAttached();
  await expect(sheet.locator('.form > .field').last()).toBeAttached();
  await expect(sheet).toHaveScreenshot('settings.png', { mask: [sheet.getByTestId('about-version')] });
});

test('visual: the new standing agent modal', async ({ page }) => {
  await open(page);
  const sidebar = await openSidebar(page);
  await sidebar.locator('.section-head', { hasText: 'Standing agents' }).getByRole('button', { name: 'New' }).click();
  const modal = page.locator('.modal');
  await expect(modal.locator('.modal-head h2')).toHaveText('New standing agent');
  await expect(modal).toHaveScreenshot('new-standing-agent.png');
});
