// The portal's data disk guard (w859, asked by Lothsahn: "We should keep worker transcripts and numbers for at least
// 7 days. But make sure we don't run the portal out of disk"). The transcripts in data/transcripts grow without bound
// (nothing pruned them before), and the spend record (server/spend.ts) needs them readable for as long as a request's
// numbers are being looked at. So, by how full the disk holding data/ is:
//
//   below gzipAtUsedPercent   nothing happens;
//   from gzipAtUsedPercent    every transcript idle for gzipIdleHours is compressed (lossless: readable, searchable, and
//                             written to again if its session is resumed, server/store.ts);
//   from pruneAtUsedPercent   transcripts whose retention has ended are deleted, oldest first, only as many as it takes
//                             to get back PRUNE_MARGIN points below the threshold. A transcript's retention ends retainDays
//                             after the last request it served closed (SpendStore.protectedUntil): never while one is open,
//                             never for an orchestrator's or the ops worker's own conversation. The request's cost record
//                             (data/spend.json) is not touched by a prune;
//   from alertAtUsedPercent   if that still left the disk this full, it says so (the log, and a notice for the dispatcher),
//                             because everything left is inside the retention window or is not a transcript: it never
//                             deletes inside the window, so a person decides (a bigger disk, a shorter window).
//
// The thresholds rest on docs/spend.md "Data guard": the numbers measured there (size, growth, gzip ratio).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import type { SpendStore } from './spend.ts';
import type { DataGuardConfig, Footprint } from '../shared/spend.ts';
export type { DataGuardConfig, Footprint };
import type { Store } from './store.ts';

const gzipAsync = promisify(zlib.gzip);
const gunzipAsync = promisify(zlib.gunzip);
const yieldNow = () => new Promise<void>((r) => setImmediate(r));
export const DATA_GUARD_DEFAULTS: DataGuardConfig = { retainDays: 7, gzipAtUsedPercent: 50, pruneAtUsedPercent: 75, alertAtUsedPercent: 90, gzipIdleHours: 24, everyMinutes: 60 };
/** A prune stops this many points of disk below pruneAtUsedPercent, so it does not run again an hour later. */
export const PRUNE_MARGIN = 5;

export function dataGuardSettings(c: { dataGuard?: Partial<DataGuardConfig> } | undefined): DataGuardConfig {
  const g = { ...DATA_GUARD_DEFAULTS, ...(c?.dataGuard ?? {}) };
  const num = (v: unknown, d: number, min: number, max: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : d);
  const out: DataGuardConfig = {
    retainDays: num(g.retainDays, 7, 1, 3650),
    gzipAtUsedPercent: num(g.gzipAtUsedPercent, 50, 5, 95),
    pruneAtUsedPercent: num(g.pruneAtUsedPercent, 75, 10, 98),
    alertAtUsedPercent: num(g.alertAtUsedPercent, 90, 20, 99),
    gzipIdleHours: num(g.gzipIdleHours, 24, 0, 24 * 365),
    everyMinutes: num(g.everyMinutes, 60, 5, 1440),
  };
  // The steps keep their order.
  out.pruneAtUsedPercent = Math.max(out.pruneAtUsedPercent, out.gzipAtUsedPercent);
  out.alertAtUsedPercent = Math.max(out.alertAtUsedPercent, out.pruneAtUsedPercent);
  return out;
}

export interface TranscriptFile {
  id: string;
  bytes: number;
  mtimeMs: number;
  gz: boolean;
}

export interface GuardPlan {
  level: 'ok' | 'gzip' | 'prune' | 'alert';
  gzip: string[];
  prune: string[];
  /** Bytes the plan expects to free by pruning (a compressed file counts its own size). */
  freeing: number;
  /** Bytes that sit past the guard's reach: transcripts still inside their retention. */
  protectedBytes: number;
  alert?: string;
}

const GB = 1024 ** 3;
const gb = (n: number) => `${(n / GB).toFixed(1)} GB`;

/**
 * What to do now. `protectedUntil(id)`: ms until which a transcript must stay (Infinity: always; undefined: no record, so its
 * file time plus the retention). Pure: the runner does the compressing and deleting.
 */
