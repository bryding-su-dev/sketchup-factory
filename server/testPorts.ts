// For tests only (w1095): ports that no other test can take. A server a test starts itself listens on port 0 and reads its
// port back (server.address()); a real portal the test spawns does too and says it in its log ("on http://…:<port>",
// server/index.ts). This is for the rest: a port that must be known before the process starts and kept across its
// restarts (scripts/fff-migrate.world.ts), or one nothing listens on (a dead URL).
//
// Why not "listen on 0, read the port, close, use it later": the OS hands that port to the next bind(0) or outgoing
// connection of any test running beside this one (node --test runs files in parallel), which is how crashRecovery.test.ts
// died with EADDRINUSE on PR #335. Here a port comes from below the OS's ephemeral range, which bind(0) and outgoing
// connections never use, and is reserved with a lock file every test process honours, then checked free by binding it.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

/** The lock files: one per reserved port, holding the reserving process's pid. */
const LOCKS = path.join(os.tmpdir(), 'ffsb-test-ports');

/**
 * The ports to hand out: from 20000 up to just below the OS's ephemeral range (Linux: ip_local_port_range, 32768 by
 * default; macOS and Windows start theirs at 49152), never above 32767.
 */
export function portRange(): { low: number; high: number } {
  let ephemeralLow = 32768;
  try {
    ephemeralLow = Number(fs.readFileSync('/proc/sys/net/ipv4/ip_local_port_range', 'utf8').trim().split(/\s+/)[0]) || ephemeralLow;
  } catch {
    // not Linux: its ephemeral range starts at 49152
  }
  return { low: 20000, high: Math.min(32767, ephemeralLow - 1) };
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/**
 * Takes the lock for `port` (an exclusive create), or false when another holds it. A lock whose process is gone is left
 * for an hour, so two processes never both take it over in the same moment, then removed; the port is skipped meanwhile.
 */
function lock(port: number): boolean {
  const file = path.join(LOCKS, String(port));
  try {
    fs.writeFileSync(file, String(process.pid), { flag: 'wx' });
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    try {
      const pid = Number(fs.readFileSync(file, 'utf8')) || 0;
      if (!(pid && alive(pid)) && Date.now() - fs.statSync(file).mtimeMs > 3_600_000) fs.rmSync(file, { force: true });
    } catch {
      // released meanwhile
    }
    return false;
  }
}

/** Whether nothing listens on `port` now, on loopback and on every address. */
async function bindable(port: number): Promise<boolean> {
  for (const host of ['127.0.0.1', '0.0.0.0']) {
    const ok = await new Promise<boolean>((r) => {
      const s = net.createServer();
      s.once('error', () => r(false));
      s.listen(port, host, () => s.close(() => r(true)));
    });
    if (!ok) return false;
  }
  return true;
}

const mine = new Set<number>();
let hooked = false;

/** Gives back a port reservePort took: its lock goes, so another test may take it. */
export function releasePort(port: number) {
  if (!mine.delete(port)) return;
  fs.rmSync(path.join(LOCKS, String(port)), { force: true });
}

/**
 * A port reserved for this test process until it exits (or releasePort): no other test that uses this function gets it,
 * and no bind(0) or outgoing connection anywhere can, as it is below the ephemeral range. Its listener (a spawned portal)
 * binds it itself, as often as it restarts. Tries random ports in the range until one is both lockable and free.
 */
export async function reservePort(): Promise<number> {
  fs.mkdirSync(LOCKS, { recursive: true });
  if (!hooked) {
    hooked = true;
    process.once('exit', () => {
      for (const p of [...mine]) releasePort(p);
    });
  }
  const { low, high } = portRange();
  for (let i = 0; i < 200; i++) {
    const port = low + Math.floor(Math.random() * (high - low + 1));
    if (mine.has(port) || !lock(port)) continue;
    mine.add(port);
    if (await bindable(port)) return port;
    releasePort(port);
  }
  throw new Error(`no free test port in ${low}-${high} after 200 tries`);
}
