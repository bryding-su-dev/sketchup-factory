import { useCallback } from 'react';

const kept = new Map<string, number>();
/** How long a list that fills in late (rows fetched, a table drawn) is held at the remembered place, until the reader scrolls. */
const HOLD_MS = 1500;

/**
 * Keep a list's scroll position while it is not on screen (w1100). The panes of this page are drawn only while open, so
 * a list scrolled down (the dispatcher's requests, the Overview board) was back at the top on the way back from another
 * page or tab. Put the returned ref on the scrolling element; `key` names the list and what it shows (the agent, its
 * tab). The chats keep theirs by message, in web/src/components/Transcript.tsx.
 */
export function useKeepScroll(key: string) {
  return useCallback(
    (el: HTMLElement | null) => {
      if (!el) return;
      const saved = kept.get(key);
      let held = !!saved;
      const apply = () => {
        if (held && saved && Math.abs(el.scrollTop - saved) > 1) el.scrollTop = saved;
      };
      apply();
      const until = performance.now() + HOLD_MS;
      // Rows that arrive after the first draw give the list its length: put it back as they do.
      const mo = new MutationObserver(() => (performance.now() < until ? apply() : (held = false)));
      mo.observe(el, { childList: true, subtree: true });
      const release = () => (held = false);
      const onScroll = () => kept.set(key, el.scrollTop);
      el.addEventListener('scroll', onScroll, { passive: true });
      for (const t of ['wheel', 'touchstart', 'pointerdown', 'keydown']) el.addEventListener(t, release, { passive: true });
      return () => {
        mo.disconnect();
        el.removeEventListener('scroll', onScroll);
        for (const t of ['wheel', 'touchstart', 'pointerdown', 'keydown']) el.removeEventListener(t, release);
      };
    },
    [key],
  );
}
