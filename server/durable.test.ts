import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { SnapshotFile, checkObject, dataRecoveries, describeRecovery, generationPath, readJsonDurable, writeFileDurable, writeJsonDurable, type DataRecovery } from './durable.ts';

function tmp(t: { after: (fn: () => void) => void }, prefix = 'ffsb-durable-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  return dir;
}

const read = (p: string) => JSON.parse(fs.readFileSync(p, 'utf8'));
const age = (p: string, ms: number) => {
  const at = new Date(Date.now() - ms);
  fs.utimesSync(p, at, at);
};
const lastRecovery = (): DataRecovery => dataRecoveries[dataRecoveries.length - 1];
const damagedCopies = (dir: string, name: string) => fs.readdirSync(dir).filter((n) => n.startsWith(`${name}.damaged-`));

test('writes keep versions: .1 the previous write, .2 and .3 moving on only when old enough', (t) => {
  const dir = tmp(t);
  const f = path.join(dir, 'state.json');
  const put = (v: number) => writeJsonDurable(f, { v });
  put(1);
  assert.ok(!fs.existsSync(generationPath(f, 1)), 'nothing to keep on the first write');
  put(2);
  assert.deepEqual(read(generationPath(f, 1)), { v: 1 });
  put(3);
  put(4); // .2 is fresh: only .1 moves on
  assert.deepEqual([read(f), read(generationPath(f, 1)), read(generationPath(f, 2))], [{ v: 4 }, { v: 3 }, { v: 1 }]);
  age(generationPath(f, 2), 2 * 60_000);
  put(5); // .2 is over a minute old and .3 is empty: both move on
  assert.deepEqual([read(generationPath(f, 1)), read(generationPath(f, 2)), read(generationPath(f, 3))], [{ v: 4 }, { v: 3 }, { v: 1 }]);
  age(generationPath(f, 2), 2 * 60_000);
  put(6); // .2 moves on again, .3 (2 minutes old, under 10) stays
  assert.deepEqual([read(generationPath(f, 1)), read(generationPath(f, 2)), read(generationPath(f, 3))], [{ v: 5 }, { v: 4 }, { v: 1 }]);
  assert.ok(!fs.existsSync(`${f}.tmp`), 'no temp file left behind');
});

/** What a crash leaves of a file that was being written, as seen on BEAST (all zeros) and in the classic cases. */
const DAMAGE: Record<string, (good: string) => Buffer> = {
  zeroed: (good) => Buffer.alloc(good.length),
  truncated: (good) => Buffer.from(good.slice(0, Math.floor(good.length / 2))),
  'partly written': (good) => Buffer.concat([Buffer.from(good.slice(0, 20)), Buffer.alloc(good.length - 20)]),
  empty: () => Buffer.alloc(0),
};

for (const [kind, damage] of Object.entries(DAMAGE)) {
  test(`state.json ${kind}: the newest good version takes its place, the damaged one is kept`, (t) => {
    const dir = tmp(t);
    const f = path.join(dir, 'state.json');
    const good = JSON.stringify({ sessions: ['a', 'b'], n: 41 }, null, 2);
    const latest = JSON.stringify({ sessions: ['a', 'b', 'c'], n: 42 }, null, 2);
    fs.writeFileSync(generationPath(f, 1), good);
    age(generationPath(f, 1), 5000);
    fs.writeFileSync(f, damage(latest));
    const v = readJsonDurable<{ n: number }>(f, { check: checkObject });
    assert.equal(v?.n, 41);
    assert.equal(fs.readFileSync(f, 'utf8'), good, 'written back in place, so the next start is normal');
    const kept = damagedCopies(dir, 'state.json');
    assert.equal(kept.length, 1);
    assert.deepEqual(fs.readFileSync(path.join(dir, kept[0])), damage(latest), 'the damaged file is never deleted');
    const r = lastRecovery();
    assert.equal(r.file, f);
    assert.equal(r.from, generationPath(f, 1));
    assert.match(describeRecovery(r), /state\.json was .*restored the version saved at .*\(state\.json\.1\).*changes before the crash are lost/);
    assert.equal(readJsonDurable<{ n: number }>(f, { check: checkObject })?.n, 41, 'a second load is plain');
  });
}

