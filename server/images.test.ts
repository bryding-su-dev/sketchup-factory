import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inRoots, listImages, readImage } from './images.ts';
import { Store } from './store.ts';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

function tree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-img-'));
  const put = (rel: string, ageS: number) => {
    const f = path.join(root, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, PNG);
    const t = new Date(Date.now() - ageS * 1000);
    fs.utimesSync(f, t, t);
    return f;
  };
  return { root, put };
}

test('gallery: screenshot folders only, newest first', (t) => {
  const { root, put } = tree();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const a = put('Assets/Screenshots/a.png', 30);
  const b = put('specs/098-belts/proofs/run1/b.jpg', 10);
  const c = put('Logs/c.webp', 20);
  put('Assets/Art/texture.png', 1); // not a screenshot folder
  put('Assets/Screenshots/notes.txt', 1);
  assert.deepEqual(
    listImages(root).map((f) => f.path),
    [b, c, a],
  );
  assert.deepEqual(
    listImages(root, ['Assets/Art']).map((f) => path.basename(f.path)),
    ['texture.png'],
  );
});

test('image files: only images, only under the roots', (t) => {
  const { root, put } = tree();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const f = put('Logs/shot.png', 1);
  assert.equal(readImage(f, [root]).mediaType, 'image/png');
  assert.throws(() => readImage(path.join(root, 'Logs', '..', '..', 'x.png'), [root]), /outside/);
  assert.throws(() => readImage(f, [path.join(root, 'Assets')]), /outside/);
  fs.writeFileSync(path.join(root, 'secret.txt'), 'x');
  assert.throws(() => readImage(path.join(root, 'secret.txt'), [root]), /not an image/);
  assert.throws(() => readImage('Logs/shot.png', [root]), /absolute/);
  assert.ok(inRoots(path.join(root, 'a', 'b.png'), [root]));
  assert.ok(!inRoots(root + '-other/b.png', [root]), 'a sibling with the same prefix');
});

test('store: images kept per session, removed with the transcript', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir);
  const id = store.saveImage('s1', 'image/png', PNG.toString('base64'));
  const f = store.imagePath('s1', id)!;
  assert.ok(f.endsWith('.png'));
  assert.deepEqual(fs.readFileSync(f), PNG);
  assert.equal(store.imagePath('s1', '../s2/x'), undefined);
  assert.throws(() => store.saveImage('s1', 'text/html', 'AAAA'), /unsupported/);
  assert.ok(store.imagePath('s1', store.saveImage('s1', 'image/svg+xml', Buffer.from('<svg/>').toString('base64')))!.endsWith('.svg'));
  store.deleteTranscript('s1');
  assert.equal(store.imagePath('s1', id), undefined);
  store.flush();
});

test('video: ranges for seeking, root-limited, and in the gallery without Unity .meta files', async (t) => {
  const { openVideo, parseRange, listImages } = await import('./images.ts');
  // Ranges.
  assert.equal(parseRange(undefined, 1000), undefined);
  assert.deepEqual(parseRange('bytes=0-', 1000), { start: 0, end: 999 });
  assert.deepEqual(parseRange('bytes=100-199', 1000), { start: 100, end: 199 });
  assert.deepEqual(parseRange('bytes=900-5000', 1000), { start: 900, end: 999 });
  assert.deepEqual(parseRange('bytes=-100', 1000), { start: 900, end: 999 });
  assert.equal(parseRange('bytes=1000-', 1000), 'unsatisfiable');
  assert.equal(parseRange('bytes=0-1,5-9', 1000), undefined, 'several ranges: the whole file');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'video-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'sb', 'Assets', 'Screenshots', 'Videos');
  fs.mkdirSync(dir, { recursive: true });
  for (const n of ['01_blackhole.mp4', '01_blackhole.mp4.meta', '01_blackhole_sheet.png', 'clip.webm', 'notes.txt']) fs.writeFileSync(path.join(dir, n), 'x'.repeat(10));
  const v = openVideo(path.join(dir, '01_blackhole.mp4'), [path.join(root, 'sb')]);
  assert.equal(v.mediaType, 'video/mp4');
  assert.equal(v.size, 10);
  assert.equal(openVideo(path.join(dir, 'clip.webm'), [path.join(root, 'sb')]).mediaType, 'video/webm');
  assert.throws(() => openVideo(path.join(dir, '01_blackhole.mp4'), [path.join(root, 'other')]), /outside/);
  assert.throws(() => openVideo(path.join(dir, '01_blackhole.mp4.meta'), [path.join(root, 'sb')]), /not a video/);
  const names = (videos: boolean) => listImages(path.join(root, 'sb'), undefined, 120, { videos }).map((f) => path.basename(f.path)).sort();
  assert.deepEqual(names(true), ['01_blackhole.mp4', '01_blackhole_sheet.png', 'clip.webm']);
  assert.deepEqual(names(false), ['01_blackhole_sheet.png']);
});