export function planGuard(files: readonly TranscriptFile[], disk: { usedBytes: number; totalBytes: number }, protectedUntil: (id: string) => number | undefined, now: number, c: DataGuardConfig): GuardPlan {
  const used = disk.totalBytes > 0 ? (disk.usedBytes / disk.totalBytes) * 100 : 0;
  const keepUntil = (f: TranscriptFile) => protectedUntil(f.id) ?? f.mtimeMs + c.retainDays * 86_400_000;
  const protectedBytes = files.filter((f) => keepUntil(f) > now).reduce((a, f) => a + f.bytes, 0);
  const plan: GuardPlan = { level: 'ok', gzip: [], prune: [], freeing: 0, protectedBytes };
  if (used < c.gzipAtUsedPercent) return plan;
  plan.level = 'gzip';
  plan.gzip = files
    .filter((f) => !f.gz && now - f.mtimeMs >= c.gzipIdleHours * 3_600_000)
    .sort((a, b) => b.bytes - a.bytes)
    .map((f) => f.id);
  if (used >= c.pruneAtUsedPercent) {
    plan.level = 'prune';
    const target = ((c.pruneAtUsedPercent - PRUNE_MARGIN) / 100) * disk.totalBytes;
    const need = disk.usedBytes - target;
    for (const f of files.filter((x) => keepUntil(x) <= now).sort((a, b) => keepUntil(a) - keepUntil(b))) {
      if (plan.freeing >= need) break;
      plan.prune.push(f.id);
      plan.freeing += f.bytes;
    }
    if (used >= c.alertAtUsedPercent && plan.freeing < need) {
      plan.level = 'alert';
      plan.alert = `the portal's data disk is ${used.toFixed(0)}% used (${gb(disk.usedBytes)} of ${gb(disk.totalBytes)}); the guard can free ${gb(plan.freeing)} of the ${gb(need)} it needs, because the other transcripts (${gb(protectedBytes)}) are inside their ${c.retainDays}-day retention. It deletes nothing inside it: free space elsewhere on that disk, enlarge it, or shorten dataGuard.retainDays.`;
    }
  }
  return plan;
}

/** The transcript files of a folder. */
export function listTranscripts(dir: string): TranscriptFile[] {
  const out: TranscriptFile[] = [];
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return out;
  }
  for (const n of names) {
    const m = /^(.+)\.jsonl(\.gz)?$/.exec(n);
    if (!m) continue;
    try {
      const st = fs.statSync(path.join(dir, n));
      out.push({ id: m[1], bytes: st.size, mtimeMs: st.mtimeMs, gz: !!m[2] });
    } catch {
      // gone meanwhile
    }
  }
  return out;
}

/** The disk holding `dir`: used and total bytes. undefined where the OS cannot say. */
export function diskOf(dir: string): { usedBytes: number; totalBytes: number } | undefined {
  try {
    const s = fs.statfsSync(dir);
    const total = Number(s.blocks) * Number(s.bsize);
    const free = Number(s.bavail) * Number(s.bsize);
    return total > 0 ? { usedBytes: total - free, totalBytes: total } : undefined;
  } catch {
    return undefined;
  }
}

export interface GuardRun {
  at: string;
  level: GuardPlan['level'];
  usedPercent?: number;
  gzipped: number;
  gzippedFrom: number;
  gzippedTo: number;
  pruned: number;
  prunedBytes: number;
  alert?: string;
  error?: string;
}

/** Compress one transcript: written beside it, checked by reading it back, then the plain file goes. Returns its bytes before and after. */
export async function gzipFile(file: string): Promise<{ from: number; to: number } | undefined> {
  let raw: Buffer;
  try {
    raw = fs.readFileSync(file);
  } catch {
    return undefined;
  }
  // Off the main thread (the pool's), so the portal keeps answering while a big transcript is compressed.
  const gz = await gzipAsync(raw, { level: 9 });
  const out = `${file}.gz`;
  const tmp = `${out}.tmp`;
  fs.writeFileSync(tmp, gz);
  // Only if nothing was appended meanwhile (a session resumed mid-pass) and the copy reads back whole.
  if (fs.statSync(file).size !== raw.length || !(await gunzipAsync(fs.readFileSync(tmp))).equals(raw)) {
    fs.rmSync(tmp, { force: true });
    return undefined;
  }
  fs.renameSync(tmp, out);
  fs.rmSync(file, { force: true });
  return { from: raw.length, to: gz.length };
}

