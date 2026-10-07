import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { IMMUTABLE, REVALIDATE, serveStatic, webBuild, withBuildMeta } from './webStatic.ts';
import { BUILD_META, freshnessAction } from '../shared/freshness.ts';

const INDEX_V1 = '<!doctype html><html><head><script type="module" src="/assets/index-aaaa.js"></script></head><body></body></html>';
const INDEX_V2 = '<!doctype html><html><head><script type="module" src="/assets/index-bbbb.js"></script></head><body></body></html>';

/** A built web UI in a temp folder, served the way server/index.ts serves web/dist. */
async function withSite(fn: (get: (p: string, headers?: Record<string, string>) => Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>, dir: string) => Promise<void>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webstatic-'));
  fs.mkdirSync(path.join(dir, 'assets'));
  fs.writeFileSync(path.join(dir, 'index.html'), INDEX_V1);
  fs.writeFileSync(path.join(dir, 'assets', 'index-aaaa.js'), 'console.log(1)');
  fs.writeFileSync(path.join(dir, 'sw.js'), '// sw');
  fs.writeFileSync(path.join(dir, 'manifest.webmanifest'), '{}');
  // A throw answers 500 with its message, so a test fails on it rather than waiting forever for a reply.
  const server = http.createServer((req, res) =>
    serveStatic(dir, req, new URL(req.url ?? '/', 'http://x'), res).catch((e: Error) => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(String(e?.stack ?? e));
    }),
  );
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  const get = (p: string, headers: Record<string, string> = {}) =>
    new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
      http
        .get({ host: '127.0.0.1', port, path: p, headers }, (res) => {
          let body = '';
          res.on('data', (c: Buffer) => (body += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
        })
        .on('error', reject);
    });
  try {
    await fn(get, dir);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }
}

test('the page (/, index.html and any app route) revalidates every time and names its build; hashed bundles are kept for good', async () => {
  await withSite(async (get, dir) => {
    const build = webBuild(dir)!;
    assert.match(build, /^[0-9a-f]{12}$/);
    for (const p of ['/', '/index.html', '/some/app/route']) {
      const r = await get(p);
      assert.equal(r.status, 200, p);
      assert.equal(r.headers['cache-control'], REVALIDATE, p);
      assert.equal(r.headers.etag, `"${build}"`, p);
      assert.match(r.headers['content-type'] ?? '', /^text\/html/, p);
      assert.ok(r.body.includes(`<meta name="${BUILD_META}" content="${build}" />`), p);
    }
    const js = await get('/assets/index-aaaa.js');
    assert.equal(js.status, 200);
    assert.equal(js.headers['cache-control'], IMMUTABLE);
    // Not hashed: the service worker and the manifest are asked about again too.
    assert.equal((await get('/sw.js')).headers['cache-control'], REVALIDATE);
    assert.equal((await get('/manifest.webmanifest')).headers['cache-control'], REVALIDATE);
  });
});

test('an unchanged page costs a 304; a rebuild changes the build and the page, without a restart', async () => {
  await withSite(async (get, dir) => {
    const v1 = webBuild(dir)!;
    const same = await get('/', { 'if-none-match': `"${v1}"` });
    assert.equal(same.status, 304);
    assert.equal(same.body, '');

    fs.writeFileSync(path.join(dir, 'index.html'), INDEX_V2);
    // A different size, so the stat check sees the rebuild even within one mtime tick.
    const v2 = webBuild(dir)!;
    assert.notEqual(v2, v1);
    const fresh = await get('/', { 'if-none-match': `"${v1}"` });
    assert.equal(fresh.status, 200);
    assert.equal(fresh.headers.etag, `"${v2}"`);
    assert.ok(fresh.body.includes('index-bbbb.js') && fresh.body.includes(`content="${v2}"`));
  });
});

test('a bundle a rebuild removed is a 404, not the page in its place (an old tab would fail on a MIME error)', async () => {
  await withSite(async (get) => {
    const r = await get('/assets/index-gone.js');
    assert.equal(r.status, 404);
    assert.equal(r.headers['cache-control'], 'no-store');
  });
});

test('no web UI built: no build id', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webstatic-empty-'));
  try {
    assert.equal(webBuild(dir), undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the build meta goes first in <head>', () => {
  assert.equal(withBuildMeta('<html><head><title>x</title></head></html>', 'abc'), `<html><head>\n    <meta name="${BUILD_META}" content="abc" /><title>x</title></head></html>`);
});

test('freshness: reload on a new build, a bar when that would lose something, never a reload loop', () => {
  const base = { loaded: 'aaa', served: 'bbb', triedFor: null, busy: false };
  assert.equal(freshnessAction(base), 'reload');
  assert.equal(freshnessAction({ ...base, busy: true }), 'banner');
  assert.equal(freshnessAction({ ...base, served: 'aaa' }), 'none');
  // Reloaded once for bbb and still on aaa (a proxy's stale copy?): offer it, do not loop.
  assert.equal(freshnessAction({ ...base, triedFor: 'bbb' }), 'banner');
  // A later build is worth one more try.
  assert.equal(freshnessAction({ ...base, triedFor: 'bbb', served: 'ccc' }), 'reload');
  // An older server (no build), or a dev server's page (no meta): nothing to compare.
  assert.equal(freshnessAction({ ...base, served: undefined }), 'none');
  assert.equal(freshnessAction({ ...base, loaded: undefined }), 'none');
});
