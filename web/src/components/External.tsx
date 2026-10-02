// The sidebar's "External" strip: the two things outside this portal that SketchUp Factory reads, on one quiet line
// above the meters. Max (the Discord bot: token ok or not, when it last posted) and FFBox (on or off, free slots).
// Each opens its page; FFBox's opens even while it is off, to say what it needs.
import type { AppState, Provider } from '../../../shared/types';
import { fmtRelative, maxGlance, navigate, providerGlance, useNow, type Glance, type Route } from '../util';
import { Dot } from './ui';

/** FFBox in a word or two: off, no token, offline, draining, or its free slots. */
export function ffboxShort(p: Provider, now: number): { tone: Glance['tone']; text: string } {
  const g = providerGlance(p, now);
  if (!p.enabled) return { tone: 'grey', text: 'off' };
  if (!p.tokenSet) return { tone: g.tone, text: 'no token' };
  if (!p.online) return { tone: g.tone, text: 'offline' };
  const free = p.capacity?.classes.reduce((n, k) => n + k.free, 0);
  if (p.capacity && p.capacity.state !== 'running') return { tone: g.tone, text: p.capacity.state };
  return { tone: g.tone, text: free !== undefined ? `${free} free` : 'on' };
}

export function ExternalStrip({ app, route, onNavigate }: { app: AppState; route: Route; onNavigate: () => void }) {
  const now = useNow(15_000);
  const m = app.max;
  const f = app.ffbox ?? app.providers?.find((p) => p.id === 'ffbox');
  if (!m && !f) return null;
  const go = (r: Route) => {
    navigate(r);
    onNavigate();
  };
  const mg = m ? maxGlance(m, now) : undefined;
  const fs = f ? ffboxShort(f, now) : undefined;
  const maxText = mg ? (mg.label === 'OK' ? 'ok' : mg.label.toLowerCase()) : '';
  const lastPost = m?.lastPost ? fmtRelative(m.lastPost.at, now).replace(/ ago$/, '') : undefined;
  return (
    <div className="ext-foot" data-testid="external">
      <span className="ext-label">External</span>
      {m && mg && (
        <button
          className={`ext-cell${route.view === 'max' ? ' active' : ''}`}
          onClick={() => go({ view: 'max' })}
          title={`Max (Discord bot): ${mg.label}${m.health.error ? ` (${m.health.error})` : ''}${m.lastPost ? `\nlast post ${fmtRelative(m.lastPost.at, now)}${m.lastPost.channel ? ` in ${m.lastPost.channel}` : ''}` : '\nno posts recorded'}${m.lastError ? `\nlast error: ${m.lastError.message}` : ''}`}
          data-testid="external-max"
        >
          <Dot tone={mg.tone} />
          <span className="ext-name">Max</span>
          <b className={`tone-${mg.tone}`}>{maxText}</b>
          {lastPost && <span className="ext-detail">{lastPost}</span>}
        </button>
      )}
      {f && fs && (
        <button
          className={`ext-cell${route.view === 'provider' && route.providerId === 'ffbox' ? ' active' : ''}`}
          onClick={() => go({ view: 'provider', providerId: 'ffbox' })}
          title={`FFBox: ${providerGlance(f, now).label}${f.lastSeen && !f.online ? ` (seen ${fmtRelative(f.lastSeen, now)})` : ''}`}
          data-testid="external-ffbox"
        >
          <Dot tone={fs.tone} pulse={fs.tone === 'blue'} />
          <span className="ext-name">FFBox</span>
          <b className={`tone-${fs.tone}`}>{fs.text}</b>
        </button>
      )}
    </div>
  );
}
