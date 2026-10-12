import { expect, isMobile, openSandbox, openSidebar, sendMessage, startWorker, test, uniq } from './fixtures.ts';

test('sandbox page: a worker agent’s prompt and reply', async ({ authed: page }) => {
  const tag = uniq('hello');
  const s = await startWorker(page.request, `hello ${tag}`, { title: `Worker ${tag}` });
  const panel = await openSandbox(page, 'alpha', s.id);

  await expect(panel.locator('.ph-name')).toHaveText('E2E playground');
  await expect(panel.locator('.msg-user', { hasText: `hello ${tag}` })).toBeVisible();
  // The turn ended well: its time and cost are on the reply (shown on hover), no rule of their own.
  await expect(panel.locator('.msg-assistant[data-turn-end="ok"]', { hasText: `Echo: hello ${tag}` })).toBeVisible();
  // The agent is the selected one: a tab on desktop, the switcher on a phone.
  if (isMobile(page)) await expect(panel.getByRole('combobox', { name: 'Agent' })).toHaveValue(s.id);
  else await expect(panel.getByRole('tab', { name: `Worker ${tag}` })).toHaveAttribute('aria-selected', 'true');
});

test('sandbox page: scrolled up, new content shows Jump to latest, which goes to the end', async ({ authed: page }) => {
  const tag = uniq('long');
  const s = await startWorker(page.request, `#long ${tag}`, { title: `Long ${tag}` });
  const panel = await openSandbox(page, 'alpha', s.id);
  const ends = panel.locator('.msg-assistant', { hasText: 'The end of the long answer.' });

  // A new page starts at the bottom.
  await expect(ends).toHaveCount(1);
  await expect(ends.first()).toBeInViewport();
  const scroller = panel.locator('.transcript-scroll');
  await scroller.evaluate((el) => el.scrollTo({ top: 0 }));
  await expect(panel.locator('.msg-user', { hasText: tag })).toBeInViewport();
  // Far from the bottom: the way back down is offered at once, without claiming anything new.
  const jump = panel.getByRole('button', { name: 'Jump to latest' });
  await expect(jump).toBeVisible();
  await expect(panel.locator('.jump-pill.has-new')).toHaveCount(0);

  // More content while the reader is scrolled up: the view stays put, and the pill says so.
  await sendMessage(page.request, s.id, `#long again ${tag}`);
  await expect(ends).toHaveCount(2);
  await expect(panel.locator('.jump-pill.has-new')).toContainText('New messages');
  await expect(ends.last()).not.toBeInViewport();

  await jump.click();
  await expect(ends.last()).toBeInViewport();
  await expect(jump).toBeHidden();
});

test('permission prompt: Allow lets the tool run, Deny stops it', async ({ authed: page }) => {
  for (const choice of ['Allow', 'Deny'] as const) {
    const tag = uniq('perm');
    const s = await startWorker(page.request, `#perm ${tag}`, { title: `Perm ${tag}`, permissionMode: 'default' });
    const panel = await openSandbox(page, 'alpha', s.id);

    // Decide once the transcript has loaded: a snapshot landing after the decision would hide it
    // (store.ts merges a stale /events answer over the live amended row; reported, not fixed here).
    await expect(panel.locator('.msg-user', { hasText: tag })).toBeVisible();
    const card = panel.locator('.perm-pending');
    await expect(card).toBeVisible();
    await expect(card.locator('.perm-title')).toHaveText('Wants to use Bash');
    await expect(card.locator('.perm-summary')).toContainText('rm -rf build');
    // Waiting on you: the strip under the panel header, and on desktop the sidebar's list too.
    const strip = panel.locator('.attn-strip');
    await expect(strip).toContainText('Waiting for your OK');
    await expect(strip).toContainText('rm -rf build');
    if (!isMobile(page)) await expect(page.locator('.sidebar .attn-item', { hasText: `Perm ${tag}` })).toContainText('Allow Bash');
    await expect(page).toHaveTitle(/^\(\d+\) SketchUp Factory$/);

    await card.getByRole('button', { name: choice, exact: true }).click();
    if (choice === 'Allow') {
      await expect(panel.locator('.msg-assistant', { hasText: 'Allowed: I cleaned the build folder.' })).toBeVisible();
      await expect(panel.locator('.perm-allowed .perm-title')).toHaveText('Allowed');
    } else {
      await expect(panel.locator('.msg-assistant', { hasText: 'Denied: I left the build folder alone.' })).toBeVisible();
      await expect(panel.locator('.perm-denied .perm-title')).toHaveText('Denied');
    }
    await expect(panel.locator('.perm-pending')).toHaveCount(0);
    await expect(panel.locator('.attn-strip')).toHaveCount(0);
  }
});

test('Unity blocked: the sidebar row says so, the page explains the dialog', async ({ authed: page }) => {
  const sidebar = await openSidebar(page);
  // Waiting on the user: in the Needs you list, and amber on the sandbox's own row.
  await expect(sidebar.locator('.attn-item', { hasText: 'Unity blocked demo' })).toContainText('Unity is stuck on “Enter Safe Mode?”');
  const row = sidebar.locator('.row.place', { hasText: 'Unity blocked demo' });
  await expect(row.locator('.row-sub')).toContainText('Unity blocked');
  await expect(row.locator('.dot')).toHaveClass(/dot-amber/);
  await row.click();

  const panel = page.locator('.sb-panel');
  await expect(panel.locator('.ph-name')).toHaveText('Unity blocked demo');
  const strip = panel.locator('.attn-strip-row', { hasText: 'Unity is stuck' });
  await expect(strip).toBeVisible();
  await strip.click();

  const blocked = page.getByLabel('Details').locator('.unity-blocked');
  await expect(blocked).toBeVisible();
  await expect(blocked).toContainText('Dialog: Enter Safe Mode?');
  await expect(blocked).toContainText('The project has compilation errors.');
  await expect(blocked).toContainText('Buttons: Enter Safe Mode · Ignore · Quit');
  await expect(blocked).toContainText('Press Ignore, then fix the compile errors.');
});

test('details sheet: opens with the sandbox, Unity and agent facts, and closes', async ({ authed: page }) => {
  const panel = await openSandbox(page, 'gallery');
  const toggle = panel.getByRole('button', { name: 'Details' });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();

  // A bottom sheet (a dialog) on a phone, an inline region on desktop.
  const sheet = page.getByRole(isMobile(page) ? 'dialog' : 'region', { name: 'Details' });
  await expect(sheet).toBeVisible();
  // The name is the page's header; the sheet adds the slot, the folder and git.
  await expect(panel.locator('.ph-name')).toHaveText('Visual baseline');
  await expect(sheet).toContainText('Slot gallery');
  await expect(sheet.locator('.git-branch')).toHaveText('sandbox/gallery');
  await expect(sheet.locator('.sb-facts')).toContainText(/sandboxes[\\/]gallery/);
  await expect(sheet.locator('.unity-bar .chip')).toHaveText('Unity off');
  await expect(sheet.getByRole('button', { name: 'Start Unity' })).toBeVisible();
  await expect(sheet.locator('.session-title')).toContainText('Seeded worker');
  await expect(sheet.locator('.session-id')).toHaveText('gallery1');
  await expect(sheet.locator('.session-meta')).toContainText('opus');
  await expect(sheet.locator('.mode-select select')).toHaveValue('bypassPermissions');

  if (isMobile(page)) {
    await expect(page.locator('.details-backdrop')).toBeVisible();
    await sheet.getByRole('button', { name: 'Close details' }).click();
  } else {
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await toggle.click();
  }
  await expect(sheet).toBeHidden();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
});
