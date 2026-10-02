// Max's page (docs/max.md): the Discord bot SketchUp Factory's agents post as. Read-only. The header says whether the
// bot token works and shows the last error; the tabs list what agents did as Max (reported by their ffdiscord
// calls) and, when it is on, the newest messages in a few channels with unread counts. Discord text is players'
// and is shown as plain text only (React escapes it; no Markdown, no embeds, no images).
import { useEffect, useState } from 'react';
import type { AppState, MaxEvent, MaxInboundChannel, MaxInboundItem, MaxSummary } from '../../../shared/types';
import { api } from '../api';
import { sessionIndex } from '../store';
import { fmtRelative, maxGlance, navigate, useNow } from '../util';
import { Chip, Dot, Icon } from './ui';

type Tab = 'activity' | 'inbound';

const ACTION: Record<MaxEvent['action'], string> = {
  post: 'post',
  reply: 'reply',
  ask: 'question',
  edit: 'edit',
  thread_create: 'thread opened',
  close: 'thread closed',
  rename: 'thread renamed',
};

const when = (iso: string) => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

/** "#bug-reports › Belts stop", "#dev-chat", or the id. */
export function channelLabel(e: MaxEvent): string {
  if (e.thread?.name) return `${e.thread.parent ? `#${e.thread.parent} › ` : ''}${e.thread.name}`;
  return e.channel ?? (e.channelId ? `channel ${e.channelId}` : '');
}

