/**
 * The images an agent's message shows: markdown images `![alt](/abs/path.png)` and bare absolute paths
 * (the thumbnail strip). The web page renders them; the server copies them into the transcript's store
 * when the message arrives (server/inlineImages.ts), so both must read a message the same way.
 */

/** At most this many images per message are shown and kept. */
export const MAX_MESSAGE_IMAGES = 8;

/** The largest `data:image/…;base64,` URI shown inline (characters, ~1.5 MB of image). */
export const MAX_DATA_URI = 2_000_000;

export const DATA_IMAGE_URI = /^data:image\/(png|jpeg|gif|webp|svg\+xml);base64,[A-Za-z0-9+/=\s]+$/;

const decodeUrl = (url: string) => {
  try {
    return decodeURIComponent(url); // markdown percent-encodes the backslashes of "C:\x" and spaces
  } catch {
    return url;
  }
};

/** A file path on this host or a Mac (C:\\x, F:/x, /Users/x), not a URL. Takes the URL as markdown gives it. */
export function localPath(url: string): string | undefined {
  const u = decodeUrl(url);
  return /^[a-zA-Z]:[\\/]/.test(u) || /^\/(?!\/)/.test(u) ? u : undefined;
}

/** A video file by its name: shown in a player, not as an image. */
export const isVideoPath = (p: string) => /\.(mp4|m4v|webm)$/i.test(p);

// Absolute image and video paths in agent text: Windows (C:\x\y.png, C:/x/y.mp4) or POSIX (/Users/x/y.png).
const PATH_RE = /(?:[A-Za-z]:[\\/]|\/)(?:[^\s`'"()<>|*?,;]+[\\/])*[^\s`'"()<>|*?,;:\\/]+\.(?:png|jpe?g|gif|webp|svg|mp4|m4v|webm)\b/gi;

// ![alt](url "title") and ![alt](<url with spaces>): the url only.
const MD_IMAGE = /!\[[^\]\n]*\]\(\s*(?:<([^>\n]+)>|([^\s)]+))(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)/g;

/** Bare absolute image and video paths in `text` (markdown images are shown where they are, not as these). */
export function mentionedPaths(text: string): string[] {
  const out = new Set<string>();
  text = text.replace(MD_IMAGE, ' ');
  for (const m of text.matchAll(PATH_RE)) {
    // "/c/Users/…" (Git Bash) is C:/Users/…; a bare "/x.png" at a word boundary inside a URL is not a path.
    const p = m[0].replace(/^\/([a-zA-Z])\//, '$1:/');
    const before = text[m.index! - 1];
    if (before && /[\w.:/]/.test(before)) continue;
    out.add(p);
    if (out.size >= MAX_MESSAGE_IMAGES) break;
  }
  return [...out];
}

/** The local image files `text` shows as markdown images, as paths (a video written the same way is played, not kept). */
export function markdownImagePaths(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(MD_IMAGE)) {
    const p = localPath(m[1] ?? m[2]);
    if (p && !isVideoPath(p)) out.add(p);
    if (out.size >= MAX_MESSAGE_IMAGES) break;
  }
  return [...out];
}

/** Every image file a message shows (markdown images first, then bare paths), videos left out. */
export function messageImagePaths(text: string): string[] {
  const all = new Set([...markdownImagePaths(text), ...mentionedPaths(text).filter((p) => !isVideoPath(p))]);
  return [...all].slice(0, MAX_MESSAGE_IMAGES);
}
