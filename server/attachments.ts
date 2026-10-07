import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { ATTACHMENT_ID, CHUNK_BYTES, INBOX_DIR, MAX_ATTACHMENTS, MAX_CHUNK_BYTES, attachmentKind, attachmentName, fmtBytes, inboxName } from '../shared/attachments.ts';
import type { AttachmentRef, AttachmentSettings, DeliveredAttachment } from '../shared/types.ts';
import { isObject, readJsonDurable, writeJsonDurable, type Check } from './durable.ts';

/** config attachments (docs/attachments.md). */
export interface AttachmentConfig {
  /** The largest file a person may attach, in MB. Default 200 (big saves, such as the battleship save, exist). */
  maxMB: number;
  /** A file nobody has sent on for this many days is deleted, with its copy in the store. Default 30. */
  retentionDays: number;
}

export const ATTACHMENT_DEFAULTS: AttachmentConfig = { maxMB: 200, retentionDays: 30 };

/** The page's view of config attachments. */
export function attachmentSettings(c: Partial<AttachmentConfig> | undefined): AttachmentSettings {
  const a = { ...ATTACHMENT_DEFAULTS, ...c };
  return { maxBytes: Math.round(a.maxMB * 1024 * 1024), retentionDays: a.retentionDays, maxPerMessage: MAX_ATTACHMENTS };
}

/** A stored attachment: what agents and the page see, and who sent it when. */
export interface AttachmentRecord extends AttachmentRef {
  /** The login that uploaded it. */
  uploadedBy?: string;
  createdAt: string;
  /** Uploaded, sent with a message or handed to an agent: retention counts from the last of these. */
  lastUsedAt: string;
}

/** An upload in progress: its file grows in partial/ until it has `size` bytes. */
interface PartialMeta {
  uploadId: string;
  name: string;
  size: number;
  uploadedBy?: string;
  createdAt: string;
}

/** A refusal with the HTTP status it maps to; `received` tells a client where to resume. */
export class AttachmentError extends Error {
  readonly status: number;
  readonly received?: number;
  constructor(status: number, message: string, received?: number) {
    super(message);
    this.status = status;
    this.received = received;
  }
}

/** An upload left unfinished this long is deleted (the page resumes within a session, not a day later). */
const PARTIAL_MAX_AGE_MS = 24 * 60 * 60_000;
/** A machine may fetch an attachment for this long after the portal handed it one. */
const GRANT_MS = 6 * 60 * 60_000;
const UPLOAD_ID = /^[a-f0-9]{32}$/;
const SHA256 = /^[a-f0-9]{64}$/;

const checkIndex: Check = (v) => (isObject(v) && Array.isArray(v.records) && v.records.every((r) => isObject(r) && typeof r.id === 'string' && typeof r.sha256 === 'string') ? undefined : 'not an attachment index');

/**
 * The attachment store (docs/attachments.md): `<dataDir>/attachments/`, with `blobs/<sha256[0..2]>/<sha256>` (one copy
 * per content, whatever its names), `partial/` (uploads in progress) and `index.json` (the records). Files are written
 * and read as bytes only: nothing here, or anywhere in the server, opens, unpacks or runs them.
 */
export class AttachmentStore {
  readonly root: string;
  private readonly blobDir: string;
  private readonly partialDir: string;
  private readonly indexFile: string;
  private readonly records = new Map<string, AttachmentRecord>();
  /** Uploads with a chunk being written: one writer per upload. */
  private readonly writing = new Set<string>();
  /** Per machine, the attachments it may fetch and until when (machines fetch only what they were handed). */
  private readonly grants = new Map<string, Map<string, number>>();
  private readonly config: () => Partial<AttachmentConfig> | undefined;
  private readonly now: () => number;

