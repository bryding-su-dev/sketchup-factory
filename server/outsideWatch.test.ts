import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OutsideWatch, magicPacket, readOutsideWatch, type OutsideWatchConfig } from '../machine/outsideWatch.ts';
import { broadcastAddress, loadOutsideWatchState, normMac, outsideWatchConfig, watcherOf } from './outsideWatch.ts';

const CFG: OutsideWatchConfig = { name: 'BEAST', host: 'beast.example.ts.net', healthUrl: 'https://beast.example.ts.net/api/health', ntfyTopic: 'ffsb-test', mac: '60:45:2e:43:75:0b', broadcast: '10.0.0.255' };

function harness(cfg = CFG) {
  const world = { now: Date.parse('2026-09-25T23:13:00Z'), portal: true, ping: true };
  const sent: { title: string; body: string; priority: string }[] = [];
  const woken: string[] = [];
  const w = new OutsideWatch(cfg, {
    ping: async () => world.ping,
    health: async () => world.portal,
    notify: async (_t, title, body, priority) => void sent.push({ title, body, priority }),
    wake: async (mac, b) => void woken.push(`${mac} via ${b}`),
    now: () => world.now,
    log: () => undefined,
  });
  const minute = async (n = 1) => {
    for (let i = 0; i < n; i++) {
      await w.tick();
      world.now += 60_000;
    }
  };
  return { world, sent, woken, w, minute };
}

test('outside watch: 3 misses in a row alert "down since", Wake-on-LAN after 5 min, "back" on recovery', async () => {
  const { world, sent, woken, minute } = harness();
  await minute(2);
  assert.equal(sent.length, 0);
  // A blip (two misses) is not an outage.
  world.portal = world.ping = false;
  await minute(2);
  world.portal = world.ping = true;
  await minute();
  assert.equal(sent.length, 0);
  // Down for real.
  world.portal = world.ping = false;
  await minute(3);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].title, 'BEAST down');
  assert.equal(sent[0].priority, 'high');
  assert.match(sent[0].body, /^BEAST down since \d\d:\d\d: no answer to ping or from the portal \(3 checks in a row\)\. Sending Wake-on-LAN after 5 minutes\.$/);
  assert.deepEqual(woken, []);
  await minute(3); // 6 min since the first miss
  assert.deepEqual(woken, ['60:45:2e:43:75:0b via 10.0.0.255']);
  assert.equal(sent.at(-1)!.title, 'BEAST: Wake-on-LAN sent');
  await minute(10);
  assert.equal(woken.length, 1, 'not again within 15 min');
  await minute(6);
  assert.equal(woken.length, 2, 'repeated every 15 min while down');
  // Back.
  world.portal = world.ping = true;
  await minute();
  assert.equal(sent.at(-1)!.title, 'BEAST back');
  assert.match(sent.at(-1)!.body, /down since \d\d:\d\d, \d+ min\)/);
  const n = sent.length;
  await minute(5);
  assert.equal(sent.length, n, 'nothing more while it is up');
});

test('outside watch: the machine answers but the portal does not (booted, nobody logged in); no WoL then', async () => {
  const { world, sent, woken, minute } = harness();
  world.portal = false;
  await minute(3);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].title, 'BEAST up, portal down');
  assert.match(sent[0].body, /answers ping but the SketchUp Factory portal has not answered since .*automatic logon is off/);
  await minute(10);
  assert.deepEqual(woken, [], 'it is on: no Wake-on-LAN');
  assert.equal(sent.length, 1, 'one alert per state');
  // Then it drops off the network entirely, and comes back booted but not logged in.
  world.ping = false;
  await minute();
  assert.equal(sent.at(-1)!.title, 'BEAST down');
  world.ping = true;
  await minute();
  assert.equal(sent.at(-1)!.title, 'BEAST up, portal down');
  assert.match(sent.at(-1)!.body, /the machine is back on the network/);
  world.portal = true;
  await minute();
  assert.equal(sent.at(-1)!.title, 'BEAST back');
});

test('outside watch: without a MAC there is no Wake-on-LAN; the magic packet is 6 x FF then the MAC 16 times', async () => {
  const { world, woken, minute } = harness({ ...CFG, mac: undefined });
  world.portal = world.ping = false;
  await minute(20);
  assert.deepEqual(woken, []);
  const p = magicPacket('60-45-2E-43-75-0B');
  assert.equal(p.length, 102);
  assert.equal(p.subarray(0, 6).toString('hex'), 'ffffffffffff');
  assert.equal(p.subarray(6, 12).toString('hex'), '60452e43750b');
  assert.equal(p.subarray(96).toString('hex'), '60452e43750b');
  assert.throws(() => magicPacket('60:45:2e'), /not a MAC/);
});

test('outside watch (portal side): topic made once, network, config and who watches', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const s = loadOutsideWatchState(dir);
  assert.match(s.topic, /^ffsb-[a-z0-9_-]{16,}$/);
  assert.equal(loadOutsideWatchState(dir).topic, s.topic, 'kept');
  assert.equal(broadcastAddress('10.0.0.158', 24), '10.0.0.255');
  assert.equal(broadcastAddress('192.168.8.37', 22), '192.168.11.255');
  assert.equal(normMac('60-45-2E-43-75-0B'), '60:45:2e:43:75:0b');
  const c = outsideWatchConfig({ publicUrl: 'https://beast.tailedfcad.ts.net/', name: 'BEAST' }, { ...s, mac: '60:45:2e:43:75:0b', broadcast: '10.0.0.255' });
  assert.deepEqual(c, { name: 'BEAST', host: 'beast.tailedfcad.ts.net', healthUrl: 'https://beast.tailedfcad.ts.net/api/health', ntfyTopic: s.topic, mac: '60:45:2e:43:75:0b', broadcast: '10.0.0.255' });
  assert.equal(outsideWatchConfig({ name: 'BEAST' }, s), undefined, 'nothing to watch without a URL');
  assert.equal(watcherOf(undefined, ['m3', 'm5']), 'm5');
  assert.equal(watcherOf(undefined, ['m3']), 'm3');
  assert.equal(watcherOf('m3', ['m3', 'm5']), 'm3');
  assert.equal(watcherOf('mx', ['m3', 'm5']), undefined);
  // What the Mac keeps between runs.
  const f = path.join(dir, 'ow.json');
  fs.writeFileSync(f, JSON.stringify(c));
  assert.deepEqual(readOutsideWatch(f), c);
  assert.equal(readOutsideWatch(path.join(dir, 'none.json')), undefined);
});