test('image files: an SVG is served sanitised; links out of the roots and oversized files are refused', async (t) => {
  const { root, put } = tree();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-img-out-'));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });
  const svg = path.join(root, 'Screenshots', 'chart.svg');
  fs.mkdirSync(path.dirname(svg), { recursive: true });
  fs.writeFileSync(svg, '<svg onload="alert(1)"><script>alert(2)</script><rect width="1" height="1"/></svg>');
  const img = readImage(svg, [root]);
  assert.equal(img.mediaType, 'image/svg+xml');
  assert.equal(img.data.toString(), '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>');
  fs.writeFileSync(path.join(root, 'page.svg'), '<html><script>alert(1)</script></html>');
  assert.throws(() => readImage(path.join(root, 'page.svg'), [root]), /not an SVG/);
  // Traversal, in either separator.
  put('Logs/shot.png', 1);
  assert.throws(() => readImage(`${root}/Logs/../../${path.basename(outside)}/x.png`, [root]), /outside/);
  assert.throws(() => readImage(path.join(root, 'Logs', '..', '..', 'etc', 'x.png'), [root]), /outside/);
  // A link inside the root to a file outside it.
  fs.writeFileSync(path.join(outside, 'secret.png'), PNG);
  try {
    fs.symlinkSync(path.join(outside, 'secret.png'), path.join(root, 'Logs', 'link.png'));
    fs.symlinkSync(outside, path.join(root, 'Logs', 'dir'), 'junction');
  } catch {
    t.diagnostic('no symlinks here (Windows without the right): link cases skipped');
    return;
  }
  assert.throws(() => readImage(path.join(root, 'Logs', 'link.png'), [root]), /outside/);
  assert.throws(() => readImage(path.join(root, 'Logs', 'dir', 'secret.png'), [root]), /outside/);
  // Over the cap.
  const big = path.join(root, 'Logs', 'big.png');
  fs.writeFileSync(big, Buffer.alloc(0));
  fs.truncateSync(big, (await import('./images.ts')).MAX_IMAGE_BYTES + 1);
  assert.throws(() => readImage(big, [root]), /too large/);
});

test('message images: markdown images and bare paths, as the page reads them', async () => {
  const { markdownImagePaths, mentionedPaths, messageImagePaths, localPath } = await import('../shared/imagePaths.ts');
  const text = [
    'Before ![after](/Users/me/sb/Screenshots/a.png "the title") and ![](<C:/Users/me/My Shots/b.svg>)',
    'a %-encoded one ![c](/tmp/x%20y/c.jpg), a remote one ![r](https://example.com/r.png), a data one ![d](data:image/png;base64,AAAA)',
    'bare: /Users/me/sb/Logs/d.webp, C:\\sb\\e.gif, a clip /Users/me/sb/v.mp4, and not https://example.com/f.png',
  ].join('\n');
  assert.deepEqual(markdownImagePaths(text), ['/Users/me/sb/Screenshots/a.png', 'C:/Users/me/My Shots/b.svg', '/tmp/x y/c.jpg']);
  assert.ok(mentionedPaths(text).includes('/Users/me/sb/v.mp4'));
  assert.deepEqual(messageImagePaths(text), ['/Users/me/sb/Screenshots/a.png', 'C:/Users/me/My Shots/b.svg', '/tmp/x y/c.jpg', '/Users/me/sb/Logs/d.webp', 'C:\\sb\\e.gif']);
  // A video written as a markdown image is played by the page, not kept as an image (w1030).
  const clip = '![old clip](</srv/fff/review/w801/w801-clip.mp4>) ![](/srv/fff/review/w801/a.webm) ![shot](/srv/fff/review/w801/s.png)';
  assert.deepEqual(markdownImagePaths(clip), ['/srv/fff/review/w801/s.png']);
  assert.deepEqual(messageImagePaths(clip), ['/srv/fff/review/w801/s.png']);
  assert.equal(localPath('//cdn.example/x.png'), undefined);
  assert.equal(localPath('C:%5Cx%5Cy.png'), 'C:\\x\\y.png');
  const many = Array.from({ length: 12 }, (_, i) => `![](/s/${i}.png)`).join(' ');
  assert.equal(messageImagePaths(many).length, 8);
});

test('message images: copied into the store as the message arrives, and recorded on it', async (t) => {
  const { keepMessageImages } = await import('./inlineImages.ts');
  const { root, put } = tree();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-keep-'));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const store = new Store(dir);
  const shot = put('Screenshots/proof.png', 1);
  const svg = path.join(root, 'Screenshots', 'chart.svg');
  fs.writeFileSync(svg, '<svg><script>alert(1)</script><circle r="1"/></svg>');
  const ev = store.append('s1', { kind: 'assistant', text: `Done: ![proof](${shot}) and ![chart](${svg}), not ![x](/elsewhere/x.png)` });
  const read = async (f: string) => readImage(f, [root]);
  const refs = await keepMessageImages(store, 's1', ev, read);
  assert.deepEqual(
    refs.map((r) => [r.path, r.mediaType]),
    [
      [shot, 'image/png'],
      [svg, 'image/svg+xml'],
    ],
  );
  // The copies outlive the files, and the SVG was kept sanitised.
  fs.rmSync(root, { recursive: true, force: true });
  assert.deepEqual(fs.readFileSync(store.imagePath('s1', refs[0].id)!), PNG);
  assert.equal(fs.readFileSync(store.imagePath('s1', refs[1].id)!, 'utf8'), '<svg xmlns="http://www.w3.org/2000/svg"><circle r="1"/></svg>');
  const kept = store.readTranscript('s1').find((e) => e.seq === ev.seq)!;
  assert.deepEqual(kept.kind === 'assistant' && kept.images, refs);
  // Already kept, not an assistant message, or nothing to keep: no copy, no rewrite.
  assert.deepEqual(await keepMessageImages(store, 's1', kept, read), []);
  const plain = store.append('s1', { kind: 'assistant', text: 'no images here' });
  assert.deepEqual(await keepMessageImages(store, 's1', plain, read), []);
  assert.deepEqual(await keepMessageImages(store, 's1', store.append('s1', { kind: 'system', text: `![x](${shot})` }), read), []);
  store.flush();
});
