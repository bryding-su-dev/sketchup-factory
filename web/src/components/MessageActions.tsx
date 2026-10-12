import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type MouseEvent } from 'react';
import { REACTION_PALETTE } from '../../../shared/replies';
import { parseNotice } from '../../../shared/notices';
import { api } from '../api';
import { attempt, startReply } from '../store';
import { Icon } from './ui';

/**
 * Replying and reacting in a person's own orchestrator chat (w866, docs/orchestrators.md "Replies and reactions"):
 * what Transcript gives each message when the chat is the viewer's own. Absent on every other chat, and `interactive`
 * is false on someone else's chat, where the reactions still show but nothing can be pressed.
 */
export interface ChatActions {
  sessionId: string;
  /** The viewer's user id and name, to call their messages "You". */
  me?: { userId: string; displayName: string };
  interactive: boolean;
  /** Reactions on each message, by transcript seq. */
  reactions: Map<number, string[]>;
}

export const ChatActionsContext = createContext<ChatActions | undefined>(undefined);

const CLIP = 160;

/** One line of a message for the "Replying to" bar and a quote: plain, short. */
export function glance(text: string): string {
  const flat = text
    .replace(/```[\s\S]*?```/g, ' code ')
    .replace(/[*_`#>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > CLIP ? `${flat.slice(0, CLIP - 1).trimEnd()}…` : flat;
}

/** "a [worker update] line" (the server's wording) as the page says it: "Worker update". */
const NOTICE_FROM = /^a \[(.+)\] line$/;

/** A quoted message's author and words as a person reads them. */
export function quoteLabel(from: string, excerpt: string, meName?: string): { from: string; text: string } {
  const notice = NOTICE_FROM.exec(from)?.[1];
  if (notice) return { from: notice[0].toUpperCase() + notice.slice(1), text: glance(parseNotice(excerpt).summary || excerpt) };
  if (from === 'the orchestrator') return { from: 'Orchestrator', text: glance(excerpt) };
  return { from: meName && from === meName ? 'You' : from, text: glance(excerpt) };
}

/**
 * Whether the screen has no hover (a touch screen). One listener for every message of a long chat, not one each.
 */
const touchQuery = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(hover: none)') : undefined;
const touchListeners = new Set<() => void>();
touchQuery?.addEventListener('change', () => touchListeners.forEach((l) => l()));
const onTouchChange = (l: () => void) => {
  touchListeners.add(l);
  return () => void touchListeners.delete(l);
};
const isTouch = () => !!touchQuery?.matches;

/**
 * A message that can show its actions on a touch screen: tap it to open them, tap elsewhere to close. A pointer shows
 * them on hover (CSS), so this does nothing there.
 */
export function useActionsHost(enabled: boolean): { open: boolean; close: () => void; /** A touch screen: show or hide the actions (for a message whose own tap is a button). */ toggle?: () => void; onClick?: (e: MouseEvent) => void; ref: React.RefObject<HTMLDivElement | null> } {
  const touch = useSyncExternalStore(onTouchChange, isTouch);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', away, true);
    return () => document.removeEventListener('pointerdown', away, true);
  }, [open]);
  const close = () => setOpen(false);
  if (!enabled || !touch) return { open: false, close, ref };
  return {
    open,
    close,
    toggle: () => setOpen((o) => !o),
    ref,
    onClick: (e) => {
      // A link or a button inside the message is its own tap.
      if ((e.target as HTMLElement).closest('a, button, input, [role="toolbar"]')) return;
      setOpen((o) => !o);
    },
  };
}

/** The reactions on a message, under it; yours can be taken back with a tap. */
export function Reactions({ seq }: { seq: number }) {
  const ctx = useContext(ChatActionsContext);
  const list = ctx?.reactions.get(seq);
  if (!ctx || !list?.length) return null;
  return (
    <div className="msg-reactions" data-testid="msg-reactions">
      {list.map((emoji) =>
        ctx.interactive ? (
          <button key={emoji} type="button" className="react-chip" title="Your reaction. Tap to take it back" aria-label={`Take back your ${emoji} reaction`} onClick={() => void attempt(api.react(ctx.sessionId, seq, emoji, false))}>
            {emoji}
          </button>
        ) : (
          <span key={emoji} className="react-chip" aria-label={`Reacted ${emoji}`}>
            {emoji}
          </span>
        ),
      )}
    </div>
  );
}

/** Reply and React, floating at a message's corner: on hover for a pointer, once tapped for a touch screen. */
export function MessageActions({ seq, from, excerpt, onDone }: { seq: number; from: string; excerpt: string; onDone?: () => void }) {
  const ctx = useContext(ChatActionsContext);
  const [picking, setPicking] = useState(false);
  const bar = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!picking) return;
    const away = (e: PointerEvent) => {
      if (!bar.current?.contains(e.target as Node)) setPicking(false);
    };
    document.addEventListener('pointerdown', away, true);
    return () => document.removeEventListener('pointerdown', away, true);
  }, [picking]);
  if (!ctx?.interactive) return null;
  const mine = ctx.reactions.get(seq) ?? [];
  const react = (emoji: string) => {
    setPicking(false);
    onDone?.();
    void attempt(api.react(ctx.sessionId, seq, emoji, !mine.includes(emoji)));
  };
  return (
    <div className="msg-actions" role="toolbar" aria-label="Message actions" ref={bar} data-picking={picking || undefined}>
      {picking ? (
        REACTION_PALETTE.map((emoji) => (
          <button key={emoji} type="button" className={`msg-action react-pick${mine.includes(emoji) ? ' on' : ''}`} aria-label={`React ${emoji}`} aria-pressed={mine.includes(emoji)} onClick={() => react(emoji)}>
            {emoji}
          </button>
        ))
      ) : (
        <>
          <button type="button" className="msg-action" title="React with an emoji" aria-label="React" onClick={() => setPicking(true)}>
            <Icon name="smile" size={16} />
          </button>
          <button type="button" className="msg-action" title="Reply to this message" aria-label="Reply" onClick={() => {
              onDone?.();
              startReply(ctx.sessionId, { seq, from, excerpt });
            }}>
            <Icon name="reply" size={16} />
          </button>
        </>
      )}
    </div>
  );
}
