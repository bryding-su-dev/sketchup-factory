// A page open across a deploy keeps running the old UI against the new server. The server names the web
// UI build it serves (server/webStatic.ts); the page compares it with the build it loaded and reloads
// (web/src/freshness.ts). The rules are here, so the tests can reach them.

/** The <meta name=…> in index.html that carries the build the page was served. */
export const BUILD_META = 'ff-build';

/** What a page that loaded `loaded` does when the server says it serves `served`. */
export type FreshnessAction = 'none' | 'reload' | 'banner';

export function freshnessAction(o: {
  /** The build the page loaded; undefined for a dev server's page, which never reloads. */
  loaded: string | undefined;
  /** The build the server serves now; undefined from a server older than this, or while the UI is not built. */
  served: string | undefined;
  /** The build the page last reloaded to get: reloaded once and still not it, it does not loop. */
  triedFor: string | null;
  /** Something a reload would lose: a picture or file attached but not sent, an open form, a box being typed in. */
  busy: boolean;
}): FreshnessAction {
  if (!o.loaded || !o.served || o.loaded === o.served) return 'none';
  if (o.triedFor === o.served) return 'banner';
  return o.busy ? 'banner' : 'reload';
}
