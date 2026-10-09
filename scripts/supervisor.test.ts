import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { appPaths, realSys, runUpdate, waitHealthy, type Sys, type UpdateResult } from './supervisor.ts';

/**
 * The macOS/Linux supervisor's update (docs/restart.md, "Updating"): real git in a throwaway origin and checkout, npm
 * faked. A refusal changes nothing; a failed build or health check rolls back to the commit it started from.
 */

const g = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function repos(t: { after: (fn: () => void) => void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-sup-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const origin = path.join(dir, 'origin.git');
  const dev = path.join(dir, 'dev');
  const app = path.join(dir, 'app');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'sketchup', origin]);
  execFileSync('git', ['clone', '-q', origin, dev], { stdio: 'ignore' });
  for (const r of [dev]) {
    g(r, 'config', 'user.email', 't@users.noreply.github.com');
    g(r, 'config', 'user.name', 'T');
    g(r, 'checkout', '-q', '-b', 'sketchup');
  }
  fs.writeFileSync(path.join(dev, 'package.json'), '{}\n');
  fs.writeFileSync(path.join(dev, 'app.txt'), 'v1\n');
  g(dev, 'add', '.');
  g(dev, 'commit', '-qm', 'v1');
  g(dev, 'push', '-q', 'origin', 'sketchup');
  execFileSync('git', ['clone', '-q', '-b', 'sketchup', origin, app], { stdio: 'ignore' });
  g(app, 'config', 'user.email', 't@users.noreply.github.com');
  g(app, 'config', 'user.name', 'T');
  const publish = (text: string) => {
    fs.writeFileSync(path.join(dev, 'app.txt'), text);
    g(dev, 'commit', '-qam', text.trim());
    g(dev, 'push', '-q', 'origin', 'sketchup');
    return g(dev, 'rev-parse', 'HEAD');
  };
  return { app, publish };
}

/** Real git in `cwd`; npm answers from `npm` (by its first argument), and every npm call is recorded. */
function fakeSys(cwd: string, npm: Record<string, number> = {}) {
  const lines: string[] = [];
  const npmCalls: string[] = [];
  const real = realSys(cwd, () => {});
  const sys: Sys = {
    run: (cmd, args) => {
      if (cmd !== 'npm') return real.run(cmd, args);
      npmCalls.push(`${args.join(' ')} @ ${fs.readFileSync(path.join(cwd, 'app.txt'), 'utf8').trim()}`);
      return { code: npm[args[0]] ?? 0, out: npm[args[0]] ? 'npm ERR! boom' : '' };
    },
    log: (l) => lines.push(l),
    now: () => new Date('2026-10-09T12:00:00Z'),
  };
  return { sys, lines, npmCalls };
}

const healthy = async () => undefined;
const noop = async () => {};

test('supervisor update: fast-forward, install, build, healthy: OK, and the new server got the result first', async (t) => {
  const { app, publish } = repos(t);
  const before = g(app, 'rev-parse', 'HEAD');
  const v2 = publish('v2\n');
  const { sys, npmCalls } = fakeSys(app);
  let provisional: UpdateResult | undefined;
  const r = await runUpdate(sys, async (p) => ((provisional = p), undefined), noop);
  assert.equal(r.ok, true);
  assert.deepEqual([r.headBefore, r.headAfter], [before, v2]);
  assert.deepEqual(npmCalls, ['ci --no-audit --no-fund @ v2', 'run build @ v2']);
  assert.deepEqual(provisional && [provisional.ok, provisional.headAfter], [true, v2], 'written for the new server before it starts');
});

test('supervisor update: nothing new upstream: OK, nothing installed', async (t) => {
  const { app } = repos(t);
  const { sys, npmCalls } = fakeSys(app);
  const r = await runUpdate(sys, healthy, noop);
  assert.equal(r.ok, true);
  assert.equal(r.upToDate, true);
  assert.deepEqual(npmCalls, []);
});

