import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Tone } from '../util';
import { copyText } from '../util';

export function Dot({ tone, pulse, title }: { tone: Tone; pulse?: boolean; title?: string }) {
  return <span className={`dot dot-${tone}${pulse ? ' dot-pulse' : ''}`} title={title} aria-label={title} />;
}

export function Chip({ tone, children, title }: { tone: Tone; children: ReactNode; title?: string }) {
  return (
    <span className={`chip chip-${tone}`} title={title}>
      <Dot tone={tone} pulse={tone === 'blue'} />
      {children}
    </span>
  );
}

export type IconName =
  | 'menu' | 'plus' | 'send' | 'stop' | 'trash' | 'copy' | 'check' | 'x' | 'chevron' | 'back'
  | 'expand' | 'play' | 'power' | 'log' | 'refresh' | 'bell' | 'chat' | 'branch' | 'folder' | 'bot' | 'logout'
  | 'clock' | 'pause' | 'edit' | 'wallet' | 'image' | 'download' | 'paperclip' | 'bellOff' | 'search' | 'mic' | 'wave' | 'more'
  | 'pulse' | 'alert' | 'inbox' | 'info' | 'tools' | 'arrowDown' | 'bulb' | 'settings' | 'monitor' | 'file' | 'camera' | 'reply' | 'smile';

const PATHS: Record<IconName, ReactNode> = {
  pulse: <path d="M3 12h4l2.5-6 4 12 2.5-6H21" />,
  reply: <path d="M10 7L4.5 12 10 17M5 12h9a5.5 5.5 0 0 1 5.5 5.5V19" />,
  smile: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M8.7 14.2c.8 1.1 2 1.8 3.3 1.8s2.5-.7 3.3-1.8M9.3 9.8h.01M14.7 9.8h.01" />
    </>
  ),
  alert: (
    <>
      <path d="M12 4.5l8.5 15h-17z" />
      <path d="M12 10v4.5M12 17.2h.01" />
    </>
  ),
  inbox: (
    <>
      <path d="M4 13l2.5-7h11L20 13v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z" />
      <path d="M4 13h4.5l1 2h5l1-2H20" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 11v5M12 8h.01" />
    </>
  ),
  tools: <path d="M14.7 6.3a4 4 0 0 0-5.4 5.1L4.5 16.2a1.8 1.8 0 0 0 2.5 2.5l4.8-4.8a4 4 0 0 0 5.1-5.4l-2.4 2.4-2.1-.4-.4-2.1z" />,
  arrowDown: <path d="M12 5v14M6.5 13.5L12 19l5.5-5.5" />,
  bulb: <path d="M9.5 18h5M10.5 21h3M12 3.5a5.5 5.5 0 0 0-3.3 9.9c.6.5.9 1.1.9 1.9V16h4.8v-.7c0-.8.3-1.4.9-1.9A5.5 5.5 0 0 0 12 3.5z" />,
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3.5v2.2M12 18.3v2.2M20.5 12h-2.2M5.7 12H3.5M18 6l-1.6 1.6M7.6 16.4L6 18M18 18l-1.6-1.6M7.6 7.6L6 6" />
    </>
  ),
  monitor: (
    <>
      <rect x="3.5" y="5" width="17" height="11" rx="1.5" />
      <path d="M9 20h6M12 16v4" />
    </>
  ),
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 8v4.5l3 2" />
    </>
  ),
  pause: <path d="M9 6v12M15 6v12" />,
  more: (
    <>
      <circle cx="5.5" cy="12" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="18.5" cy="12" r="1.6" fill="currentColor" stroke="none" />
    </>
  ),
  wave: <path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2" />,
  mic: (
    <>
      <rect x="9" y="3.5" width="6" height="11" rx="3" />
      <path d="M6 11.5a6 6 0 0 0 12 0M12 17.5V21M9 21h6" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6" />
      <path d="M20 20l-4.5-4.5" />
    </>
  ),
  image: (
    <>
      <rect x="4" y="5" width="16" height="14" rx="2" />
      <circle cx="9" cy="10" r="1.6" />
      <path d="M5 17l5-5 4 4 2-2 3 3" />
    </>
  ),
  download: <path d="M12 4v11M7 10l5 5 5-5M5 19h14" />,
  camera: (
    <>
      <path d="M4 8h3l2-2.5h6L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z" />
      <circle cx="12" cy="13" r="3.5" />
    </>
  ),
  paperclip: <path d="M8 12.5l5.5-5.5a3 3 0 0 1 4.2 4.2l-7 7a5 5 0 0 1-7-7L10 5" />,
  file: (
    <>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
    </>
  ),
  edit: <path d="M5 19h4L19 9l-4-4L5 15zM13.5 6.5l4 4" />,
  wallet: <path d="M5 7h13a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1zM4 10h15M15.5 14h.01" />,
  logout: <path d="M14 5h4a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1h-4M10 8l-4 4 4 4M6 12h10" />,
  plus: <path d="M12 5v14M5 12h14" />,
  send: <path d="M5 12h13M13 6l6 6-6 6" />,
  stop: <rect x="7" y="7" width="10" height="10" rx="1.5" />,
  trash: <path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12" />,
  copy: (
    <>
      <rect x="9" y="9" width="10" height="10" rx="2" />
      <path d="M15 9V6a1 1 0 0 0-1-1H6a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h3" />
    </>
  ),
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  x: <path d="M6 6l12 12M18 6L6 18" />,
  chevron: <path d="M9 6l6 6-6 6" />,
  back: <path d="M15 6l-6 6 6 6" />,
  expand: <path d="M14 5h5v5M10 19H5v-5M19 5l-6 6M5 19l6-6" />,
  play: <path d="M8 5.5v13l11-6.5z" />,
  power: <path d="M12 4v8M7.5 7a7 7 0 1 0 9 0" />,
  log: <path d="M5 6h14M5 10h14M5 14h9M5 18h6" />,
  refresh: <path d="M19 8a7.5 7.5 0 1 0 .5 6M19 4v4h-4" />,
  bell: <path d="M7 16V11a5 5 0 0 1 10 0v5l1.5 2h-13zM10 20h4" />,
  bellOff: <path d="M7 16V11a5 5 0 0 1 8-4M17 11v5l1.5 2h-13M10 20h4M4 4l16 16" />,
  chat: <path d="M5 6h14v10H10l-4 3v-3H5z" />,
  branch: (
    <>
      <circle cx="7" cy="6" r="2" />
      <circle cx="7" cy="18" r="2" />
      <circle cx="17" cy="8" r="2" />
      <path d="M7 8v8M17 10c0 4-10 2-10 6" />
    </>
  ),
  folder: <path d="M4 7a1 1 0 0 1 1-1h4l2 2h8a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z" />,
  bot: (
    <>
      <rect x="5" y="8" width="14" height="10" rx="3" />
      <path d="M12 8V5M9.5 13h.01M14.5 13h.01" />
    </>
  ),
};

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {PATHS[name]}
    </svg>
  );
}