  constructor(dataDir: string, config: () => Partial<AttachmentConfig> | undefined = () => undefined, now: () => number = Date.now) {
    this.root = path.join(dataDir, 'attachments');
    this.blobDir = path.join(this.root, 'blobs');
    this.partialDir = path.join(this.root, 'partial');
    this.indexFile = path.join(this.root, 'index.json');
    this.config = config;
    this.now = now;
    fs.mkdirSync(this.blobDir, { recursive: true });
    fs.mkdirSync(this.partialDir, { recursive: true });
    const saved = readJsonDurable<{ records: AttachmentRecord[] }>(this.indexFile, { check: checkIndex });
    for (const r of saved?.records ?? []) this.records.set(r.id, r);
  }

  get settings(): AttachmentSettings {
    return attachmentSettings(this.config());
  }

  // ---------------------------------------------------------------- uploading

  /** Start an upload of `size` bytes named `name`. Refused past the size cap. */
  begin(input: { name: unknown; size: unknown; uploadedBy?: string }): { uploadId: string; name: string; size: number; received: number; chunkBytes: number } {
    const size = Number(input.size);
    if (!Number.isSafeInteger(size) || size <= 0) throw new AttachmentError(400, 'size: the file is empty, or its size is not a whole number of bytes');
    const max = this.settings.maxBytes;
    if (size > max) throw new AttachmentError(413, `the file is ${fmtBytes(size)}; the limit is ${fmtBytes(max)} (config attachments.maxMB)`);
    const name = attachmentName(input.name);
    const uploadId = randomBytes(16).toString('hex');
    const meta: PartialMeta = { uploadId, name, size, ...(input.uploadedBy ? { uploadedBy: input.uploadedBy } : {}), createdAt: new Date(this.now()).toISOString() };
    fs.writeFileSync(this.partialPath(uploadId), '');
    fs.writeFileSync(this.metaPath(uploadId), JSON.stringify(meta));
    return { uploadId, name, size, received: 0, chunkBytes: CHUNK_BYTES };
  }

  /** How far an upload got: where a client resumes after a dropped connection. */
  status(uploadId: string): { uploadId: string; name: string; size: number; received: number } {
    const meta = this.meta(uploadId);
    return { uploadId, name: meta.name, size: meta.size, received: this.received(uploadId) };
  }

  /**
   * Append one chunk at `offset`, which must be where the upload stands (else 409, with `received` to resume from).
   * A chunk cut off part way keeps what arrived: the next status says where to go on. The last chunk finishes the
   * upload: its SHA-256 is computed, the bytes move into the store (or go, when that content is there already) and the
   * record is made.
   */
  async append(uploadId: string, offset: number, body: AsyncIterable<Buffer> | NodeJS.ReadableStream, maxChunk = MAX_CHUNK_BYTES, declared?: number): Promise<{ received: number; size: number; attachment?: AttachmentRecord }> {
    const meta = this.meta(uploadId);
    if (this.writing.has(uploadId)) throw new AttachmentError(409, 'another chunk of this upload is being written', this.received(uploadId));
    const start = this.received(uploadId);
    if (!Number.isSafeInteger(offset) || offset !== start) throw new AttachmentError(409, `offset ${offset} is not where the upload stands`, start);
    if (start >= meta.size) throw new AttachmentError(409, 'the upload is already complete', start);
    const limit = Math.min(maxChunk, meta.size - start);
    // A chunk that says it is too big (Content-Length) is refused before a byte is read, so the client hears why.
    if (declared !== undefined && Number.isFinite(declared) && declared > limit) {
      throw new AttachmentError(declared > maxChunk ? 413 : 400, declared > maxChunk ? `a chunk is at most ${fmtBytes(maxChunk)}` : `more bytes than the ${meta.size} announced`, start);
    }
    this.writing.add(uploadId);
    const file = this.partialPath(uploadId);
    let written = 0;
    let refused: AttachmentError | undefined;
    try {
      const guard = new Transform({
        transform(chunk: Buffer, _enc, done) {
          written += chunk.length;
          if (written > limit) {
            refused = new AttachmentError(written > maxChunk ? 413 : 400, written > maxChunk ? `a chunk is at most ${fmtBytes(maxChunk)}` : `more bytes than the ${meta.size} announced`, start);
            return done(refused);
          }
          done(null, chunk);
        },
      });
      try {
        await pipeline(body as NodeJS.ReadableStream, guard, fs.createWriteStream(file, { flags: 'a' }));
      } catch (e) {
        if (refused) {
          // Nothing of a refused chunk is kept: the upload stands where it stood.
          fs.truncateSync(file, start);
          throw refused;
        }
        // The connection dropped part way: what arrived is kept, and the client resumes from status().
        throw new AttachmentError(400, `the chunk was cut off (${(e as Error).message})`, this.received(uploadId));
      }
    } finally {
      this.writing.delete(uploadId);
    }
    const received = this.received(uploadId);
    if (received < meta.size) return { received, size: meta.size };
    return { received, size: meta.size, attachment: await this.finish(meta) };
  }

