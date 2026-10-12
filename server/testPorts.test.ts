import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { portRange, releasePort, reservePort } from './testPorts.ts';

/**
 * w1095 (lothsahn: "Please fix the port in use problem so it doesn't flake in the future."): crashRecovery.test.ts picked a
 * port by listening on 0, closing it and handing the number to the portal it spawned; another test file running beside it
 * got that port first, and the portal died with EADDRINUSE (PR #335, head 8ea3701). Servers a test starts now listen on 0
 * and read the port back, and a port that must be known beforehand comes from reservePort. These tests hold both.
 */

test('a reserved port is below the ephemeral range, locked for this process, free, and never given twice (w1095)', async () => {
  const { low, high } = portRange();
  assert.ok(low >= 1024 && high <= 32767 && low < high, `${low}-${high}`);
  const got = await Promise.all(Array.from({ length: 40 }, () => reservePort()));
  assert.equal(new Set(got).size, got.length, 'no port twice');
  for (const p of got) {
    assert.ok(p >= low && p <= high, String(p));
    assert.equal(fs.readFileSync(path.join(os.tmpdir(), 'ffsb-test-ports', String(p)), 'utf8'), String(process.pid));
  }
  // Its listener binds it, as often as it restarts.
  for (let i = 0; i < 2; i++) {
    const s = net.createServer();
    await new Promise<void>((r) => s.listen(got[0], '127.0.0.1', r));
    await new Promise<void>((r) => s.close(() => r()));
  }
  for (const p of got) releasePort(p);
  assert.ok(!fs.existsSync(path.join(os.tmpdir(), 'ffsb-test-ports', String(got[0]))), 'released: its lock is gone');
});

/** Every test source: what node --test, the Playwright server and the scripts' tests run. */
function sources(): string[] {
  const root = path.join(import.meta.dirname, '..');
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.ts$/.test(e.name) && p !== import.meta.filename) out.push(p);
    }
  };
  for (const d of ['server', 'scripts', 'e2e', 'machine']) if (fs.existsSync(path.join(root, d))) walk(path.join(root, d));
  return out;
}

test('no test picks a port by listening on 0 and closing it again: such a port goes to the next test that asks (w1095)', () => {
  const bad: string[] = [];
  for (const f of sources()) {
    const text = fs.readFileSync(f, 'utf8');
    // listen(0, …), then close, then the number handed on: "return port", or a URL or config built from it.
    for (const m of text.matchAll(/listen\(0\b[\s\S]{0,400}?\.close\([\s\S]{0,120}?(return\s+(port\b|`[^`]*\$\{port\})|port,)/g)) {
      bad.push(`${path.relative(path.join(import.meta.dirname, '..'), f)}:${text.slice(0, m.index).split('\n').length}`);
    }
    if (/\bfunction freePort\b|\bfreePort\s*=/.test(text)) bad.push(`${path.relative(path.join(import.meta.dirname, '..'), f)}: freePort`);
  }
  assert.deepEqual(bad, [], 'listen on port 0 and read the port back (server.address()), or use reservePort (server/testPorts.ts)');
});
