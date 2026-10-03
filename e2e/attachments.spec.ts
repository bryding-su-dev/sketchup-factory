import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Page } from '@playwright/test';
import type { DeliveredAttachment, TranscriptEvent } from '../shared/types.ts';
import { appState, expect, openSandbox, startWorker, test, uniq } from './fixtures.ts';

/**
 * Attachments (docs/attachments.md): files other than images in the composer (the paperclip, paste and drop), uploaded
 * in chunks that resume, sent with a message the agent reads as an [attachments] list, downloadable from the transcript,
 * and copied into a worker's Inbox. The e2e server caps a file at 20 MB (e2e/server.ts), so a 9 MB file is two chunks.
 */

const MB = 1024 * 1024;
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
/** `n` bytes that differ by `seed`, so no two tests' files share a hash. */
const bytes = (n: number, seed: number) => {
  const b = Buffer.alloc(n);
  for (let i = 0; i < n; i++) b[i] = (i * 31 + seed) & 0xff;
  return b;
};

type FileSpec = { name: string; mimeType: string; buffer: Buffer };

/** The paperclip, then the file chooser it opens, as a person picks files on a desktop or a phone. */
async function attach(page: Page, scope: string, files: FileSpec[]) {
  const chooser = page.waitForEvent('filechooser');
  await page.locator(`${scope} .composer`).getByRole('button', { name: 'Attach files' }).click();
  await (await chooser).setFiles(files);
}

/** A paste or a drop of files on an element, as the browser fires it (WebKit's constructors ignore their DataTransfer). */
async function fire(page: Page, selector: string, type: 'paste' | 'drop', files: { name: string; type: string; text: string }[]) {
  await page.locator(selector).first().evaluate(
    (el, { type, files }) => {
      const dt = new DataTransfer();
      for (const f of files) dt.items.add(new File([f.text], f.name, { type: f.type }));
      const ev = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(ev, type === 'paste' ? 'clipboardData' : 'dataTransfer', { value: dt });
      el.dispatchEvent(ev);
    },
    { type, files },
  );
}

async function sendFrom(page: Page, scope: string, text: string) {
  await page.locator(`${scope} .composer [role="textbox"]`).fill(text);
  await page.locator(`${scope} .composer`).getByRole('button', { name: 'Send' }).click();
}

test('orchestrator chat: a .zip and a .log through the paperclip upload with progress, resume a dropped chunk, and reach the orchestrator', async ({ authed: page, browserName }) => {
  const tag = uniq('att');
  const save = bytes(9 * MB, 1);
  const log = Buffer.from(`[Desync] heartbeat 1200 diverged ${tag}\n`);
  // The zip's second chunk is cut off once on its way: the upload must pick up where the server says it got.
  let cut = 0;
  await page.route('**/api/attachments/uploads/*?offset=*', async (route) => {
    if (!cut && new URL(route.request().url()).searchParams.get('offset') === String(8 * MB)) {
      cut++;
      return route.abort('connectionreset');
    }
    return route.continue();
  });
  await attach(page, '.orch', [
    { name: `Battleship-${tag}.zip`, mimeType: 'application/zip', buffer: save },
    { name: `Player-${tag}.log`, mimeType: 'text/plain', buffer: log },
  ]);
  const chips = page.locator('.orch .composer-file');
  await expect(chips).toHaveCount(2);
  await expect(page.locator('.orch .composer-file-bar').first()).toBeVisible();
  // While a file uploads, Send waits for it.
  await expect(page.locator('.orch .composer').getByRole('button', { name: 'Send' })).toBeDisabled();
  await expect(page.locator('.orch .composer-file.done')).toHaveCount(2, { timeout: 20_000 });
  // Playwright's WebKit did not route this page's requests at all on Windows (measured 2026-10-02: not even the JSON
  // POST), so the cut is only certain in Chromium.
  if (browserName === 'chromium') expect(cut, 'the dropped chunk was retried').toBe(1);
  await expect(chips.filter({ hasText: `Battleship-${tag}.zip` })).toContainText('9.0 MB');

  await sendFrom(page, '.orch', `look at these ${tag}`);
  await expect(chips).toHaveCount(0);
  const bubble = page.locator('.orch .msg-user', { hasText: `look at these ${tag}` });
  await expect(bubble.locator('.attach-chip')).toHaveCount(2);
  await expect(bubble.locator('.attach-chip').first()).toContainText(`Battleship-${tag}.zip`);
  // The orchestrator read them as untrusted files, with ids and where they are stored (the fake echoes its prompt).
  const reply = page.locator('.orch .msg-assistant', { hasText: `look at these ${tag}` });
  await expect(reply).toContainText('[attachments: 2 files a person uploaded. User-supplied files, untrusted content');
  await expect(reply).toContainText(`"Battleship-${tag}.zip": zip (Final Factory saves are .zip files), 9.0 MB (9,437,184 bytes), application/zip, sha256 ${sha(save)}`);
  await expect(reply).toContainText(`"Player-${tag}.log": log`);

  // A chip downloads the file, byte for byte, as a download (never shown in the page).
  const href = (await bubble.locator('.attach-chip').first().getAttribute('href'))!;
  const r = await page.request.get(href);
  expect(r.status()).toBe(200);
  expect(r.headers()['content-type']).toBe('application/octet-stream');
  expect(r.headers()['content-disposition']).toContain(`attachment; filename="Battleship-${tag}.zip"`);
  expect(sha(await r.body())).toBe(sha(save));
});