  /** Drop an upload in progress (the person removed it from the composer). */
  cancel(uploadId: string) {
    this.meta(uploadId);
    fs.rmSync(this.partialPath(uploadId), { force: true });
    fs.rmSync(this.metaPath(uploadId), { force: true });
  }

  private async finish(meta: PartialMeta): Promise<AttachmentRecord> {
    const file = this.partialPath(meta.uploadId);
    const sha256 = await sha256File(file);
    const blob = this.blobPath(sha256);
    fs.mkdirSync(path.dirname(blob), { recursive: true });
    if (fs.existsSync(blob) && fs.statSync(blob).size === meta.size) fs.rmSync(file, { force: true });
    else fs.renameSync(file, blob);
    fs.rmSync(this.metaPath(meta.uploadId), { force: true });
    const now = new Date(this.now()).toISOString();
    const { kind, mediaType } = attachmentKind(meta.name);
    const rec: AttachmentRecord = { id: this.newId(), name: meta.name, size: meta.size, sha256, kind, mediaType, ...(meta.uploadedBy ? { uploadedBy: meta.uploadedBy } : {}), createdAt: now, lastUsedAt: now };
    this.records.set(rec.id, rec);
    this.save();
    return rec;
  }

  // ---------------------------------------------------------------- reading

  get(id: string): AttachmentRecord | undefined {
    return this.records.get(String(id ?? '').trim().toLowerCase());
  }

  /** The attachments `ids` name, in order, without repeats; throws naming any it does not have. */
  resolve(ids: unknown): AttachmentRecord[] {
    if (ids === undefined || ids === null) return [];
    if (!Array.isArray(ids)) throw new AttachmentError(400, 'attachments: a list of attachment ids, e.g. ["att_k2m9x0q7p3a1"]');
    const want = [...new Set(ids.map((x) => String(x ?? '').trim().toLowerCase()).filter(Boolean))];
    if (want.length > MAX_ATTACHMENTS) throw new AttachmentError(400, `attachments: at most ${MAX_ATTACHMENTS} at once`);
    return want.map((id) => {
      const r = ATTACHMENT_ID.test(id) ? this.records.get(id) : undefined;
      if (!r) throw new AttachmentError(404, `no attachment "${id}" (ids look like att_k2m9x0q7p3a1; one unused for ${this.settings.retentionDays} days is deleted)`);
      return r;
    });
  }

  /** The stored file of a content hash. */
  blobPath(sha256: string): string {
    if (!SHA256.test(sha256)) throw new Error('not a SHA-256');
    return path.join(this.blobDir, sha256.slice(0, 2), sha256);
  }

  /** The stored file of an attachment (absolute), for an orchestrator to read and for downloads. */
  pathOf(ref: AttachmentRef): string {
    return path.resolve(this.blobPath(ref.sha256));
  }