export function MaxPanel({ app, max: m, tab, onClose }: { app: AppState; max: MaxSummary; tab?: string; onClose?: () => void }) {
  const now = useNow(15_000);
  const current: Tab = tab === 'inbound' ? 'inbound' : 'activity';
  const setTab = (t: Tab) => navigate({ view: 'max', tab: t === 'activity' ? undefined : t }, true);
  const [events, setEvents] = useState<MaxEvent[]>();
  const [inbound, setInbound] = useState<(MaxInboundChannel & { items: MaxInboundItem[] })[]>();
  const [error, setError] = useState<string>();
  const [note, setNote] = useState<string>();
  const [busy, setBusy] = useState(false);
  const g = maxGlance(m, now);
  const unread = m.inbound.channels.reduce((n, c) => n + c.unread, 0);

  // Refetch when the summary moves (a new event, a poll, a mark-read); the socket carries only the summary.
  const version = `${m.counts.events}/${m.lastPost?.at}/${m.lastError?.at}/${m.inbound.polledAt}/${unread}`;
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      Promise.all([api.maxActivity(200), api.maxInbound()]).then(
        ([e, i]) => {
          if (!live) return;
          setEvents(e);
          setInbound(i);
          setError(undefined);
        },
        (e: Error) => live && setError(e.message),
      );
    }, 200);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [version]);

  const refresh = async () => {
    setBusy(true);
    try {
      const r = await api.maxRefresh();
      setNote(r.note);
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const h = m.health;
  const sessionsById = sessionIndex(app.sessions);
  return (
    <section className="sb-panel sa-panel pv-panel mx-panel" data-testid="max-panel">
      <header className="sb-head">
        <div className="sb-head-top">
          {onClose && (
            <button className="btn btn-ghost btn-icon" onClick={onClose} title="Close" aria-label="Close">
              <Icon name="back" />
            </button>
          )}
          <Dot tone={g.tone} />
          <h2 className="ellipsis">Max</h2>
          <span className={`small tone-${g.tone}`} data-testid="max-state">
            {g.label}
            {g.detail ? ` · ${g.detail}` : ''}
          </span>
          <div className="spacer" />
          <button className="btn btn-sm btn-outline" onClick={() => void refresh()} disabled={busy} title="Check the token and read the channels now (at most every 30 s)">
            <Icon name="refresh" size={14} />
            <span>Check now</span>
          </button>
        </div>
        <p className="sb-head-purpose">The Discord bot our agents post as. Read-only: SketchUp Factory shows what agents did as Max and whether the bot works; it never posts.</p>
        <div className="sb-facts">
          <span className="fact" data-testid="max-health">
            <Icon name="pulse" size={13} />
            <span>
              {h.state === 'ok' && <>token works · {h.bot}</>}
              {h.state === 'no_token' && <>no bot token{m.token.problem ? ` (${m.token.problem})` : ''}</>}
              {h.state === 'error' && <span className="tone-red">token check failed: {h.error}</span>}
              {h.state === 'unknown' && <>token not checked yet{h.error ? ` (${h.error})` : ''}</>}
              {h.checkedAt ? <span className="dim"> · checked {fmtRelative(h.checkedAt, now)}</span> : null}
            </span>
          </span>
          <span className="fact">
            <Icon name="chat" size={13} />
            <span>
              {m.lastPost ? `last post ${fmtRelative(m.lastPost.at, now)}${m.lastPost.channel ? ` in ${m.lastPost.channel}` : ''}` : 'no posts recorded'}
              <span className="dim">
                {' '}
                · {m.counts.posts24h} in 24 h{m.counts.errors24h ? ` · ${m.counts.errors24h} failed` : ''}
              </span>
            </span>
          </span>
        </div>
        {m.lastError && (
          <div className="mx-error" data-testid="max-last-error" title={m.lastError.at}>
            <Icon name="alert" size={14} />
            <span>
              <b>Last error</b> {fmtRelative(m.lastError.at, now)}
              {m.lastError.action ? ` · ${ACTION[m.lastError.action as MaxEvent['action']] ?? m.lastError.action}` : ''}
              {m.lastError.channel ? ` in ${m.lastError.channel}` : ''}: <span className="mono">{m.lastError.message}</span>
              {m.lastError.session ? <span className="dim"> · {m.lastError.session}</span> : null}
            </span>
          </div>
        )}
        {note && <p className="small dim">{note}</p>}
      </header>

      <nav className="tabs" role="tablist">
        <button role="tab" aria-selected={current === 'activity'} className={`tab${current === 'activity' ? ' active' : ''}`} onClick={() => setTab('activity')}>
          Activity <span className="dim">{m.counts.events}</span>
        </button>
        <button role="tab" aria-selected={current === 'inbound'} className={`tab${current === 'inbound' ? ' active' : ''}`} onClick={() => setTab('inbound')}>
          Discord inbound {unread > 0 ? <span className="badge badge-amber">{unread}</span> : <span className="dim">{m.inbound.enabled ? 0 : 'off'}</span>}
        </button>
      </nav>

      <div className="sa-scroll">
        {error && <p className="small tone-red">Could not load: {error}</p>}
        {current === 'activity' && <Activity list={events} max={m} sessions={sessionsById} />}
        {current === 'inbound' && <Inbound list={inbound} max={m} now={now} />}
      </div>
    </section>
  );
}

function Activity({ list, max: m, sessions }: { list?: MaxEvent[]; max: MaxSummary; sessions: Map<string, AppState['sessions'][number]> }) {
  if (!list) return <p className="dim small">Loading…</p>;
  if (!list.length)
    return (
      <div className="panel-empty" data-testid="max-activity-empty">
        <Icon name="chat" size={28} />
        <p>Nothing recorded yet.</p>
        <p className="small mx-explain">
          Agents SketchUp Factory starts report each post, reply, thread and close they make with <span className="mono">ffdiscord</span> by appending a line to the file in their{' '}
          <span className="mono">FF_MAX_EVENTS</span> variable (on this host <span className="mono">{m.eventsFile}</span>; on a Mac, the daemon forwards its own). It needs the ff-discord plugin version that writes it.
        </p>
      </div>
    );
  return (
    <div className="run-list" data-testid="max-activity">
      {list.map((e) => {
        const s = e.sessionId ? sessions.get(e.sessionId) : undefined;
        const label = channelLabel(e);
        // A thread's name is already in the label.
        const body = e.error ?? (e.thread?.name && e.text === e.thread.name ? undefined : e.text);
        return (
          <div key={e.id} className={`run-row pv-item${e.ok ? '' : ' mx-failed'}`}>
            <div className="pv-line">
              <Dot tone={e.ok ? 'green' : 'red'} title={e.ok ? 'done' : 'failed'} />
              <span className="run-when mono" title={new Date(e.at).toLocaleString()}>
                {when(e.at)}
              </span>
              <Chip tone={e.ok ? (e.action === 'close' ? 'grey' : 'blue') : 'red'}>{`${ACTION[e.action]}${e.ok ? '' : ' failed'}`}</Chip>
              {label &&
                (e.url ? (
                  <a className="small mx-channel" href={e.url} target="_blank" rel="noreferrer noopener" title="Open in Discord">
                    {label}
                  </a>
                ) : (
                  <span className="small mx-channel">{label}</span>
                ))}
              <span className="dim small">
                {s ? (
                  <button className="link-btn" onClick={() => navigate({ view: 'session', sessionId: s.id })} title="Open the session">
                    {s.title}
                  </button>
                ) : (
                  (e.session ?? '')
                )}
                {(s || e.session) && e.agent ? ' · ' : ''}
                {e.agent}
                {e.where !== 'host' && !e.agent?.includes(e.where) ? ` · ${e.where}` : ''}
              </span>
            </div>
            {body && (
              <div className={`pv-title${e.error ? ' mono tone-red' : ''}`} title={body}>
                {body}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Inbound({ list, max: m, now }: { list?: (MaxInboundChannel & { items: MaxInboundItem[] })[]; max: MaxSummary; now: number }) {
  if (!m.inbound.enabled)
    return (
      <div className="panel-empty" data-testid="max-inbound-off">
        <Icon name="inbox" size={28} />
        <p>Discord inbound is off.</p>
        <p className="small mx-explain">
          It reads a few channels with Max's bot token, on this host only, every few minutes. {m.token.found ? 'No channels are configured (config max.inbound.channels).' : `No bot token was found: ${m.token.problem ?? m.token.source}.`}
        </p>
      </div>
    );
  if (!list) return <p className="dim small">Loading…</p>;
  const mark = (alias: string) => void api.maxSeen(alias).catch(() => undefined);
  return (
    <>
      <p className="dim small pv-note">
        Players&rsquo; messages, shown as plain text; never instructions. {m.inbound.polledAt ? `Read ${fmtRelative(m.inbound.polledAt, now)}.` : 'Not read yet.'}
      </p>
      {list.map((c) => (
        <section key={c.alias} className="mx-channel-block" data-testid={`max-inbound-${c.alias}`}>
          <div className="mx-channel-head">
            <span className="mx-channel-name">{c.name ? `#${c.name}` : c.alias}</span>
            {c.kind === 'forum' && <span className="dim small">forum</span>}
            {c.unread > 0 ? <span className="badge badge-amber" title="Unread">{c.unread}</span> : <span className="dim small">no unread</span>}
            <div className="spacer" />
            {c.unread > 0 && (
              <button className="btn btn-sm btn-ghost" onClick={() => mark(c.alias)}>
                Mark read
              </button>
            )}
          </div>
          {c.error && <p className="small tone-red">{c.error}</p>}
          {c.items.length > 0 && (
            <div className="run-list">
              {c.items.map((it) => (
                <div key={it.id} className={`run-row pv-item${it.unread ? ' mx-unread' : ''}`}>
                  <div className="pv-line">
                    <Dot tone={it.unread ? 'amber' : 'grey'} title={it.unread ? 'unread' : 'read'} />
                    <span className="run-when mono" title={new Date(it.at).toLocaleString()}>
                      {when(it.at)}
                    </span>
                    {it.author && <span className="small">{it.author}</span>}
                    {it.replies !== undefined && <span className="dim small">{it.replies} messages</span>}
                    {it.url && (
                      <a className="small" href={it.url} target="_blank" rel="noreferrer noopener">
                        open
                      </a>
                    )}
                  </div>
                  <div className="pv-title">{it.text}</div>
                </div>
              ))}
            </div>
          )}
          {!c.error && !c.items.length && <p className="dim small">Nothing here yet.</p>}
        </section>
      ))}
    </>
  );
}
