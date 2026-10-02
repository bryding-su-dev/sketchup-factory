import dgram from 'node:dgram';
import fs from 'node:fs';
import path from 'node:path';
import { run } from '../server/proc.ts';

/**
 * The outside watchdog (docs/self-recovery.md, "Watched from outside"): a Mac's daemon checks the host that
 * runs the portal (BEAST) every minute, independent of it. After `failures` misses in a row it alerts the
 * user's phone through ntfy ("BEAST down since 17:13", or "up, but the portal is not" when the machine
 * answers and the app does not, e.g. booted with nobody logged in), and "BEAST back" on recovery. When the
 * host has not answered a ping for `wolAfterMs` it sends a Wake-on-LAN packet (only works once WoL is on in
 * the BIOS; harmless otherwise). The config comes from the portal and is kept on the Mac, so the watch goes
 * on while the portal is down.
 */

export interface OutsideWatchConfig {
  /** The watched host's name in messages ("BEAST"). */
  name: string;
  /** Its Tailscale (MagicDNS) name or address, for the ping. */
  host: string;
  /** The portal's health URL (GET, no login): up when it answers { ok: true }. */
  healthUrl: string;
  /** ntfy.sh topic (random, unguessable): the user subscribes to it in the ntfy app. */
  ntfyTopic: string;
  ntfyServer?: string;
  /** Its LAN MAC address ("aa:bb:cc:dd:ee:ff") and subnet broadcast address, for Wake-on-LAN. */
  mac?: string;
  broadcast?: string;
}

export type HostState = 'up' | 'host-only' | 'down';

export interface OutsideWatchDeps {
  ping(host: string): Promise<boolean>;
  health(url: string): Promise<boolean>;
  notify(topic: string, title: string, body: string, priority: 'low' | 'default' | 'high', server?: string): Promise<void>;
  wake(mac: string, broadcast?: string): Promise<void>;
  now(): number;
  log(line: string): void;
}

const hhmm = (ms: number) => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
const mins = (ms: number) => `${Math.max(1, Math.round(ms / 60_000))} min`;

export class OutsideWatch {
  cfg: OutsideWatchConfig;
  private readonly d: OutsideWatchDeps;
  private readonly opts: { failures: number; wolAfterMs: number; wolEveryMs: number };
  private misses = 0;
  private since?: number;
  private noPingSince?: number;
  private alerted?: HostState;
  private lastWol = 0;
  private busy = false;
  last?: { at: number; state: HostState };

  constructor(cfg: OutsideWatchConfig, deps: Partial<OutsideWatchDeps> = {}, opts: Partial<OutsideWatch['opts']> = {}) {
    this.cfg = cfg;
    this.d = { ...realDeps(), ...deps };
    this.opts = { failures: 3, wolAfterMs: 5 * 60_000, wolEveryMs: 15 * 60_000, ...opts };
  }

  /** One look (every 60 s). Returns the state seen; never throws. */
  async tick(): Promise<HostState | 'skipped'> {
    if (this.busy) return 'skipped';
    this.busy = true;
    try {
      return await this.look();
    } catch (e) {
      this.d.log(`outside watch: ${(e as Error).message}`);
      return 'skipped';
    } finally {
      this.busy = false;
    }
  }

  private async look(): Promise<HostState> {
    const c = this.cfg;
    const [portal, pinged] = await Promise.all([this.d.health(c.healthUrl).catch(() => false), this.d.ping(c.host).catch(() => false)]);
    const state: HostState = portal ? 'up' : pinged ? 'host-only' : 'down';
    const now = this.d.now();
    this.last = { at: now, state };
    if (state === 'up') {
      if (this.alerted && this.since !== undefined) {
        await this.send(`${c.name} back`, `${c.name} and the SketchUp Factory portal answer again (down since ${hhmm(this.since)}, ${mins(now - this.since)}).`, 'default');
      }
      this.misses = 0;
      this.since = this.noPingSince = this.alerted = undefined;
      this.lastWol = 0;
      return state;
    }
    this.misses++;
    this.since ??= now;
    if (state === 'down') this.noPingSince ??= now;
    else this.noPingSince = undefined;
    if (this.misses >= this.opts.failures && this.alerted !== state) {
      const first = !this.alerted;
      this.alerted = state;
      if (state === 'down') {
        await this.send(`${c.name} down`, `${c.name} down since ${hhmm(this.since)}: no answer to ping or from the portal (${this.misses} checks in a row).${c.mac ? ' Sending Wake-on-LAN after 5 minutes.' : ''}`, 'high');
      } else {
        await this.send(
          `${c.name} up, portal down`,
          `${c.name} answers ping but the SketchUp Factory portal has not answered since ${hhmm(this.since)}${first ? '' : ' (the machine is back on the network)'}. Booted with nobody logged in (automatic logon is off), or the app did not start.`,
          'high',
        );
      }
    }
    if (state === 'down' && c.mac && this.noPingSince !== undefined && now - this.noPingSince >= this.opts.wolAfterMs && now - this.lastWol >= this.opts.wolEveryMs) {
      const firstWol = this.lastWol === 0;
      this.lastWol = now;
      try {
        await this.d.wake(c.mac, c.broadcast);
        this.d.log(`outside watch: sent Wake-on-LAN to ${c.mac}${c.broadcast ? ` via ${c.broadcast}` : ''}`);
        if (firstWol) await this.send(`${c.name}: Wake-on-LAN sent`, `No answer from ${c.name} for ${mins(now - this.noPingSince)}; sent a Wake-on-LAN packet to ${c.mac} (repeated every ${mins(this.opts.wolEveryMs)} while it is down; it only works with WoL enabled in the BIOS).`, 'low');
      } catch (e) {
        this.d.log(`outside watch: Wake-on-LAN failed: ${(e as Error).message}`);
      }
    }
    return state;
  }

