// What the portal's transcripts weigh, how fast they grow and what 7 more days would add (w859: "Measure: today's transcript sizes,
// the growth per day, and the projected disk use at 7 days"). Run it ON the portal host, read-only:
//
//   node scripts/transcript-footprint.ts <data dir>        (the folder that holds transcripts/, e.g. /var/lib/ff-factory/data)
//
// Size is the files' bytes now. Growth a day is exact: every event line carries its UTC time `t`, and each line's bytes are counted
// on that day, so a transcript that grew over a week is split by day, unlike file birth times. The gzip ratio is measured on
// a sample of the biggest plain files. The projection adds seven days of the mean daily growth of the last seven full days.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { diskOf, sampleGzipRatio } from '../server/dataGuard.ts';

const dataDir = process.argv[2];
if (!dataDir) {
  console.error('usage: node scripts/transcript-footprint.ts <data dir>');
  process.exit(2);
}
const dir = path.join(dataDir, 'transcripts');
const GB = 1024 ** 3;
const MB = 1024 ** 2;
const fmt = (n: number) => (n >= GB ? `${(n / GB).toFixed(2)} GB` : `${(n / MB).toFixed(1)} MB`);

const perDay = new Map<string, number>();
let files = 0;
let bytes = 0;
let gzFiles = 0;
let gzBytes = 0;
let gzPlain = 0;
const sizes: { id: string; bytes: number }[] = [];
const events = new Map<string, number>();
for (const n of fs.readdirSync(dir)) {
  const m = /^(.+)\.jsonl(\.gz)?$/.exec(n);
  if (!m) continue;
  const p = path.join(dir, n);
  const st = fs.statSync(p);
  let text: string;
  if (m[2]) {
    gzFiles++;
    gzBytes += st.size;
    text = zlib.gunzipSync(fs.readFileSync(p)).toString('utf8');
    gzPlain += text.length;
  } else {
    files++;
    bytes += st.size;
    sizes.push({ id: m[1], bytes: st.size });
    text = fs.readFileSync(p, 'utf8');
  }
  let last = '';
  for (const line of text.split('\n')) {
    if (!line) continue;
    const t = /"t":"(\d{4}-\d{2}-\d{2})/.exec(line)?.[1] ?? last;
    if (!t) continue;
    last = t;
    // the file holds the line plus its newline (UTF-8 bytes)
    perDay.set(t, (perDay.get(t) ?? 0) + Buffer.byteLength(line) + 1);
    events.set(t, (events.get(t) ?? 0) + 1);
  }
}
const days = [...perDay].sort((a, b) => b[0].localeCompare(a[0]));
const today = new Date().toISOString().slice(0, 10);
const full = days.filter(([d]) => d < today).slice(0, 7);
const mean = full.length ? full.reduce((a, [, v]) => a + v, 0) / full.length : 0;
const ratio = sampleGzipRatio(dir);
const disk = diskOf(dir);
console.log(`Transcripts in ${dir}`);
console.log(`- now: ${files} plain file(s), ${fmt(bytes)}; ${gzFiles} compressed, ${fmt(gzBytes)} (${fmt(gzPlain)} unpacked)`);
console.log(`- biggest: ${sizes.sort((a, b) => b.bytes - a.bytes).slice(0, 5).map((s) => `${s.id} ${fmt(s.bytes)}`).join(', ')}`);
console.log('- written per UTC day (events by their own timestamp):');
for (const [d, v] of days.slice(0, 14)) console.log(`    ${d}  ${fmt(v)}  ${events.get(d)} events${d === today ? '  (today so far)' : ''}`);
console.log(`- mean of the last ${full.length} full day(s): ${fmt(mean)} a day`);
console.log(`- projected in 7 days if nothing is removed: ${fmt(bytes + gzBytes + 7 * mean)} (plain ${fmt(bytes + 7 * mean)} + compressed ${fmt(gzBytes)})`);
if (ratio) console.log(`- gzip ratio on a sample of the biggest plain files: ${ratio.toFixed(3)} (compressed / plain); compressing every plain file would leave ${fmt(bytes * ratio + gzBytes)} now and ${fmt((bytes + 7 * mean) * ratio + gzBytes)} in 7 days`);
if (disk) console.log(`- the disk: ${fmt(disk.usedBytes)} of ${fmt(disk.totalBytes)} used (${((disk.usedBytes / disk.totalBytes) * 100).toFixed(0)}%); 7 more days of transcripts is ${((7 * mean) / disk.totalBytes * 100).toFixed(1)}% of it`);