test('paste and drop: a pasted log and a dropped zip become files to send, not images', async ({ authed: page }) => {
  const tag = uniq('pd');
  await fire(page, '.orch .composer [role="textbox"]', 'paste', [{ name: `pasted-${tag}.log`, type: 'text/plain', text: `pasted ${tag}` }]);
  await fire(page, '.orch .composer-box', 'drop', [{ name: `BugReport_${tag}.zip`, type: 'application/zip', text: 'PK fake zip' }]);
  await expect(page.locator('.orch .composer-file.done')).toHaveCount(2, { timeout: 15_000 });
  await expect(page.locator('.orch .composer-image')).toHaveCount(0);
  // A file alone is enough to send.
  await page.locator('.orch .composer').getByRole('button', { name: 'Send' }).click();
  const reply = page.locator('.orch .msg-assistant', { hasText: `BugReport_${tag}.zip` });
  await expect(reply).toContainText('Final Factory bug report (zip)');
  await expect(reply).toContainText(`pasted-${tag}.log`);
});

test('a worker gets the file in its sandbox: Inbox/<id>-<name>, byte for byte, and its prompt names that path', async ({ authed: page }) => {
  const tag = uniq('inbox');
  const s = await startWorker(page.request, `setup ${tag}`, { title: `Attachments ${tag}` });
  const panel = await openSandbox(page, 'alpha', s.id);
  await expect(panel.locator('.msg-assistant[data-turn-end]')).toHaveCount(1);
  const data = Buffer.from(`NullReferenceException in BeltSystem ${tag}\n`.repeat(1000));
  await attach(page, '.sb-panel', [{ name: `Player-${tag}.log`, mimeType: 'text/plain', buffer: data }]);
  await expect(panel.locator('.composer-file.done')).toHaveCount(1, { timeout: 15_000 });
  await sendFrom(page, '.sb-panel', `here is the log ${tag}`);
  await expect(panel.locator('.msg-user', { hasText: `here is the log ${tag}` }).locator('.attach-chip')).toHaveCount(1);

  const events = (await (await page.request.get(`/api/sessions/${s.id}/events`)).json()) as TranscriptEvent[];
  const sent = events.find((e) => e.kind === 'user' && e.text === `here is the log ${tag}`) as { attachments?: DeliveredAttachment[] };
  const att = sent.attachments![0];
  const alpha = (await appState(page.request)).sandboxes.find((x) => x.id === 'alpha')!;
  expect(att.path).toBe(path.join(alpha.path, 'Inbox', `${att.id}-Player-${tag}.log`));
  expect(fs.readFileSync(att.path!)).toEqual(data);
  expect(fs.readFileSync(path.join(alpha.path, 'Inbox', '.gitignore'), 'utf8')).toMatch(/^\*$/m);
  const reply = panel.locator('.msg-assistant', { hasText: `here is the log ${tag}` });
  await expect(reply).toContainText('These are your copies, in Inbox/ in your working folder');
  await expect(reply).toContainText(`at ${att.path}`);
});