  /** An attachment as an orchestrator gets it: the stored file. */
  stored(ref: AttachmentRef): DeliveredAttachment {
    return { ...publicRef(ref), path: this.pathOf(ref) };
  }

  /** They were sent on: retention counts from now. */
  touch(ids: string[]) {
    const now = new Date(this.now()).toISOString();
    let changed = false;
    for (const id of ids) {
      const r = this.records.get(id);
      if (r) {
        r.lastUsedAt = now;
        changed = true;
      }
    }
    if (changed) this.save();
  }

  // ---------------------------------------------------------------- handing out

  /**
   * Copy an attachment into `<folder>/Inbox/<id>-<name>` (an agent's working folder) and return that path. The Inbox
   * gets a .gitignore of "*", so the copies never show in git. A copy already there with the right size is kept.
   */
  async copyInto(ref: AttachmentRef, folder: string): Promise<string> {
    const dest = await prepareInbox(folder, ref);
    const st = await fs.promises.stat(dest).catch(() => undefined);
    if (st?.size === ref.size) return dest;
    const part = `${dest}.part`;
    await fs.promises.copyFile(this.blobPath(ref.sha256), part);
    await fs.promises.rename(part, dest);
    this.touch([ref.id]);
    return dest;
  }

  /** Let a machine's daemon fetch these (GET /machine/attachments/<id>) for a while: it was handed them. */
  grant(machineId: string, ids: string[]) {
    const m = this.grants.get(machineId) ?? new Map<string, number>();
    const until = this.now() + GRANT_MS;
    for (const id of ids) m.set(id, until);
    this.grants.set(machineId, m);
    this.touch(ids);
  }

  /** Whether a machine was handed this attachment lately. */
  granted(machineId: string, id: string): boolean {
    const until = this.grants.get(machineId)?.get(id);
    return until !== undefined && until > this.now();
  }

  // ---------------------------------------------------------------- retention

  /**
   * Delete what retention says is old: records not used for retentionDays, then every stored file no record names,
   * and uploads left unfinished for a day. Returns what went.
   */
  prune(): { records: number; blobs: number; partials: number } {
    const now = this.now();
    const days = this.settings.retentionDays;
    let records = 0;
    if (days > 0) {
      for (const r of [...this.records.values()]) {
        if (now - Date.parse(r.lastUsedAt) > days * 86_400_000) {
          this.records.delete(r.id);
          records++;
        }
      }
      if (records) this.save();
    }
    const wanted = new Set([...this.records.values()].map((r) => r.sha256));
    let blobs = 0;
    for (const sub of safeList(this.blobDir)) {
      const dir = path.join(this.blobDir, sub);
      for (const f of safeList(dir)) {
        if (SHA256.test(f) && wanted.has(f)) continue;
        fs.rmSync(path.join(dir, f), { force: true });
        blobs++;
      }
    }
    let partials = 0;
    for (const f of safeList(this.partialDir)) {
      const p = path.join(this.partialDir, f);
      const id = f.replace(/\.json$/, '');
      if (this.writing.has(id)) continue;
      const age = now - (fs.statSync(p, { throwIfNoEntry: false })?.mtimeMs ?? now);
      if (age > PARTIAL_MAX_AGE_MS) {
        fs.rmSync(p, { force: true });
        if (!f.endsWith('.json')) partials++;
      }
    }
    for (const [m, g] of this.grants) {
      for (const [id, until] of g) if (until <= now) g.delete(id);
      if (!g.size) this.grants.delete(m);
    }
    return { records, blobs, partials };
  }

  /** Everything stored: the count and the bytes on disk (system_status). */
  usage(): { files: number; bytes: number } {
    const shas = new Map([...this.records.values()].map((r) => [r.sha256, r.size]));
    return { files: this.records.size, bytes: [...shas.values()].reduce((a, b) => a + b, 0) };
  }

  // ---------------------------------------------------------------- internals

