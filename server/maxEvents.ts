// Max events (docs/max.md): the ffdiscord CLI appends one JSON line per thing an agent did as Max to the file
// named by FF_MAX_EVENTS, which SketchUp Factory sets for every agent it starts. This module reads that file: the
// portal tails its own (server/max.ts) and a machine's daemon tails the Mac's and forwards the lines
// (machine/daemon.ts). No secret is involved: the file holds what was posted where, never the bot token.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { redactSecrets } from './secrets.ts';
import type { MaxAction } from '../shared/types.ts';

/** Where the events file is on the host and on every Mac, unless config max.eventsFile says otherwise. Outside the guarded folders on purpose: agents write it. */
export const defaultEventsFile = () => path.join(os.homedir(), '.config', 'ff-factory', 'max-events.jsonl');

/** The host's events file: config max.eventsFile, else the default. */
export const eventsFileOf = (cfg: { max?: { eventsFile?: string } }) => (cfg.max?.eventsFile ? path.resolve(cfg.max.eventsFile) : defaultEventsFile());

/** The environment an agent on this host gets so its ffdiscord calls report here: the file, and whose they are. */
export const maxEnv = (cfg: { max?: { eventsFile?: string } }, sessionId: string): Record<string, string> => ({ FF_MAX_EVENTS: eventsFileOf(cfg), FF_SESSION_ID: sessionId });

/** A line longer than this is not an event (the CLI writes a few hundred bytes). */
export const MAX_LINE = 8 * 1024;
/** Rotated (renamed to .1) once read past this size. */
const ROTATE_BYTES = 2 * 1024 * 1024;

const snowflake = z.string().regex(/^\d{5,25}$/);
const ACTIONS = ['post', 'reply', 'ask', 'edit', 'thread_create', 'close', 'rename'] as const satisfies readonly MaxAction[];

/** One line as the CLI writes it (version 1). Unknown fields are ignored; a wrong one drops the line. */
export const CliEventSchema = z.object({
  v: z.literal(1),
  at: z.string().refine((s) => !isNaN(Date.parse(s)), 'not a time'),
  action: z.enum(ACTIONS),
  ok: z.boolean(),
  channel_id: snowflake.nullish(),
  channel: z.string().max(200).nullish(),
  guild_id: snowflake.nullish(),
  message_id: snowflake.nullish(),
  thread_id: snowflake.nullish(),
  text: z.string().max(4000).nullish(),
  error: z.string().max(2000).nullish(),
  session: z.string().max(80).nullish(),
});
export type CliEvent = z.infer<typeof CliEventSchema>;

/** Control and direction characters out, one line, secrets redacted, cut to `max`. */
export const cleanLine = (s: string, max: number) =>
  redactSecrets(s)
    .split(/\r?\n/)
    .find((l) => l.trim())
    ?.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max) ?? '';

/** Parse one line; undefined when it is not a valid event. */
export function parseEventLine(line: string): CliEvent | undefined {
  if (!line.trim() || line.length > MAX_LINE) return undefined;
  try {
    const r = CliEventSchema.safeParse(JSON.parse(line));
    return r.success ? r.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Follow a file that several processes append to. It polls (fs.watch is unreliable on network and Windows
 * folders), reads only complete lines, starts at the end the first time it sees a file (`fromStart` for tests),
 * notices truncation, and rotates the file once it is big and fully read: renamed to <file>.1, whose rest is read
 * first. The CLI opens the file per append, so its next write makes a new one.
 */
export class FileTail {
  private offset: number;
  private partial = '';
  private timer?: NodeJS.Timeout;
  readonly file: string;
  private readonly onLine: (line: string) => void;
  constructor(file: string, onLine: (line: string) => void, opts: { offset?: number; fromStart?: boolean } = {}) {
    this.file = file;
    this.onLine = onLine;
    this.offset = opts.offset ?? (opts.fromStart ? 0 : this.size());
  }

  /** How far the file has been read, to be kept across restarts. */
  get position() {
    return this.offset;
  }

  start(everyMs = 2000) {
    this.timer = setInterval(() => this.poll(), everyMs);
    this.timer.unref();
    return this;
  }

  stop() {
    clearInterval(this.timer);
  }

  private size(file = this.file) {
    try {
      return fs.statSync(file).size;
    } catch {
      return 0;
    }
  }

  /** Read what was appended since the last call. */
  poll() {
    const size = this.size();
    if (size < this.offset) {
      // Truncated or replaced: start over.
      this.offset = 0;
      this.partial = '';
    }
    if (size > this.offset) this.read(this.file, size);
    if (this.offset >= ROTATE_BYTES && !this.partial) this.rotate();
  }

  private read(file: string, end: number) {
    let fd: number | undefined;
    try {
      fd = fs.openSync(file, 'r');
      const len = Math.min(end - this.offset, 4 * 1024 * 1024);
      const buf = Buffer.alloc(len);
      const n = fs.readSync(fd, buf, 0, len, this.offset);
      this.offset += n;
      const text = this.partial + buf.subarray(0, n).toString('utf8');
      const lines = text.split('\n');
      this.partial = lines.pop() ?? '';
      if (this.partial.length > MAX_LINE) this.partial = '';
      for (const l of lines) if (l.trim()) this.onLine(l.replace(/\r$/, ''));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') console.warn(`max events: could not read ${file}:`, (e as Error).message);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }

  private rotate() {
    const old = this.file + '.1';
    try {
      fs.renameSync(this.file, old);
    } catch {
      return;
    }
    // A writer that opened the file before the rename lands in .1: read its rest before moving on.
    this.read(old, this.size(old));
    this.offset = 0;
    this.partial = '';
  }
}
