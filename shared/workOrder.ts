// The order of the Dispatcher page's requests (web/src/components/DispatcherPanel.tsx). Here, so the tests can reach it.
import type { WorkItem } from './types.ts';

/** The status groups, top to bottom: questions, new, queued, active, then every closed one together. */
export const STATUS_RANK: Record<WorkItem['status'], number> = { question: 0, new: 1, queued: 2, active: 3, done: 4, merged: 4, rejected: 4, cancelled: 4 };
const PRIORITY: Record<WorkItem['priority'], number> = { urgent: 0, high: 1, normal: 2, low: 3 };

/** Whether `viewerId` (a login) is one of the item's people. */
export function isMine(w: Pick<WorkItem, 'requesters'>, viewerId: string | undefined): boolean {
  const me = viewerId?.toLowerCase();
  return !!me && w.requesters.some((r) => r.userId.toLowerCase() === me);
}

/**
 * The ledger as `viewerId` sees it: by status group, then (open ones) by priority; within one status and priority the
 * viewer's own requests first (w307, asked by Lothsahn), then everyone else's; within each part open ones oldest first,
 * closed ones newest first. Closed ones were never ordered by priority, and are not now.
 */
export function ledgerOrder(work: readonly WorkItem[], viewerId: string | undefined): WorkItem[] {
  const mine = new Map(work.map((w) => [w, isMine(w, viewerId)]));
  return [...work].sort((a, b) => {
    const rank = STATUS_RANK[a.status] - STATUS_RANK[b.status];
    if (rank) return rank;
    const open = STATUS_RANK[a.status] < STATUS_RANK.done;
    if (open && a.priority !== b.priority) return PRIORITY[a.priority] - PRIORITY[b.priority];
    if (mine.get(a) !== mine.get(b)) return mine.get(a) ? -1 : 1;
    return open ? a.createdAt.localeCompare(b.createdAt) : b.updatedAt.localeCompare(a.updatedAt);
  });
}