  private newId(): string {
    const abc = 'abcdefghijklmnopqrstuvwxyz0123456789';
    for (;;) {
      const id = `att_${Array.from({ length: 12 }, () => abc[randomInt(abc.length)]).join('')}`;
      if (!this.records.has(id)) return id;
    }
  }

  private meta(uploadId: string): PartialMeta {
    if (!UPLOAD_ID.test(String(uploadId))) throw new AttachmentError(404, 'no such upload');
    try {
      return JSON.parse(fs.readFileSync(this.metaPath(uploadId), 'utf8')) as PartialMeta;
    } catch {
      throw new AttachmentError(404, 'no such upload (finished, cancelled, or left for a day and deleted)');
    }
  }

  private received(uploadId: string): number {
    return fs.statSync(this.partialPath(uploadId), { throwIfNoEntry: false })?.size ?? 0;
  }

  private partialPath(uploadId: string) {
    return path.join(this.partialDir, uploadId);
  }

  private metaPath(uploadId: string) {
    return path.join(this.partialDir, `${uploadId}.json`);
  }

  private save() {
    writeJsonDurable(this.indexFile, { records: [...this.records.values()] }, { indent: 1, generations: 2 });
  }
}

/**
 * GET /machine/attachments/<id> (docs/attachments.md): what a machine's daemon may fetch. `machineId` is the machine its
 * token proved, or undefined; it gets only an attachment the portal handed it (grant) lately.
 */
export function machineAttachment(store: AttachmentStore, machineId: string | undefined, id: string): { status: 401 | 404; error: string } | { record: AttachmentRecord; file: string } {
  if (!machineId) return { status: 401, error: 'a machine token is required' };
  const a = store.get(id);
  if (!a || !store.granted(machineId, a.id)) return { status: 404, error: 'no such attachment for this machine' };
  return { record: a, file: store.pathOf(a) };
}

/**
 * fetch_attachment from an agent on a machine: the record, as JSON, and leave for that machine's daemon to fetch the
 * file, which it then does into the agent's Inbox itself (machine/daemon.ts).
 */
export function attachmentForMachine(store: AttachmentStore, machineId: string, id: unknown): string {
  const [a] = store.resolve([String(id ?? '')]);
  store.grant(machineId, [a.id]);
  return JSON.stringify(publicRef(a));
}

/** What agents and the page get of a record: no uploader or dates. */
export function publicRef(r: AttachmentRef): AttachmentRef {
  return { id: r.id, name: r.name, size: r.size, sha256: r.sha256, kind: r.kind, mediaType: r.mediaType };
}

/**
 * Make `<folder>/Inbox/` (with its .gitignore of "*") and return where `ref`'s copy goes. Shared with the machine
 * daemon, which writes its copies itself.
 */
export async function prepareInbox(folder: string, ref: { id: string; name: string }): Promise<string> {
  // The id is part of a file name here: only ever "att_" and 12 letters or digits.
  if (!ATTACHMENT_ID.test(ref.id)) throw new Error(`not an attachment id: ${JSON.stringify(ref.id).slice(0, 40)}`);
  const dir = path.join(folder, INBOX_DIR);
  await fs.promises.mkdir(dir, { recursive: true });
  const ignore = path.join(dir, '.gitignore');
  if (!fs.existsSync(ignore)) await fs.promises.writeFile(ignore, '# Files people attached in FF Factory (docs/attachments.md): never committed.\n*\n');
  return path.join(dir, inboxName({ id: ref.id, name: attachmentName(ref.name) }));
}

/** A file's SHA-256, read as a stream. */
export async function sha256File(file: string): Promise<string> {
  const h = createHash('sha256');
  await pipeline(fs.createReadStream(file), async function* (src: AsyncIterable<Buffer>) {
    for await (const c of src) h.update(c);
  });
  return h.digest('hex');
}

/** A Content-Disposition that downloads (never shows) a file, with its name in ASCII and in UTF-8. */
export function downloadDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

function safeList(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}