/** Copy some text; `getText` reads it at click time (a code block's rendered text). */
export function CopyButton({ text, getText, label, className = '' }: { text?: string; getText?: () => string; label?: string; className?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className={`btn btn-ghost btn-icon btn-xs ${className}`}
      title={done ? 'Copied' : (label ?? 'Copy')}
      aria-label={label ?? 'Copy'}
      onClick={async (e) => {
        e.stopPropagation();
        if (await copyText(getText ? getText() : (text ?? ''))) {
          setDone(true);
          setTimeout(() => setDone(false), 1400);
        }
      }}
    >
      <Icon name={done ? 'check' : 'copy'} size={14} />
    </button>
  );
}

/** A button that opens a small menu under it; it closes on a pick, a click outside or Escape. */
export function Menu({ label, icon = 'more', className = '', children }: { label: string; icon?: IconName; className?: string; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div className={`menu ${className}`} ref={ref}>
      <button type="button" className={`btn btn-ghost btn-icon menu-btn${open ? ' active' : ''}`} title={label} aria-label={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name={icon} />
      </button>
      {open && (
        <div className="menu-pop" role="menu">
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

/** A state in words with its dot: "● Working". */
export function StateText({ tone, label, pulse, className = '' }: { tone: Tone; label: ReactNode; pulse?: boolean; className?: string }) {
  return (
    <span className={`state tone-${tone} ${className}`}>
      <Dot tone={tone} pulse={pulse} />
      {label}
    </span>
  );
}

export function Modal({
  title,
  onClose,
  children,
  footer,
  wide,
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Callers pass a fresh onClose on every render (each server state push): read it through a ref, so
  // the first field is focused once when the modal opens, not again under the user's caret.
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close.current();
    window.addEventListener('keydown', onKey);
    const first = ref.current?.querySelector<HTMLElement>('input, textarea, select, button.btn-primary');
    first?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal${wide ? ' modal-wide' : ''}`} ref={ref} role="dialog" aria-modal>
        <header className="modal-head">
          <h2>{title}</h2>
          <button className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Close">
            <Icon name="x" />
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>
  );
}

export function Confirm({
  title,
  body,
  confirmLabel,
  danger,
  onConfirm,
  onClose,
}: {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => Promise<unknown> | void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`}
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm();
              } finally {
                setBusy(false);
                onClose();
              }
            }}
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      <div className="confirm-body">{body}</div>
    </Modal>
  );
}
