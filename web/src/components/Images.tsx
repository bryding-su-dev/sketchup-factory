import { useEffect, useMemo, useState } from 'react';
import { isVideoPath, mentionedPaths } from '../../../shared/imagePaths';
import type { ImageFile, ImageRef } from '../../../shared/types';
import { api } from '../api';
import { attempt, closeLightbox, openLightbox, toast, useStore, type LightboxItem } from '../store';
import { copyImage, fmtBytes, fmtRelative, useNow } from '../util';
import { Icon } from './ui';

/** Where an image file lives, for /api/image: a session's, sandbox's or machine's folders. */
export type ImagePlace = { session: string } | { sandbox: string } | { machine: string };

export const uploadUrl = (sessionId: string, ref: ImageRef) => `/api/uploads/${encodeURIComponent(sessionId)}/${encodeURIComponent(ref.id)}`;
export const fileUrl = (place: ImagePlace, path: string) => `/api/image?${new URLSearchParams({ ...place, path })}`;
export const baseName = (p: string) => p.split(/[\\/]/).pop() || p;
export { isVideoPath, mentionedPaths };
/** "#t=0.1" makes Safari (iPad) and Chrome paint the first frame as the poster before playing. */
export const posterSrc = (src: string) => `${src}#t=0.1`;

/** Thumbnails; a click opens the lightbox on that image, with the others to page through. */
export function ImageStrip({ items, size = 'normal' }: { items: LightboxItem[]; size?: 'normal' | 'small' }) {
  const [broken, setBroken] = useState<Set<string>>(new Set());
  const shown = items.filter((i) => !broken.has(i.src));
  if (!shown.length) return null;
  return (
    <div className={`img-strip img-strip-${size}`}>
      {shown.map((it, i) => (
        <button key={it.src} className="img-thumb" title={it.name} onClick={() => openLightbox(shown, i)}>
          <img src={it.src} alt={it.name} loading="lazy" onError={() => setBroken((b) => new Set(b).add(it.src))} />
        </button>
      ))}
    </div>
  );
}

/**
 * Images and videos an agent wrote about by bare path: shown if the file is in its folders (the server checks).
 * `src` gives a path's URL (the copy kept with the transcript, once there is one).
 */
export function MentionedImages({ text, src }: { text: string; src: (path: string) => string }) {
  const items = useMemo(() => mentionedPaths(text).map((p) => ({ src: src(p), name: baseName(p), video: isVideoPath(p) })), [text, src]);
  const images = items.filter((i) => !i.video);
  const videos = items.filter((i) => i.video);
  return (
    <>
      <ImageStrip items={images} />
      <VideoStrip items={videos} />
    </>
  );
}

/** Videos inline: the player loads only their metadata (and first frame) until played; seeking uses HTTP ranges. */
export function VideoStrip({ items }: { items: LightboxItem[] }) {
  const [broken, setBroken] = useState<Set<string>>(new Set());
  const shown = items.filter((i) => !broken.has(i.src));
  if (!shown.length) return null;
  return (
    <div className="video-strip">
      {shown.map((it, i) => (
        <figure key={it.src} className="video-item">
          <video src={posterSrc(it.src)} controls playsInline muted preload="metadata" onError={() => setBroken((b) => new Set(b).add(it.src))} />
          <figcaption className="dim small">
            <span className="ellipsis mono">{it.name}</span>
            <button className="btn btn-ghost btn-sm" onClick={() => openLightbox(shown, i)} title="Open large">
              <Icon name="expand" size={12} />
            </button>
          </figcaption>
        </figure>
      ))}
    </div>
  );
}

