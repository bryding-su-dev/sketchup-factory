import { useSyncExternalStore } from 'react';
import type { AttachmentRef } from '../../shared/types';
import { ApiError, api, notifyUnauthorized, UnauthorizedError } from './api';

/** An upload refused or broken: `received` (from the server) says where to resume, when it said. */
class UploadError extends ApiError {
  received?: number;
  constructor(status: number, message: string, received?: number) {
    super(status, message);
    this.received = received;
  }
}

const abortError = () => new DOMException('Upload cancelled', 'AbortError');

/**
 * One chunk, as raw bytes (docs/attachments.md): XMLHttpRequest, because fetch() reports no upload progress. The
 * x-ff-upload header is what the server's CSRF check asks of a non-JSON write.
 */
function putChunk(uploadId: string, offset: number, blob: Blob, onLoaded: (bytes: number) => void, signal: AbortSignal) {
  return new Promise<{ received: number; size: number; attachment?: AttachmentRef }>((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('PUT', `/api/attachments/uploads/${uploadId}?offset=${offset}`);
    x.setRequestHeader('Content-Type', 'application/octet-stream');
    x.setRequestHeader('X-FF-Upload', '1');
    // A chunk is 8 MB: minutes even on a slow link. A link that stalls longer than this is retried from where it got.
    x.timeout = 5 * 60_000;
    x.upload.onprogress = (e) => onLoaded(e.loaded);
    const onAbort = () => x.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    const done = () => signal.removeEventListener('abort', onAbort);
    x.onload = () => {
      done();
      let body: { error?: string; received?: number; size?: number; attachment?: AttachmentRef } = {};
      try {
        body = JSON.parse(x.responseText || '{}');
      } catch {
        // not JSON (a proxy's error page)
      }
      if (x.status === 401) {
        notifyUnauthorized();
        return reject(new UnauthorizedError());
      }
      if (x.status >= 200 && x.status < 300) return resolve({ received: body.received ?? offset, size: body.size ?? 0, attachment: body.attachment });
      reject(new UploadError(x.status, body.error ?? `${x.status} ${x.statusText}`, body.received));
    };
    x.onerror = () => {
      done();
      reject(new UploadError(0, 'the connection dropped'));
    };
    x.ontimeout = () => {
      done();
      reject(new UploadError(0, 'the connection stalled'));
    };
    x.onabort = () => {
      done();
      reject(abortError());
    };
    x.send(blob);
  });
}

/** Refusals that another try would not change: too big, gone, not allowed, not logged in. */
const final = (e: unknown) => e instanceof UnauthorizedError || (e instanceof ApiError && [401, 403, 404, 413, 415].includes(e.status));

/**
 * Upload one file in chunks that resume (docs/attachments.md): `onProgress` hears the bytes the server has (and the
 * bytes of the chunk on the way); a dropped connection is retried from where the server says it got, up to 8 times in a
 * row with growing pauses. Resolves with the stored attachment; rejects with an AbortError when `signal` aborts.
 */
export async function uploadAttachment(file: File, onProgress: (sent: number) => void, signal: AbortSignal): Promise<AttachmentRef> {
  const started = await api.beginAttachment(file.name, file.size);
  const { uploadId, chunkBytes } = started;
  let received = started.received;
  let failures = 0;
  try {
    for (;;) {
      if (signal.aborted) throw abortError();
      const end = Math.min(file.size, received + chunkBytes);
      try {
        const r = await putChunk(uploadId, received, file.slice(received, end), (n) => onProgress(received + n), signal);
        failures = 0;
        received = r.received;
        onProgress(received);
        if (r.attachment) return r.attachment;
      } catch (e) {
        if (signal.aborted || (e as Error).name === 'AbortError' || final(e)) throw e;
        if (e instanceof UploadError && e.status === 409 && e.received !== undefined) {
          received = e.received;
          continue;
        }
        if (++failures > 8) throw e;
        await new Promise((r) => setTimeout(r, Math.min(30_000, 1000 * 2 ** Math.min(failures, 5))));
        // Where the server stands now: the chunk may have landed in part, or whole.
        received = (await api.attachmentUpload(uploadId)).received;
      }
    }
  } catch (e) {
    void api.cancelAttachment(uploadId).catch(() => undefined);
    throw e;
  }
}

// ---------------------------------------------------------------- files waiting to be sent, per chat

/** A file being attached in a chat (docs/attachments.md): uploading, uploaded (`ref`), or failed (`error`). */
export interface PendingFile {
  key: number;
  file: File;
  sent: number;
  ref?: AttachmentRef;
  error?: string;
  abort: AbortController;
}

/**
 * Each chat's files, outside React: an upload goes on while its chat is closed (a 200 MB save takes minutes over a
 * slow link) and its chips are there again when the chat opens. Lost with the page, like the images.
 */
const pendingBySession = new Map<string, PendingFile[]>();
const listeners = new Set<() => void>();
const NONE: PendingFile[] = [];

function update(sessionId: string, fn: (xs: PendingFile[]) => PendingFile[]) {
  const next = fn(pendingBySession.get(sessionId) ?? NONE);
  if (next.length) pendingBySession.set(sessionId, next);
  else pendingBySession.delete(sessionId);
  listeners.forEach((l) => l());
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** Whether any chat has files attached and not sent (a reload would drop them). */
export function hasPendingFiles(): boolean {
  return pendingBySession.size > 0;
}

/** A chat's files, as a React hook. */
export function usePendingFiles(sessionId: string): PendingFile[] {
  return useSyncExternalStore(subscribe, () => pendingBySession.get(sessionId) ?? NONE);
}

/** Upload `file` for a chat now (or again, for a failed one: same `key`); its chip follows the progress. */
export function startUpload(sessionId: string, file: File, key = Math.random()) {
  const abort = new AbortController();
  update(sessionId, (xs) => (xs.some((x) => x.key === key) ? xs.map((x) => (x.key === key ? { key, file, sent: 0, abort } : x)) : [...xs, { key, file, sent: 0, abort }]));
  const patch = (p: Partial<PendingFile>) => update(sessionId, (xs) => xs.map((x) => (x.key === key && x.abort === abort ? { ...x, ...p } : x)));
  let shown = -1;
  uploadAttachment(
    file,
    (sent) => {
      // A render per whole percent, not per progress event.
      const pct = Math.floor((sent * 100) / file.size);
      if (pct !== shown) {
        shown = pct;
        patch({ sent });
      }
    },
    abort.signal,
  ).then(
    (ref) => patch({ sent: file.size, ref }),
    (e: Error) => {
      if (e.name !== 'AbortError') patch({ error: e.message });
    },
  );
}

/** Drop one file from a chat (cancelling its upload). */
export function removePending(sessionId: string, key: number) {
  update(sessionId, (xs) => {
    xs.find((x) => x.key === key)?.abort.abort();
    return xs.filter((x) => x.key !== key);
  });
}

/** The chat's message went: its files with it. */
export function clearPending(sessionId: string, sent: PendingFile[]) {
  const keys = new Set(sent.map((f) => f.key));
  update(sessionId, (xs) => xs.filter((x) => !keys.has(x.key)));
}