test('every recent version damaged: the newest good older one wins, and each damaged one is kept aside', (t) => {
  const dir = tmp(t);
  const f = path.join(dir, 'work.json');
  fs.writeFileSync(f, Buffer.alloc(100));
  fs.writeFileSync(generationPath(f, 1), '{"items": [');
  fs.writeFileSync(generationPath(f, 2), '{"items": [], "seq": 7}');
  fs.writeFileSync(generationPath(f, 3), '{"items": [], "seq": 3}');
  assert.deepEqual(readJsonDurable(f, { check: checkObject }), { items: [], seq: 7 });
  assert.equal(damagedCopies(dir, 'work.json').length, 1);
  assert.equal(damagedCopies(dir, 'work.json.1').length, 1);
  assert.ok(!fs.existsSync(generationPath(f, 1)), 'the damaged .1 cannot be taken for good later');
  assert.equal(lastRecovery().from, generationPath(f, 2));
});

test('a schema check that fails counts as damage', (t) => {
  const dir = tmp(t);
  const f = path.join(dir, 'users.json');
  fs.writeFileSync(f, '{"not": "a list"}');
  fs.writeFileSync(generationPath(f, 1), '[{"username": "ben"}]');
  const v = readJsonDurable<unknown[]>(f, { check: (x) => (Array.isArray(x) ? undefined : 'not a list') });
  assert.deepEqual(v, [{ username: 'ben' }]);
  assert.match(lastRecovery().problem, /not a sane version of this file \(not a list\)/);
});

test('nothing good left: undefined (start empty), said loudly, damaged files kept', (t) => {
  const dir = tmp(t);
  const f = path.join(dir, 'state.json');
  fs.writeFileSync(f, Buffer.alloc(64));
  fs.writeFileSync(generationPath(f, 1), '');
  assert.equal(readJsonDurable(f), undefined);
  assert.match(describeRecovery(lastRecovery()), /no good earlier version was left: started it EMPTY/);
  assert.equal(damagedCopies(dir, 'state.json').length, 1);
  assert.equal(damagedCopies(dir, 'state.json.1').length, 1);
});

test('a first start (no file, no versions) is not a recovery; a missing file with versions is', (t) => {
  const dir = tmp(t);
  const f = path.join(dir, 'state.json');
  const before = dataRecoveries.length;
  assert.equal(readJsonDurable(f), undefined);
  assert.equal(dataRecoveries.length, before);
  fs.writeFileSync(generationPath(f, 1), '{"a": 1}');
  assert.deepEqual(readJsonDurable(f), { a: 1 });
  assert.equal(lastRecovery().problem, 'missing');
  assert.ok(fs.existsSync(f));
});

test('an older backup scheme counts too (config.json.prev), and a BOM is fine', (t) => {
  const dir = tmp(t);
  const f = path.join(dir, 'config.json');
  fs.writeFileSync(f, Buffer.alloc(10));
  fs.writeFileSync(`${f}.prev`, '﻿{"port": 8787}');
  assert.deepEqual(readJsonDurable(f, { check: checkObject, extra: [`${f}.prev`] }), { port: 8787 });
});