/** Full-size view: page through, copy the image, download it, open it on its own. */
export function Lightbox() {
  const lb = useStore((s) => s.lightbox);
  const [i, setI] = useState(0);
  // Actual size, scrolled: a wide diagram or a big screenshot is unreadable fitted to the screen.
  const [zoomed, setZoomed] = useState(false);
  useEffect(() => setI(lb?.index ?? 0), [lb]);
  useEffect(() => setZoomed(false), [lb, i]);
  useEffect(() => {
    if (!lb) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeLightbox();
      if (e.key === 'ArrowRight') setI((x) => Math.min(lb.items.length - 1, x + 1));
      if (e.key === 'ArrowLeft') setI((x) => Math.max(0, x - 1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lb]);
  if (!lb) return null;
  const it = lb.items[Math.min(i, lb.items.length - 1)];
  const copy = async () => {
    const ok = await copyImage(it.src).catch((e) => (toast((e as Error).message, 'error'), false));
    if (ok) toast('Image copied');
  };
  return (
    <div className="overlay lightbox" onMouseDown={(e) => e.target === e.currentTarget && closeLightbox()}>
      <div className="lightbox-bar">
        <span className="ellipsis mono small">{it.name}</span>
        {lb.items.length > 1 && (
          <span className="dim small">
            {i + 1} / {lb.items.length}
          </span>
        )}
        <div className="spacer" />
        {!it.video && (
          <button className="btn btn-ghost btn-sm" onClick={copy} title="Copy image">
            <Icon name="copy" size={14} /> <span className="hide-sm">Copy</span>
          </button>
        )}
        <a className="btn btn-ghost btn-sm" href={it.src} download={it.name} title="Download">
          <Icon name="download" size={14} /> <span className="hide-sm">Download</span>
        </a>
        {!it.src.startsWith('data:') && (
          <a className="btn btn-ghost btn-sm" href={it.src} target="_blank" rel="noreferrer" title="Open on its own">
            <Icon name="expand" size={14} />
          </a>
        )}
        <button className="btn btn-ghost btn-icon" onClick={closeLightbox} aria-label="Close">
          <Icon name="x" />
        </button>
      </div>
      <div className={`lightbox-stage${zoomed ? ' zoomed' : ''}`} onMouseDown={(e) => e.target === e.currentTarget && closeLightbox()}>
        {i > 0 && (
          <button className="lightbox-nav prev" onClick={() => setI(i - 1)} aria-label="Previous">
            <Icon name="back" size={22} />
          </button>
        )}
        {it.video ? (
          <video key={it.src} src={it.src} controls playsInline autoPlay />
        ) : (
          <img src={it.src} alt={it.name} title={zoomed ? 'Fit to the screen' : 'Actual size'} onClick={() => setZoomed(!zoomed)} />
        )}
        {i < lb.items.length - 1 && (
          <button className="lightbox-nav next" onClick={() => setI(i + 1)} aria-label="Next">
            <Icon name="chevron" size={22} />
          </button>
        )}
      </div>
    </div>
  );
}

/** The recent images agents left in a sandbox or on a machine (Assets/Screenshots, specs/proofs, Logs, …). */
export function ScreenshotsDrawer({ place, title, onClose }: { place: { sandbox: string } | { machine: string }; title: string; onClose: () => void }) {
  const now = useNow();
  const [files, setFiles] = useState<ImageFile[] | null>(null);
  const [loading, setLoading] = useState(false);
  const load = async () => {
    setLoading(true);
    const r = await attempt(api.screenshots(place));
    setLoading(false);
    setFiles(r ?? []);
  };
  useEffect(() => {
    void load();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !document.querySelector('.lightbox') && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const items = (files ?? []).map((f) => ({ src: fileUrl(place, f.path), name: baseName(f.path), video: isVideoPath(f.path) }));
  return (
    <div className="overlay overlay-drawer" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="drawer" role="dialog" aria-modal>
        <header className="drawer-head">
          <Icon name="image" />
          <span className="ellipsis">
            Screenshots and videos · <span className="accent">{title}</span>
          </span>
          <div className="spacer" />
          <button className="btn btn-ghost btn-icon" onClick={load} title="Refresh" aria-label="Refresh">
            {loading ? <span className="spinner" /> : <Icon name="refresh" />}
          </button>
          <button className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Close">
            <Icon name="x" />
          </button>
        </header>
        <div className="gallery">
          {files === null && <p className="dim">Loading…</p>}
          {files?.length === 0 && <p className="dim">No images or videos yet in Assets/Screenshots, Screenshots, specs/*/proofs, Logs or Temp/Screenshots.</p>}
          {files?.map((f, i) => (
            <button key={f.path} className="gallery-item" title={f.path} onClick={() => openLightbox(items, i)}>
              {items[i].video ? (
                <span className="gallery-video">
                  <video src={posterSrc(items[i].src)} muted playsInline preload="metadata" />
                  <Icon name="play" size={22} />
                </span>
              ) : (
                <img src={items[i].src} alt={items[i].name} loading="lazy" />
              )}
              <span className="gallery-cap ellipsis">{items[i].name}</span>
              <span className="gallery-meta dim">
                {fmtRelative(f.mtime, now)} · {fmtBytes(f.size)}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
