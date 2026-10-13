import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import type { SearchHit, SessionInfo, TranscriptEvent } from '../shared/types.ts';

export interface SearchQuery {
  /** Words; every one must appear (case-insensitive). "quoted phrases" count as one word. */
  q: string;
  /** Only these sessions (from the sandbox / machine / agent filters). */
  sessionIds?: Set<string>;
  /** ISO dates or datetimes; `until` is inclusive of its whole day when it is a bare date. */
  since?: string;
  until?: string;
  limit?: number;
}

/** Split a query into lower-case terms, keeping "quoted phrases" whole. Exported for tests. */
export function terms(q: string): string[] {
  const out: string[] = [];
  for (const m of q.matchAll(/"([^"]+)"|(\S+)/g)) {
    const t = (m[1] ?? m[2]).trim().toLowerCase();
    if (t) out.push(t);
  }
  return out;
}

/** The text of an event that search looks at. */
export function searchableText(e: TranscriptEvent): string {
  switch (e.kind) {
    case 'user':
    case 'assistant':
    case 'thinking':
    case 'system':
    case 'error':
    case 'result':
      return e.text;
    case 'tool_use':
      return `${e.name} ${JSON.stringify(e.input)}`;
    case 'tool_result':
      return e.text;
    case 'permission':
      return `${e.toolName} ${JSON.stringify(e.input)}`;
  }
}

/** ~160 characters around the first term, on one line. */
export function snippet(text: string, words: string[]): string {
  const flat = text.replace(/\s+/g, ' ');
  const lower = flat.toLowerCase();
  const at = Math.max(0, lower.indexOf(words[0] ?? ''));
  const start = Math.max(0, at - 70);
  const end = Math.min(flat.length, at + (words[0]?.length ?? 0) + 90);
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`;
}

/**
 * Full-text search over every transcript (data/transcripts/*.jsonl), newest first. A plain scan: each
 * line is tested as raw text before it is parsed, so the cost is roughly reading the files once.
 */
export function searchTranscripts(dir: string, sessions: Map<string, SessionInfo>, query: SearchQuery): { hits: SearchHit[]; scanned: number; ms: number } {
  const started = Date.now();
  const words = terms(query.q);
  if (!words.length) return { hits: [], scanned: 0, ms: 0 };
  const since = query.since ? Date.parse(query.since) : -Infinity;
  const untilRaw = query.until ? Date.parse(query.until) : Infinity;
  const until = query.until && /^\d{4}-\d{2}-\d{2}$/.test(query.until) ? untilRaw + 86_400_000 - 1 : untilRaw;
  const limit = Math.min(Math.max(query.limit ?? 100, 1), 500);
  // The raw-line prefilter tests single words: a phrase's words may sit around an escaped newline.
  const parts = [...new Set(words.flatMap((w) => w.split(' ')))].filter((w) => w && !/["\\]/.test(w));
  const hits: SearchHit[] = [];
  let scanned = 0;
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl') || f.endsWith('.jsonl.gz'));
  } catch {
    return { hits, scanned, ms: 0 };
  }
  for (const f of files) {
    const sessionId = f.replace(/\.jsonl(\.gz)?$/, '');
    // Both files at once (a session resumed since the guard compressed it): the plain one is newer and holds the compressed one's events too.
    if (f.endsWith('.gz') && files.includes(`${sessionId}.jsonl`)) continue;
    if (query.sessionIds && !query.sessionIds.has(sessionId)) continue;
    const file = path.join(dir, f);
    // A transcript last written before `since` has nothing newer.
    if (Number.isFinite(since)) {
      try {
        if (fs.statSync(file).mtimeMs < since) continue;
      } catch {
        continue;
      }
    }
    let raw: string;
    try {
      raw = f.endsWith('.gz') ? zlib.gunzipSync(fs.readFileSync(file)).toString('utf8') : fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    scanned++;
    const s = sessions.get(sessionId);
    for (const line of raw.split('\n')) {
      if (!line) continue;
      const lower = line.toLowerCase();
      // JSON escapes quotes, backslashes and newlines, so words with those skip this prefilter;
      // the parsed text below is the real test.
      if (!parts.every((w) => lower.includes(w))) continue;
      let e: TranscriptEvent;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      const t = Date.parse(e.t);
      if (t < since || t > until) continue;
      const text = searchableText(e) ?? '';
      const tl = text.replace(/\s+/g, ' ').toLowerCase();
      if (!words.every((w) => tl.includes(w))) continue;
      hits.push({
        sessionId,
        seq: e.seq,
        t: e.t,
        kind: e.kind,
        snippet: snippet(text, words),
        title: s?.title ?? sessionId,
        sessionKind: s?.kind,
        sandboxId: s?.sandboxId,
        machineId: s?.machineId,
        standingId: s?.standingId,
      });
    }
  }
  hits.sort((a, b) => b.t.localeCompare(a.t));
  return { hits: hits.slice(0, limit), scanned, ms: Date.now() - started };
}