test('background saves: a steady stream of changes cannot postpone the write', async (t) => {
  const dir = tmp(t);
  const f = path.join(dir, 'state.json');
  let n = 0;
  const s = new SnapshotFile(f, () => JSON.stringify({ n }), { delayMs: 50, intervalMs: 200, label: 'test' });
  const t0 = Date.now();
  // A change every 20 ms for 700 ms, and on until a recent version is on disk (at most 20 s): the old trailing debounce
  // (reset on every change) would not have written once. The first write starts after 50 ms and holds n of about 3; a
  // later one, intervalMs after it started, holds a recent n. Both run while the changes go on, but on a loaded Windows
  // runner one write and its fsync can take seconds (w636: CI on Windows ended at 700 ms with n 2 or 3 on disk, the second
  // write not yet committed), so the stream waits for the write instead of a fixed time.
  const recentOnDisk = () => fs.existsSync(f) && read(f).n > 5;
  while ((Date.now() - t0 < 700 || !recentOnDisk()) && Date.now() - t0 < 20_000) {
    n++;
    s.changed();
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.ok(fs.existsSync(f), 'written while the changes were still coming');
  assert.ok(Date.now() - t0 < 10_000, `a recent version within 10 s (${Date.now() - t0} ms), with a write every 200 ms`);
  const seen = read(f).n;
  assert.ok(seen > 5 && seen <= n, `a recent version (${seen} of ${n})`);
  await s.idle();
  assert.equal(read(f).n, n, 'and the last change once they stop');
});

test('background saves: a synchronous flush is never overtaken by an older background write', async (t) => {
  const dir = tmp(t);
  const f = path.join(dir, 'state.json');
  let n = 0;
  const s = new SnapshotFile(f, () => JSON.stringify({ n, pad: 'x'.repeat(2_000_000) }), { delayMs: 0, intervalMs: 0, label: 'test' });
  for (let i = 0; i < 20; i++) {
    n++;
    s.changed();
    await new Promise((r) => setTimeout(r, i % 3)); // let some background writes start
    n++;
    s.flushSync();
    assert.equal(read(f).n, n);
  }
  await s.idle();
  assert.equal(read(f).n, n);
});

const DURABLE_URL = pathToFileURL(path.join(import.meta.dirname, 'durable.ts')).href;

test('killed while writing, again and again: the file is always whole and loads without a recovery', async (t) => {
  const dir = tmp(t);
  const f = path.join(dir, 'state.json');
  // A child that rewrites a 3 MB state as fast as it can (each version carries its number); it is killed at random.
  const child = `
    import { writeJsonDurable } from ${JSON.stringify(DURABLE_URL)};
    const f = ${JSON.stringify(f)};
    const sessions = Array.from({ length: 7000 }, (_, i) => ({ id: 's' + i, title: 'agent ' + i + ' '.repeat(300) }));
    for (let n = 1; ; n++) { writeJsonDurable(f, { n, sandboxes: [], sessions }, { indent: 2 }); process.stdout.write(n + '\\n'); }
  `;
  let last = 0;
  let midWrite = 0;
  for (let round = 0; round < 6; round++) {
    const p = spawn(process.execPath, ['--input-type=module', '-e', child], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    // Wait for a few writes, then kill it at a random moment (most of a write's time is spent writing the data).
    while (out.split('\n').length < 3) await new Promise((r) => setTimeout(r, 5));
    await new Promise((r) => setTimeout(r, Math.random() * 150));
    p.kill('SIGKILL');
    await new Promise((r) => p.once('exit', r));
    if (fs.existsSync(`${f}.tmp`)) midWrite++;
    const before = dataRecoveries.length;
    const v = readJsonDurable<{ n: number; sessions: unknown[] }>(f, { check: checkObject });
    assert.equal(dataRecoveries.length, before, `round ${round}: the file was whole`);
    assert.equal(v?.sessions.length, 7000);
    assert.ok(v!.n >= 1, `round ${round}: version ${v!.n}`);
    last = v!.n;
  }
  assert.ok(last > 0);
  t.diagnostic(`${midWrite} of 6 kills landed with a write in progress`);
});

test('killed mid-write and then the disk lost the last write (as on BEAST): the next start loads the version before', async (t) => {
  const dir = tmp(t);
  const f = path.join(dir, 'state.json');
  for (let n = 1; n <= 3; n++) writeJsonDurable(f, { n, sandboxes: [], sessions: [] });
  // The crash: the rename reached the disk, the data did not.
  fs.writeFileSync(f, Buffer.alloc(fs.statSync(f).size));
  const v = readJsonDurable<{ n: number }>(f, { check: checkObject });
  assert.equal(v?.n, 2);
});

test('writeFileDurable leaves the old file whole when the new data cannot be written', (t) => {
  const dir = tmp(t);
  const f = path.join(dir, 'x.json');
  writeFileDurable(f, '{"ok": 1}');
  fs.mkdirSync(`${f}.tmp`); // the temp file cannot be opened
  assert.throws(() => writeFileDurable(f, '{"ok": 2}'));
  assert.deepEqual(read(f), { ok: 1 });
});
