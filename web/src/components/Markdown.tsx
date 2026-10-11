import { createContext, lazy, memo, Suspense, useContext, useMemo, useRef, useState, type ComponentProps } from 'react';
import ReactMarkdown, { defaultUrlTransform, type Components, type ExtraProps } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { DATA_IMAGE_URI, isVideoPath, localPath, MAX_DATA_URI } from '../../../shared/imagePaths';
import { sanitizeSvg } from '../../../shared/svg';
import { openLightbox } from '../store';
import { baseName, posterSrc } from './Images';
import { CopyButton, Icon } from './ui';

const Mermaid = lazy(() => import('./Mermaid'));

/**
 * The URL that shows a local image path in a message (through the authenticated /api/image, or the copy kept with
 * the transcript). Without one, local images are left out: nothing says whose folders they are in.
 */
export const LocalImages = createContext<((path: string) => string) | null>(null);

type HastNode = { type: string; value?: string; children?: HastNode[] };
const textOf = (n: HastNode | undefined): string => (n ? (n.value ?? '') + (n.children ?? []).map(textOf).join('') : '');

/** A fenced code block under a slim bar with its language and a Copy button; a mermaid block is drawn. */
function CodeBlock({ node, ...props }: ComponentProps<'pre'> & ExtraProps) {
  const ref = useRef<HTMLPreElement>(null);
  const code = node?.children?.[0];
  const cls = code && 'properties' in code ? String(code.properties?.className ?? '') : '';
  const lang = /language-([\w#+.-]+)/.exec(cls)?.[1];
  if (lang === 'mermaid') {
    const source = textOf(code as HastNode).replace(/\n$/, '');
    return (
      <Suspense fallback={<div className="md-code md-mermaid-loading dim small">Drawing diagram…</div>}>
        <Mermaid source={source} />
      </Suspense>
    );
  }
  return (
    <div className="md-code">
      <div className="md-code-bar">
        <span className="md-code-lang">{lang ?? 'code'}</span>
        <CopyButton getText={() => ref.current?.innerText.replace(/\n$/, '') ?? ''} label="Copy code" />
      </div>
      <pre ref={ref} {...props} />
    </div>
  );
}

/** A `data:image/…;base64` URI safe to show, or undefined: an SVG one is rebuilt by the sanitiser (shared/svg.ts). */
export function safeDataImage(uri: string): string | undefined {
  if (uri.length > MAX_DATA_URI || !DATA_IMAGE_URI.test(uri)) return undefined;
  if (!uri.startsWith('data:image/svg+xml')) return uri;
  try {
    const bytes = Uint8Array.from(atob(uri.slice(uri.indexOf(',') + 1).replace(/\s/g, '')), (c) => c.charCodeAt(0));
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(sanitizeSvg(new TextDecoder().decode(bytes)))}`;
  } catch {
    return undefined;
  }
}

/** An image in the text, at its own size up to the column's width; a click opens it full size. */
function InlineImage({ src, name, alt }: { src: string; name: string; alt?: string }) {
  const [broken, setBroken] = useState(false);
  if (broken) return <code title="This image is not available">{alt || name}</code>;
  return (
    <button type="button" className="md-img" title={alt || name} onClick={() => openLightbox([{ src, name }], 0)}>
      <img src={src} alt={alt || name} loading="lazy" onError={() => setBroken(true)} />
    </button>
  );
}

/**
 * A video written as a markdown image, `![clip](</srv/fff/review/w1/clip.mp4>)`: an inline player that loads only
 * its metadata until played (seeking uses HTTP ranges). Spans, not a figure: the text sits in a paragraph.
 */
function InlineVideo({ src, name, alt }: { src: string; name: string; alt?: string }) {
  const [broken, setBroken] = useState(false);
  if (broken) return <code title="This video is not available">{alt || name}</code>;
  return (
    <span className="md-video">
      <video src={posterSrc(src)} controls playsInline muted preload="metadata" onError={() => setBroken(true)} />
      <span className="md-video-cap dim small">
        <span className="ellipsis mono">{alt || name}</span>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => openLightbox([{ src, name, video: true }], 0)} title="Open large">
          <Icon name="expand" size={12} />
        </button>
      </span>
    </span>
  );
}

function MdImage({ src, alt }: ComponentProps<'img'> & ExtraProps) {
  const resolve = useContext(LocalImages);
  const url = typeof src === 'string' ? src : '';
  const shown = useMemo(() => {
    const path = localPath(url);
    if (path) return resolve ? { src: resolve(path), name: baseName(path), video: isVideoPath(path) } : undefined;
    if (url.startsWith('data:')) {
      const safe = safeDataImage(url);
      return safe ? { src: safe, name: alt || 'image' } : { refused: true };
    }
    return url ? { src: url, name: alt || baseName(url) } : undefined;
  }, [url, resolve, alt]);
  if (!shown) return null;
  if ('refused' in shown) return <code title="Only PNG, JPEG, GIF, WebP and SVG images under 1.5 MB are shown">{alt || 'image'} (not shown)</code>;
  if ('video' in shown && shown.video) return <InlineVideo src={shown.src} name={shown.name} alt={alt} />;
  return <InlineImage src={shown.src} name={shown.name} alt={alt} />;
}

/**
 * Keep local paths as they are (the default would blank "F:\\…" as an unknown "f:" scheme), and image data URIs
 * as a src (MdImage checks them); everything else goes through react-markdown's safe-protocol filter.
 */
const urlTransform = (url: string, key: string) => (localPath(url) || (key === 'src' && url.startsWith('data:image/')) ? url : defaultUrlTransform(url));

const components: Components = {
  a: ({ node: _node, ...props }) => (props.href && localPath(props.href) ? <code>{props.children}</code> : <a {...props} target="_blank" rel="noreferrer noopener" />),
  img: ({ node: _node, ...props }) => <MdImage {...props} />,
  table: ({ node: _node, ...props }) => (
    <div className="md-table-wrap">
      <table {...props} />
    </div>
  ),
  pre: CodeBlock,
};

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} urlTransform={urlTransform}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
