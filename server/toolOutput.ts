// Smaller defaults for the coordinators' read tools (w1159). Tool results are 18-22% of what the dispatcher and the
// orchestrators spend, and a result stays in the context for the rest of the conversation, so a view returns what is
// read most and says how to ask for the rest.

/** list_work with id: how many of a request's newest log entries it prints unless full_log is set. */
export const LIST_WORK_LOG_TAIL = 15;

/** spend_report session: how many of the requests the session served it lists (by cost) unless `requests` asks for more. */
export const SESSION_REQUESTS_TOP = 20;

/** list_sandboxes: a status detail longer than this is cut unless detail is set. */
export const SANDBOX_DETAIL_CHARS = 100;

/** A request's log for list_work: the newest `tail` entries (oldest first, as logged) after a count of the earlier ones. */
export function logLines(log: readonly string[], full: boolean, tail: number = LIST_WORK_LOG_TAIL): string[] {
  if (full || log.length <= tail) return ['Log:', ...log.map((l) => `  ${l}`)];
  const hidden = log.length - tail;
  return [`Log (the last ${tail} of ${log.length} entries; ${hidden} earlier left out, list_work with full_log: true prints them):`, ...log.slice(-tail).map((l) => `  ${l}`)];
}

/** `text` cut to `max` characters with an ellipsis; the whole text when it fits. */
export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** ffbox_activity config: the dotted paths of `key`, one string (split at commas and spaces) or a list. */
export function keyList(key: string | string[] | undefined): string[] {
  const parts = Array.isArray(key) ? key : key === undefined ? [] : [key];
  return parts.flatMap((k) => k.split(/[\s,]+/)).filter(Boolean);
}

/** ffbox_activity conversation: turns in a page unless limit says more (was 5; offset pages on). */
export const FFBOX_CONVERSATION_DEFAULT_TURNS = 3;

/** ffbox_activity reports: reports in a page unless limit says more (was 50; "more: offset N" pages on). */
export const FFBOX_REPORTS_DEFAULT = 20;