test('supervisor update: a modified tracked file or a local commit is refused, and nothing changes', async (t) => {
  const { app, publish } = repos(t);
  publish('v2\n');
  const before = g(app, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(app, 'app.txt'), 'edited by hand\n');
  const dirty = fakeSys(app);
  const r1 = await runUpdate(dirty.sys, healthy, noop);
  assert.equal(r1.ok, false);
  assert.equal(r1.refused, true);
  assert.match(r1.error!, /tracked files are modified .*app\.txt/);
  assert.equal(g(app, 'rev-parse', 'HEAD'), before);
  assert.equal(fs.readFileSync(path.join(app, 'app.txt'), 'utf8'), 'edited by hand\n', 'the edit is kept');
  assert.deepEqual(dirty.npmCalls, []);

  g(app, 'commit', '-qam', 'a local commit');
  const local = g(app, 'rev-parse', 'HEAD');
  const diverged = fakeSys(app);
  const r2 = await runUpdate(diverged.sys, healthy, noop);
  assert.equal(r2.refused, true);
  assert.match(r2.error!, /not a fast-forward of this checkout \(1 local commit/);
  assert.equal(g(app, 'rev-parse', 'HEAD'), local);
  assert.deepEqual(diverged.npmCalls, []);
});

test('supervisor update: a generated file rewritten by npm does not count as a modification', async (t) => {
  const { app, publish } = repos(t);
  const v2 = publish('v2\n');
  fs.writeFileSync(path.join(app, 'package.json'), '{ "rewritten": true }\n');
  const r = await runUpdate(fakeSys(app).sys, healthy, noop);
  assert.equal(r.ok, true);
  assert.equal(r.headAfter, v2);
});

test('supervisor update: a failed build rolls back to the previous commit and rebuilds it', async (t) => {
  const { app, publish } = repos(t);
  const before = g(app, 'rev-parse', 'HEAD');
  publish('v2\n');
  // The build fails on v2 only: the rollback's build at v1 succeeds.
  const npmCalls: string[] = [];
  const real = realSys(app, () => {});
  const sys: Sys = {
    run: (cmd, args) => {
      if (cmd !== 'npm') return real.run(cmd, args);
      const at = fs.readFileSync(path.join(app, 'app.txt'), 'utf8').trim();
      npmCalls.push(`${args[0]} @ ${at}`);
      return args[0] === 'run' && at === 'v2' ? { code: 1, out: 'vite: error' } : { code: 0, out: '' };
    },
    log: () => {},
    now: () => new Date(),
  };
  let checked = false;
  const r = await runUpdate(sys, async () => ((checked = true), undefined), noop);
  assert.equal(r.ok, false);
  assert.equal(r.rolledBack, true);
  assert.match(r.error!, /npm run build failed \(exit 1\): vite: error; rolled back to/);
  assert.equal(r.headAfter, before);
  assert.equal(g(app, 'rev-parse', 'HEAD'), before);
  assert.equal(checked, false, 'a failed build never starts the new server');
  assert.deepEqual(npmCalls, ['ci @ v2', 'run @ v2', 'ci @ v1', 'run @ v1']);
});

test('supervisor update: a failed health check stops the new server, then rolls back', async (t) => {
  const { app, publish } = repos(t);
  const before = g(app, 'rev-parse', 'HEAD');
  publish('v2\n');
  const order: string[] = [];
  const { sys } = fakeSys(app);
  const r = await runUpdate(
    sys,
    async () => (order.push('started'), 'the new server exited before it was healthy'),
    async () => void order.push(`stopped at ${g(app, 'rev-parse', 'HEAD') === before ? 'v1' : 'v2'}`),
  );
  assert.equal(r.rolledBack, true);
  assert.match(r.error!, /exited before it was healthy; rolled back/);
  assert.deepEqual(order, ['started', 'stopped at v2'], 'stopped before the checkout moves back');
  assert.equal(g(app, 'rev-parse', 'HEAD'), before);
});

test('supervisor update: when the rollback fails too, it says so and does not claim a rollback', async (t) => {
  const { app, publish } = repos(t);
  publish('v2\n');
  const { sys } = fakeSys(app, { ci: 1 });
  const r = await runUpdate(sys, healthy, noop);
  assert.equal(r.ok, false);
  assert.equal(r.rolledBack, false);
  assert.match(r.error!, /npm ci failed .*the rollback to \w+ failed as well/);
});

test('waitHealthy: waits for the new commit, and gives up when the process ends or time runs out', async (t) => {
  let sha = 'aaaaaaa';
  const server = http.createServer((_q, res) => res.end(JSON.stringify({ ok: true, sha })));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/health`;
  setTimeout(() => (sha = 'bbbbbbb'), 150);
  assert.equal(await waitHealthy(url, 'bbbbbbbccccccc', { timeoutMs: 3000, everyMs: 50 }), undefined);
  assert.match((await waitHealthy(url, 'ccccccc', { timeoutMs: 300, everyMs: 50 }))!, /did not report commit ccccccc .*commit bbbbbbb/);
  assert.match((await waitHealthy(url, 'ccccccc', { timeoutMs: 3000, everyMs: 50, alive: () => false }))!, /exited before it was healthy/);
});

test('appPaths: port and data folder from the config, defaults without one', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-sup-cfg-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.deepEqual(appPaths(dir, {}), { port: 8790, dataDir: path.join(dir, 'data') });
  fs.writeFileSync(path.join(dir, 'c.json'), '﻿' + JSON.stringify({ port: 9001, dataDir: './state' }));
  assert.deepEqual(appPaths(dir, { FFSB_CONFIG: path.join(dir, 'c.json') }), { port: 9001, dataDir: path.join(dir, 'state') });
});