/** One pass: measure, plan, compress, prune, record in the spend record which transcripts are which. */
export async function runDataGuard(o: { dir: string; spend: SpendStore; store: Pick<Store, 'sessions'> & { noteCompressed?: (sessionId: string) => void; deleteUploads?: (sessionId: string) => void }; config: DataGuardConfig; now?: number; disk?: () => { usedBytes: number; totalBytes: number } | undefined }): Promise<GuardRun> {
  const now = o.now ?? Date.now();
  const c = o.config;
  const run: GuardRun = { at: new Date(now).toISOString(), level: 'ok', gzipped: 0, gzippedFrom: 0, gzippedTo: 0, pruned: 0, prunedBytes: 0 };
  const disk = (o.disk ?? (() => diskOf(o.dir)))();
  if (!disk) return { ...run, error: 'the disk holding data/ could not be measured' };
  run.usedPercent = (disk.usedBytes / disk.totalBytes) * 100;
  const files = listTranscripts(o.dir);
  // A session that is running now keeps its plain file whatever its age says.
  const live = (id: string) => {
    const s = o.store.sessions.get(id);
    return !!s && (s.status === 'running' || s.status === 'starting' || s.status === 'waiting_permission');
  };
  // A transcript whose session was removed while it was protected goes as soon as its retention ends, with or without disk pressure.
  for (const f of files) {
    if (o.store.sessions.has(f.id)) continue;
    // Only a transcript the spend record knows: a file with no session and no record may be a state.json restored from an older copy.
    const until = o.spend.protectedUntil(f.id, c.retainDays);
    if (until === undefined || until > now) continue;
    try {
      fs.rmSync(path.join(o.dir, f.id + '.jsonl'), { force: true });
      fs.rmSync(path.join(o.dir, f.id + '.jsonl.gz'), { force: true });
      o.store.deleteUploads?.(f.id);
      run.pruned++;
      run.prunedBytes += f.bytes;
      o.spend.setTranscript(f.id, { state: 'pruned', prunedAt: run.at });
    } catch (e) {
      run.error = (e as Error).message;
    }
  }
  const plan = planGuard(listTranscripts(o.dir).filter((f) => !live(f.id)), disk, (id) => o.spend.protectedUntil(id, c.retainDays), now, c);
  run.level = plan.level;
  for (const id of plan.gzip) {
    try {
      const r = await gzipFile(path.join(o.dir, `${id}.jsonl`));
      await yieldNow();
      if (!r) continue;
      run.gzipped++;
      run.gzippedFrom += r.from;
      run.gzippedTo += r.to;
      o.spend.setTranscript(id, { state: 'gz', bytes: r.to });
      o.store.noteCompressed?.(id);
    } catch (e) {
      run.error = (e as Error).message;
    }
  }
  for (const id of plan.prune) {
    const f = files.find((x) => x.id === id);
    try {
      fs.rmSync(path.join(o.dir, `${id}.jsonl`), { force: true });
      fs.rmSync(path.join(o.dir, `${id}.jsonl.gz`), { force: true });
      o.store.deleteUploads?.(id);
      run.pruned++;
      run.prunedBytes += f?.bytes ?? 0;
      o.spend.setTranscript(id, { state: 'pruned', prunedAt: run.at });
    } catch (e) {
      run.error = (e as Error).message;
    }
  }
  if (plan.alert) run.alert = plan.alert;
  return run;
}

export function footprint(dir: string, now = Date.now(), sampleRatio?: number): Footprint {
  const names = (() => {
    try {
      return fs.readdirSync(dir);
    } catch {
      return [] as string[];
    }
  })();
  let files = 0;
  let bytes = 0;
  let gzFiles = 0;
  let gzBytes = 0;
  const days = new Map<string, { files: number; bytes: number }>();
  const all: { id: string; bytes: number }[] = [];
  for (const n of names) {
    const m = /^(.+)\.jsonl(\.gz)?$/.exec(n);
    if (!m) continue;
    let st: fs.Stats;
    try {
      st = fs.statSync(path.join(dir, n));
    } catch {
      continue;
    }
    if (m[2]) {
      gzFiles++;
      gzBytes += st.size;
      continue;
    }
    files++;
    bytes += st.size;
    all.push({ id: m[1], bytes: st.size });
    const born = st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs;
    const d = new Date(born).toISOString().slice(0, 10);
    const e = days.get(d) ?? { files: 0, bytes: 0 };
    e.files++;
    e.bytes += st.size;
    days.set(d, e);
  }
  const cutoff = new Date(now - 14 * 86_400_000).toISOString().slice(0, 10);
  const perDay = [...days].filter(([d]) => d >= cutoff).sort((a, b) => b[0].localeCompare(a[0])).map(([day, v]) => ({ day, ...v }));
  const growthPerDay = perDay.length ? perDay.reduce((a, d) => a + d.bytes, 0) / perDay.length : 0;
  const ratio = sampleRatio;
  return {
    at: new Date(now).toISOString(),
    files,
    bytes,
    gzFiles,
    gzBytes,
    perDay,
    growthPerDay,
    biggest: all.sort((a, b) => b.bytes - a.bytes).slice(0, 5),
    disk: diskOf(dir),
    projected7d: { plain: bytes + 7 * growthPerDay, compressed: ratio ? (bytes + 7 * growthPerDay) * ratio : 0 },
    ...(ratio ? { gzipRatio: ratio } : {}),
  };
}