  private async send(title: string, body: string, priority: 'low' | 'default' | 'high') {
    this.d.log(`outside watch: ${title}: ${body}`);
    try {
      await this.d.notify(this.cfg.ntfyTopic, title, body, priority, this.cfg.ntfyServer);
    } catch (e) {
      this.d.log(`outside watch: ntfy failed: ${(e as Error).message}`);
    }
  }

  describe(): string {
    const l = this.last;
    return `watching ${this.cfg.name} (${this.cfg.healthUrl}): ${l ? `${l.state} at ${hhmm(l.at)}` : 'no check yet'}${this.since !== undefined ? `, failing since ${hhmm(this.since)}` : ''}`;
  }
}

/** A Wake-on-LAN magic packet for a MAC address: 6 x 0xFF, then the MAC 16 times. */
export function magicPacket(mac: string): Buffer {
  const hex = mac.replace(/[^0-9a-f]/gi, '');
  if (hex.length !== 12) throw new Error(`not a MAC address: ${mac}`);
  const m = Buffer.from(hex, 'hex');
  return Buffer.concat([Buffer.alloc(6, 0xff), ...Array.from({ length: 16 }, () => m)]);
}

const TAILSCALE = ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/opt/homebrew/bin/tailscale', '/usr/local/bin/tailscale'];

export function realDeps(): OutsideWatchDeps {
  return {
    ping: async (host) => {
      const ts = TAILSCALE.find((p) => fs.existsSync(p));
      if (ts) {
        const r = await run(ts, ['ping', '--c', '1', '--timeout', '5s', host], { timeoutMs: 15_000 });
        if (r.code === 0) return true;
      }
      const r = await run('ping', ['-c', '2', '-t', '6', host], { timeoutMs: 15_000 });
      return r.code === 0;
    },
    health: async (url) => {
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) return false;
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean };
      return j.ok === true;
    },
    notify: async (topic, title, body, priority, server = 'https://ntfy.sh') => {
      const res = await fetch(`${server.replace(/\/+$/, '')}/${encodeURIComponent(topic)}`, {
        method: 'POST',
        body,
        headers: { Title: title, Priority: priority, Tags: priority === 'high' ? 'rotating_light' : priority === 'low' ? 'zap' : 'white_check_mark' },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`ntfy answered ${res.status}`);
    },
    wake: (mac, broadcast) =>
      new Promise<void>((resolve, reject) => {
        const packet = magicPacket(mac);
        const sock = dgram.createSocket('udp4');
        sock.once('error', (e) => (sock.close(), reject(e)));
        sock.bind(() => {
          sock.setBroadcast(true);
          const targets = [...new Set([broadcast, '255.255.255.255'].filter((x): x is string => !!x))];
          let left = targets.length * 2;
          const done = () => {
            if (--left === 0) {
              sock.close();
              resolve();
            }
          };
          for (const t of targets) for (const port of [9, 7]) sock.send(packet, port, t, done);
        });
      }),
    now: () => Date.now(),
    log: (line) => console.log(new Date().toISOString(), line),
  };
}

/** Where a Mac keeps the watch's config between runs (written when the portal sends it). */
export const outsideWatchFile = (appDir: string) => path.join(appDir, 'outside-watch.json');

export function readOutsideWatch(file: string): OutsideWatchConfig | undefined {
  try {
    const c = JSON.parse(fs.readFileSync(file, 'utf8')) as OutsideWatchConfig;
    return c.host && c.healthUrl && c.ntfyTopic ? c : undefined;
  } catch {
    return undefined;
  }
}