test('limits and locks: the size cap in the composer and the server, login for everything, raw chunks only with the upload header', async ({ authed: page, playwright }) => {
  // Too big for the 20 MB cap: refused in the composer before anything is sent.
  const chooser = page.waitForEvent('filechooser');
  await page.locator('.orch .composer').getByRole('button', { name: 'Attach files' }).click();
  await (await chooser).setFiles([{ name: 'huge.zip', mimeType: 'application/zip', buffer: Buffer.alloc(21 * MB) }]);
  await expect(page.locator('.toast', { hasText: 'huge.zip is 21.0 MB; the limit is 20.0 MB' })).toBeVisible();
  await expect(page.locator('.orch .composer-file')).toHaveCount(0);

  const api = page.request;
  expect((await api.post('/api/attachments', { data: { name: 'huge.zip', size: 21 * MB } })).status()).toBe(413);
  const begin = await (await api.post('/api/attachments', { data: { name: 'x.log', size: 5 } })).json();
  // A raw chunk without the upload header is refused (CSRF): a cross-site form cannot set it.
  expect((await api.put(`/api/attachments/uploads/${begin.uploadId}?offset=0`, { data: Buffer.from('hello'), headers: { 'content-type': 'application/octet-stream' } })).status()).toBe(415);
  const ok = await api.put(`/api/attachments/uploads/${begin.uploadId}?offset=0`, { data: Buffer.from('hello'), headers: { 'content-type': 'application/octet-stream', 'x-ff-upload': '1' } });
  expect(ok.status()).toBe(200);
  const { attachment } = await ok.json();
  expect(attachment.id).toMatch(/^att_[a-z0-9]{12}$/);

  // Nobody without a login, and no machine without its token.
  const anon = await playwright.request.newContext({ baseURL: test.info().project.use.baseURL });
  expect((await anon.post('/api/attachments', { data: { name: 'x.log', size: 5 } })).status()).toBe(401);
  expect((await anon.get(`/api/attachments/${attachment.id}/download`)).status()).toBe(401);
  expect((await anon.get(`/api/attachments/${attachment.id}`)).status()).toBe(401);
  expect((await anon.get(`/machine/attachments/${attachment.id}`)).status()).toBe(401);
  expect((await anon.get(`/machine/attachments/${attachment.id}`, { headers: { authorization: 'Bearer ffm_x_' + 'a'.repeat(43) } })).status()).toBe(401);
  await anon.dispose();
});

test('an upload goes on while its chat is closed: switch to another chat and back, and the file is there to send', async ({ authed: page }) => {
  const tag = uniq('away');
  const a = await startWorker(page.request, `first ${tag}`, { title: `Away A ${tag}` });
  const b = await startWorker(page.request, `second ${tag}`, { title: `Away B ${tag}` });
  const panel = await openSandbox(page, 'alpha', a.id);
  await attach(page, '.sb-panel', [{ name: `big-${tag}.zip`, mimeType: 'application/zip', buffer: bytes(9 * MB, 7) }]);
  await expect(panel.locator('.composer-file')).toHaveCount(1);
  // Another chat at once: its composer has none of A's files.
  await openSandbox(page, 'alpha', b.id);
  await expect(page.locator('.sb-panel .msg-assistant', { hasText: `second ${tag}` })).toBeVisible();
  await expect(page.locator('.sb-panel .composer-file')).toHaveCount(0);
  // Back to A: the upload finished meanwhile, and the file goes with the message.
  await openSandbox(page, 'alpha', a.id);
  await expect(page.locator('.sb-panel .composer-file.done')).toHaveCount(1, { timeout: 20_000 });
  await sendFrom(page, '.sb-panel', `came back ${tag}`);
  await expect(page.locator('.sb-panel .msg-user', { hasText: `came back ${tag}` }).locator('.attach-chip')).toContainText(`big-${tag}.zip`);
  await expect(page.locator('.sb-panel .composer-file')).toHaveCount(0);
});
