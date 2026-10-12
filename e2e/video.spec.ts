import { appState, expect, openSandbox, startWorker, test, uniq } from './fixtures.ts';

test('video: a clip an agent mentions plays inline, seeks with HTTP ranges, and is in the gallery (without its .meta)', async ({ authed: page, browserName }) => {
  const alpha = (await appState(page.request)).sandboxes.find((s) => s.id === 'alpha')!;
  const clip = `${alpha.path.replace(/\\/g, '/')}/Assets/Screenshots/Videos/clip.webm`;
  const tag = uniq('vid');
  const s = await startWorker(page.request, `see ${clip} ${tag}`, { title: `Video ${tag}` });
  const panel = await openSandbox(page, 'alpha', s.id);
  await expect(panel.locator('.msg-assistant', { hasText: `Echo: see ${clip}` })).toBeVisible();

  // Inline player: Playwright's Chromium decodes WebM (its WebKit builds do not, and hide what they cannot
  // play, as images that fail to load are hidden). The metadata, and so the duration, arrives without playing.
  if (browserName === 'chromium') {
    const video = panel.locator('.msg-assistant .video-item video').first();
    await expect(video).toBeVisible();
    await expect(video).toHaveAttribute('preload', 'metadata');
    expect(await video.evaluate((v: HTMLVideoElement) => v.controls && v.muted && v.playsInline)).toBe(true);
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => (v.readyState >= 1 ? Math.round(v.duration) : -1))).toBe(2);
  }

  // The same authenticated, folder-limited endpoint as images, with ranges.
  const src = `/api/image?${new URLSearchParams({ session: s.id, path: clip })}`;
  const part = await page.request.get(src, { headers: { Range: 'bytes=0-99' } });
  expect(part.status()).toBe(206);
  expect(part.headers()['content-range']).toMatch(/^bytes 0-99\/\d+$/);
  expect(part.headers()['accept-ranges']).toBe('bytes');
  expect((await part.body()).length).toBe(100);
  expect((await page.request.get(src, { headers: { Range: 'bytes=99999999-' } })).status()).toBe(416);
  const whole = await page.request.get(src);
  expect(whole.status()).toBe(200);
  expect(whole.headers()['content-type']).toBe('video/webm');
  const outside = `/api/image?${new URLSearchParams({ session: s.id, path: clip.replace('/alpha/', '/gallery/') })}`;
  expect((await page.request.get(outside)).status()).toBe(404);

  // The Screenshots gallery (in the sandbox's Details) lists the clip, never Unity's .meta beside it.
  await panel.getByRole('button', { name: 'Details' }).click();
  await page.getByRole('button', { name: 'Screenshots' }).click();
  const drawer = page.locator('.drawer');
  const tile = drawer.locator('.gallery-item', { hasText: 'clip.webm' });
  await expect(tile).toHaveCount(1);
  await expect(tile.locator('video')).toHaveCount(1);
  await expect(drawer.locator('.gallery-item', { hasText: '.meta' })).toHaveCount(0);
  await tile.click();
  await expect(page.locator('.lightbox video')).toHaveCount(1);
});

test('video: a clip written as a markdown image, in the <angle> path form, is a player and not an image (w1030)', async ({ authed: page, browserName }) => {
  const alpha = (await appState(page.request)).sandboxes.find((s) => s.id === 'alpha')!;
  const dir = `${alpha.path.replace(/\\/g, '/')}/Assets/Screenshots/Videos`;
  const tag = uniq('mdvid');
  const s = await startWorker(page.request, `see ![md clip](<${dir}/clip.webm>) and ![md mp4](<${dir}/clip.mp4>) ${tag}`, { title: `Markdown video ${tag}` });
  // A <video> asks for its file with a Range header; an <img> never does. That holds for the .mp4 whatever the browser can decode.
  const asked = page.waitForRequest((r) => r.url().includes('clip.mp4') && r.url().includes('/api/image') && !!r.headers().range);
  const panel = await openSandbox(page, 'alpha', s.id);
  await asked;
  const message = panel.locator('.msg-assistant', { hasText: tag });
  await expect(message).toBeVisible();
  await expect(message.locator('img[src*="clip.mp4"], img[src*="clip.webm"]')).toHaveCount(0);
  if (browserName === 'chromium') {
    const video = message.locator('.md-video video').first();
    await expect(video).toBeVisible();
    expect(await video.evaluate((v: HTMLVideoElement) => v.controls && v.playsInline)).toBe(true);
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => (v.readyState >= 1 ? Math.round(v.duration) : -1))).toBe(2);
    await expect(message.locator('.md-video-cap').first()).toContainText('md clip');
  }
});
