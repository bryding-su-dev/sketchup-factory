import { NOTIFY_KINDS } from '../shared/types.ts';
import { expect, openSidebar, signIn, test } from './fixtures.ts';

/**
 * Web Push needs a real push service, so the browser's side of it is stubbed: permission is granted
 * and PushManager hands out a fake subscription (an https endpoint and keys, as the server checks).
 * The service worker registration itself is real.
 */
function stubPush() {
  const w = window as unknown as { __push: { sub: unknown; permission: NotificationPermission } };
  const state = (w.__push = { sub: null as unknown, permission: 'default' as NotificationPermission });
  Object.defineProperty(Notification, 'permission', { configurable: true, get: () => state.permission });
  Notification.requestPermission = async () => (state.permission = 'granted');
  const makeSub = () => {
    const endpoint = `https://push.example.test/e2e/${Math.random().toString(36).slice(2)}`;
    const keys = { p256dh: 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U', auth: 'tBHItJI5svbpez7KI4CCXg' }; // gitleaks:allow (a made-up test subscription)
    return {
      endpoint,
      expirationTime: null,
      options: { userVisibleOnly: true },
      getKey: () => null,
      toJSON: () => ({ endpoint, expirationTime: null, keys }),
      unsubscribe: async () => {
        state.sub = null;
        return true;
      },
    };
  };
  PushManager.prototype.getSubscription = async function () {
    return state.sub as PushSubscription | null;
  };
  PushManager.prototype.subscribe = async function () {
    state.sub = makeSub();
    return state.sub as PushSubscription;
  };
}

/** iPhone Safari outside a Home Screen app has no Web Push (Playwright's WebKit may differ by OS). */
function noPushLikeIosSafari() {
  const w = window as unknown as Record<string, unknown>;
  delete w.PushManager;
  delete w.Notification;
}

test('settings: notifications on and off, per-kind choices, and the version', async ({ page, browserName }) => {
  await page.addInitScript(browserName === 'webkit' ? noPushLikeIosSafari : stubPush);
  await signIn(page);
  await page.goto('/');

  const footer = page.getByTestId('app-version');
  await expect(footer).toHaveText(/^v\d+\.\d+\.\d+ · [0-9a-f]{7,12}$/);
  const version = (await footer.textContent())!;

  const sidebar = await openSidebar(page);
  await sidebar.getByRole('button', { name: 'Settings' }).click();
  const sheet = page.getByRole('dialog');
  await expect(sheet.locator('.modal-head h2')).toHaveText('This device');
  await expect(sheet.getByTestId('about-version')).toContainText(`SketchUp Factory ${version}`);
  await expect(sheet.getByTestId('about-version').getByRole('link', { name: 'changelog' })).toHaveAttribute('href', /CHANGELOG\.md$/);
  // Voice is turned off on this server: the sheet says so instead of offering it.
  await expect(sheet).toContainText('Local Whisper: unavailable (turned off in config.json (voice.enabled))');

  const status = sheet.locator('.form > p').first();
  const turnOn = sheet.getByRole('button', { name: 'Turn on' });

  if (browserName === 'webkit') {
    // iPhone: push only works from the Home Screen app, and the sheet says how to get there.
    await expect(status).toContainText('add SketchUp Factory to the Home Screen first (Share → Add to Home Screen)');
    await expect(turnOn).toHaveCount(0);
    await expect(sheet.getByRole('button', { name: 'Send a test' })).toHaveCount(0);
    // The choices still work locally (kept for when it is added to the Home Screen).
    const box = sheet.locator('.field', { hasText: 'Tell me when' }).getByRole('checkbox').first();
    const was = await box.isChecked();
    await box.click();
    await expect(box).toBeChecked({ checked: !was });
  } else {
    await expect(status).toHaveText('Off on this device.');
    const subscribed = page.waitForResponse((r) => r.url().endsWith('/api/push/subscribe') && r.ok());
    await turnOn.click();
    await subscribed;
    await expect(status).toHaveText('On: this device gets notifications even when SketchUp Factory is closed.');
    await expect(sheet.getByRole('button', { name: 'Turn off' })).toBeVisible();
    await expect(sheet.getByRole('button', { name: 'Send a test' })).toBeVisible();

    // Each kind toggles and is saved on the server for this device.
    const boxes = sheet.locator('.field', { hasText: 'Tell me when' }).getByRole('checkbox');
    // One per kind the server knows (shared/types.ts), in its order.
    const kinds = NOTIFY_KINDS.map((k) => k.value);
    await expect(boxes).toHaveCount(kinds.length);
    for (const i of [0, 3]) {
      const box = boxes.nth(i);
      await expect(box).toBeChecked();
      for (const on of [false, true]) {
        const saved = page.waitForResponse((r) => r.url().endsWith('/api/push/prefs') && r.request().method() === 'POST');
        await box.click();
        const r = await saved;
        expect(r.ok()).toBeTruthy();
        expect(r.request().postDataJSON().prefs).toEqual({ [kinds[i]]: on });
        expect(((await r.json()) as { prefs: Record<string, boolean> }).prefs[kinds[i]]).toBe(on);
        await expect(box).toBeChecked({ checked: on });
      }
    }

    const unsubscribed = page.waitForResponse((r) => r.url().endsWith('/api/push/unsubscribe') && r.ok());
    await sheet.getByRole('button', { name: 'Turn off' }).click();
    await unsubscribed;
    await expect(status).toHaveText('Off on this device.');
    await expect(turnOn).toBeVisible();
  }

  await sheet.getByRole('button', { name: 'Close' }).click();
  await expect(sheet).toBeHidden();
});