/** The gzip ratio (compressed / plain) of a sample of the plain transcripts, biggest first: measured, not assumed. */
export function sampleGzipRatio(dir: string, maxFiles = 8, maxBytes = 64 * 1024 * 1024): number | undefined {
  const plain = listTranscripts(dir).filter((f) => !f.gz && f.bytes > 0).sort((a, b) => b.bytes - a.bytes);
  let from = 0;
  let to = 0;
  for (const f of plain.slice(0, maxFiles)) {
    if (f.bytes > maxBytes) continue;
    try {
      const raw = fs.readFileSync(path.join(dir, `${f.id}.jsonl`));
      from += raw.length;
      to += zlib.gzipSync(raw, { level: 6 }).length;
    } catch {
      // gone meanwhile
    }
  }
  return from > 0 ? to / from : undefined;
}

let ratioCache: { at: number; ratio: number | undefined } | undefined;
/** sampleGzipRatio, remembered for six hours: it compresses a sample, which is not free. */
export function gzipRatioCached(dir: string, now = Date.now()): number | undefined {
  // Never compresses on the caller's turn: the first call starts a background sample and answers nothing yet.
  if (!ratioCache || now - ratioCache.at > 6 * 3_600_000) {
    ratioCache = { at: now, ratio: ratioCache?.ratio };
    void sampleGzipRatioAsync(dir, 3, 8 * 1024 * 1024).then((r) => {
      if (r !== undefined) ratioCache = { at: now, ratio: r };
    });
  }
  return ratioCache.ratio;
}

/** sampleGzipRatio without blocking: the pool compresses each file. */
export async function sampleGzipRatioAsync(dir: string, maxFiles = 8, maxBytes = 64 * 1024 * 1024): Promise<number | undefined> {
  const plain = listTranscripts(dir).filter((f) => !f.gz && f.bytes > 0).sort((a, b) => b.bytes - a.bytes);
  let from = 0;
  let to = 0;
  for (const f of plain.filter((x) => x.bytes <= maxBytes).slice(0, maxFiles)) {
    try {
      const raw = fs.readFileSync(path.join(dir, `${f.id}.jsonl`));
      from += raw.length;
      to += (await gzipAsync(raw, { level: 6 })).length;
    } catch {
      // gone meanwhile
    }
  }
  return from > 0 ? to / from : undefined;
}

/** The footprint as text for the spend_report tool. */
export function renderFootprint(f: Footprint, c: DataGuardConfig): string {
  const lines = [`Transcripts: ${f.files} plain file(s), ${gb(f.bytes)}; ${f.gzFiles} compressed, ${gb(f.gzBytes)}.`];
  if (f.disk) lines.push(`Disk holding data/: ${gb(f.disk.usedBytes)} of ${gb(f.disk.totalBytes)} used (${((f.disk.usedBytes / f.disk.totalBytes) * 100).toFixed(0)}%). Guard: compress idle transcripts from ${c.gzipAtUsedPercent}%, delete those more than ${c.retainDays} days past their request's close from ${c.pruneAtUsedPercent}%, say so from ${c.alertAtUsedPercent}%.`);
  if (f.perDay.length) lines.push(`Started per day (file birth time): ${f.perDay.slice(0, 8).map((d) => `${d.day} ${d.files} file(s) ${gb(d.bytes)}`).join('; ')}. Average ${gb(f.growthPerDay)} a day.`);
  lines.push(`In 7 days, if nothing is removed: ${gb(f.projected7d.plain)} plain${f.gzipRatio ? `; compressed at the measured ratio ${f.gzipRatio.toFixed(2)}: ${gb(f.projected7d.compressed)}` : ''}.`);
  if (f.biggest.length) lines.push(`Biggest: ${f.biggest.map((b) => `${b.id} ${gb(b.bytes)}`).join(', ')}.`);
  return lines.join('\n');
}
