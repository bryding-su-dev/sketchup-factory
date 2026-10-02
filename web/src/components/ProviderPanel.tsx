// FFBox's page (docs/ffbox-integration.md): what its connector reports, read-only. The header shows the
// connection and each container class (network, model, tier, free slots); the tabs list its conversations and
// the crash/desync reports ffintake filed, newest first. Titles are FFBox's data and can quote players: they
// are shown as plain text, never acted on.
import { useEffect, useState, type ReactNode } from 'react';
import type { IntakeGroups, Provider, ProviderClass, ProviderConversation, ProviderIntakeEvent } from '../../../shared/types';
import { api } from '../api';
import { fmtCost, fmtRelative, navigate, providerGlance, useNow, type Glance } from '../util';
import { Chip, Dot, Icon } from './ui';

type Tab = 'conversations' | 'signatures' | 'intake';

/** The connector's contract, for whoever sets it up (docs/ffbox-connector-contract.md). */
export const CONTRACT_URL = 'https://github.com/Final-Factory/ff-factory/blob/main/docs/ffbox-connector-contract.md';

const convTone = (c: ProviderConversation): Glance['tone'] =>
  c.state === 'running' || c.state === 'queued' ? 'blue' : c.state === 'blocked' ? 'amber' : c.pr?.state === 'open' ? 'green' : 'grey';

const when = (iso: string) => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

export function ProviderPanel({ provider: p, tab, onClose }: { provider: Provider; tab?: string; onClose?: () => void }) {
  const now = useNow(15_000);
  const current: Tab = tab === 'intake' ? 'intake' : tab === 'signatures' ? 'signatures' : 'conversations';
  const setTab = (t: Tab) => navigate({ view: 'provider', providerId: p.id, tab: t === 'conversations' ? undefined : t }, true);
  const [conversations, setConversations] = useState<ProviderConversation[]>();
  const [intake, setIntake] = useState<ProviderIntakeEvent[]>();
  const [groups, setGroups] = useState<IntakeGroups>();
  const [error, setError] = useState<string>();
  const g = providerGlance(p, now);

  // Refetch when the summary moves (a new report, a conversation update, a reconnect); the socket carries only the summary.
  const version = `${p.counts.conversations}/${p.counts.active}/${p.counts.intake}/${p.lastIntakeAt}/${p.lastSeen}/${p.online}`;
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      Promise.all([api.providerConversations(200), api.providerIntake(300), api.providerSignatures()]).then(
        ([c, i, sg]) => {
          if (!live) return;
          setConversations(c);
          setIntake(i);
          setGroups(sg);
          setError(undefined);
        },
        (e: Error) => live && setError(e.message),
      );
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [version]);

  const c = p.capacity;
  // Never connected and nothing reported: what it takes to switch it on, instead of empty lists.
  const setup = !p.online && !p.lastSeen && !c && !p.counts.conversations && !p.counts.intake;
  return (
    <section className="sb-panel sa-panel pv-panel" data-testid="provider-panel">
      <header className="sb-head">
        <div className="sb-head-top">
          {onClose && (
            <button className="btn btn-ghost btn-icon" onClick={onClose} title="Close" aria-label="Close">
              <Icon name="back" />
            </button>
          )}
          <Dot tone={g.tone} pulse={g.tone === 'blue'} />
          <h2 className="ellipsis">{p.name}</h2>
          <span className={`small tone-${g.tone}`} data-testid="provider-state">
            {g.label}
            {g.detail ? ` · ${g.detail}` : ''}
          </span>
          <div className="spacer" />
          {p.web && (
            <a className="btn btn-sm btn-outline" href={p.web} target="_blank" rel="noreferrer noopener" title="FFBox's own page (on its network)">
              Open FFBox
            </a>
          )}
        </div>
        <p className="sb-head-purpose">
          CPU-only containers on Lothsahn's build server, reached through the connector it runs. Read-only for now: SketchUp Factory shows what FFBox reports and cannot send it work.
        </p>
        <div className="sb-facts">
          <span className="fact">
            <Icon name="pulse" size={13} />
            <span>
              {p.online ? `connected ${fmtRelative(p.connectedSince, now)}` : p.lastSeen ? `last seen ${fmtRelative(p.lastSeen, now)}` : 'never connected'}
              {p.connector ? ` · connector ${p.connector.version}${p.connector.commit ? ` (${p.connector.commit.slice(0, 7)})` : ''}` : ''}
              {p.statusDetail && !p.online ? ` · ${p.statusDetail}` : ''}
            </span>
          </span>
          {c && (
            <span className="fact">
              <Icon name="inbox" size={13} />
              <span>
                {c.state} · queue {c.queue} · {p.counts.intake24h} report{p.counts.intake24h === 1 ? '' : 's'} in 24 h
              </span>
            </span>
          )}
        </div>
        {c && c.classes.length > 0 && (
          <div className="pv-classes" data-testid="provider-classes">
            {c.classes.map((k) => (
              <div key={k.name} className="pv-class" title={k.note ?? ''}>
                <div className="pv-class-top">
                  <span className="mono">{k.name}</span>
                  <span className="mono dim">
                    {k.free}/{k.max} free
                  </span>
                </div>
                <div className="pv-class-tags">
                  <Chip tone={k.network === 'open' ? 'amber' : 'green'}>{k.network === 'open' ? 'open internet' : 'fenced'}</Chip>
                  {!k.models?.length && <ModelTags tier={k.tier} model={k.model} />}
                  {!k.gpu && <span className="dim small">no GPU</span>}
                </div>
                {k.models?.map((m) => (
                  <div key={m.requester} className="pv-class-tags" data-testid="provider-class-model">
                    <span className="dim small">{m.requester === 'operator' ? 'operators' : 'Discord'}</span>
                    <ModelTags tier={m.tier} model={m.model} />
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
        {c && c.holds.length > 0 && <p className="small tone-amber">Waiting: {c.holds.join(' · ')}</p>}
      </header>

      {setup ? (
        <div className="sa-scroll">
          <Setup p={p} />
        </div>
      ) : (
      <>
      {!p.online && <p className="small pv-offline" data-testid="provider-offline-note">{p.enabled ? 'The connector is not connected: the lists below are what it reported last.' : 'Switched off (providers.ffbox.enabled): the lists below are what it reported last.'}</p>}
      <nav className="tabs" role="tablist">
        <button role="tab" aria-selected={current === 'conversations'} className={`tab${current === 'conversations' ? ' active' : ''}`} onClick={() => setTab('conversations')}>
          Conversations <span className="dim">{p.counts.conversations}</span>
        </button>
        <button role="tab" aria-selected={current === 'signatures'} className={`tab${current === 'signatures' ? ' active' : ''}`} onClick={() => setTab('signatures')}>
          Signatures <span className="dim">{groups?.signatures.length ?? ''}</span>
        </button>
        <button role="tab" aria-selected={current === 'intake'} className={`tab${current === 'intake' ? ' active' : ''}`} onClick={() => setTab('intake')}>
          Intake reports <span className="dim">{p.counts.intake}</span>
        </button>
      </nav>

      <div className="sa-scroll">
        {error && <p className="small tone-red">Could not load the lists: {error}</p>}
        {current === 'conversations' && <Conversations list={conversations} />}
        {current === 'signatures' && <Signatures groups={groups} now={now} />}
        {current === 'intake' && <Intake list={intake} />}
      </div>
      </>
      )}
    </section>
  );
}

/** Off and never connected: the three things it needs, each with whether it is done. */
function Setup({ p }: { p: Provider }) {
  const steps: { done: boolean; title: string; body: ReactNode }[] = [
    {
      done: p.tokenSet,
      title: 'A connector token',
      body: (
        <>
          Make one on this host with <span className="mono">node server/providerToken.ts</span> (or ask the orchestrator to set <span className="mono">providers.ffbox.token</span>) and give it to Lothsahn for the connector. Only its SHA-256 is kept here.
        </>
      ),
    },
    {
      done: p.enabled,
      title: 'The switch',
      body: (
        <>
          <span className="mono">providers.ffbox.enabled: true</span> lets the connector in (the orchestrator can set it). Off, a valid token is refused with 403.
        </>
      ),
    },
    {
      done: p.online,
      title: "FFBox's connector",
      body: (
        <>
          Lothsahn's side: a small service on FFBox that dials out to <span className="mono">/provider</span> with the token and reports capacity, conversations and intake reports. What it must send is in the{' '}
          <a href={CONTRACT_URL} target="_blank" rel="noreferrer noopener">
            connector contract
          </a>
          .
        </>
      ),
    },
  ];
  return (
    <div className="pv-setup" data-testid="provider-setup">
      <p className="pv-setup-lead">
        FFBox is not connected yet. Once it is, this page shows its container classes and free slots, the model each kind of requester gets, its conversations, and the crash and desync reports players upload, grouped the way automatic investigations will use them (at most 20 a day).
      </p>
      <ol className="pv-steps">
        {steps.map((st) => (
          <li key={st.title} className={st.done ? 'done' : ''}>
            <span className={`pv-step-mark tone-${st.done ? 'green' : 'grey'}`} aria-label={st.done ? 'done' : 'to do'}>
              <Icon name={st.done ? 'check' : 'clock'} size={14} />
            </span>
            <div>
              <div className="pv-step-title">{st.title}</div>
              <div className="small dim">{st.body}</div>
            </div>
          </li>
        ))}
      </ol>
      <p className="small dim">
        The design, and what later phases add: <span className="mono">docs/ffbox-integration.md</span>.
      </p>
    </div>
  );
}

/** Intake reports grouped by coarse signature, and the numbers automatic investigations will be capped by. */
function Signatures({ groups, now }: { groups?: IntakeGroups; now: number }) {
  if (!groups) return <p className="dim small">Loading…</p>;
  const b = groups.budget;
  return (
    <>
      <div className="pv-budget" data-testid="provider-budget">
        <div className="pv-budget-top">
          <span className="pv-budget-title">Automatic investigations</span>
          <Chip tone="grey">not live yet</Chip>
        </div>
        <div className="pv-meter" aria-label={`${b.wouldStartToday} of ${b.perDay} a day`}>
          <i style={{ width: `${Math.min(100, (b.wouldStartToday / b.perDay) * 100)}%` }} />
        </div>
        <div className="pv-budget-cells small">
          <span>
            would start today <b className="mono">{b.wouldStartToday}</b> of {b.perDay}
          </span>
          <span>
            new signatures 24 h <b className="mono">{b.newToday}</b>
          </span>
          <span>
            past the trust bar <b className="mono">{b.trustedToday}</b>
          </span>
          <span className={b.stormBreaker.tripped ? 'tone-red' : ''}>
            last hour <b className="mono">{b.newLastHour}</b> new{b.stormBreaker.tripped ? ' · storm breaker tripped' : ` (breaker above ${b.stormBreaker.threshold})`}
          </span>
        </div>
        <p className="small dim">
          One investigation per signature once it has 2+ senders or a host and client pair; at most {b.perHour} an hour and {b.perDay} a day. Phase 4 builds them; these are the numbers it will use.
        </p>
      </div>
      {!groups.signatures.length ? (
        <Empty text="No crash or desync reports yet." />
      ) : (
        <div className="run-list" data-testid="provider-signatures">
          {groups.signatures.map((g) => (
            <div key={g.signature} className="run-row pv-item" title={g.reportIds.join('\n')}>
              <div className="pv-line">
                <Dot tone={g.kind === 'desync' ? 'amber' : 'red'} title={g.kind} />
                <span className="small">{g.kind}</span>
                <span className="mono small">{g.versionLine}</span>
                {g.trusted ? <Chip tone="green">trusted</Chip> : <Chip tone="grey">{g.kind === 'crash' ? 'no signature yet' : 'waiting for a 2nd sender'}</Chip>}
                <span className="dim small">last {fmtRelative(g.lastAt, now)}</span>
              </div>
              <div className="pv-title mono">{g.surfaces ?? 'crash (signatures come in phase 6)'}</div>
              <div className="pv-sig-counts small dim">
                {g.reports} report{g.reports === 1 ? '' : 's'} · {g.events} event{g.events === 1 ? '' : 's'} · {g.senders} sender{g.senders === 1 ? '' : 's'}
                {g.pair ? ' · host+client pair' : ''} · {g.platforms.join(', ')}
                {g.versions.length > 1 ? ` · ${g.versions.length} builds` : ` · ${g.versions[0]}`}
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div className="panel-empty">
      <Icon name="inbox" size={28} />
      <p>{text}</p>
    </div>
  );
}

function Conversations({ list }: { list?: ProviderConversation[] }) {
  if (!list) return <p className="dim small">Loading…</p>;
  if (!list.length) return <Empty text="No conversations reported yet." />;
  return (
    <>
      <p className="dim small pv-note">Titles are FFBox's data and can quote what players wrote.</p>
      <div className="run-list" data-testid="provider-conversations">
        {list.map((c) => (
          <div key={c.id} className="run-row pv-item">
            <div className="pv-line">
              <Dot tone={convTone(c)} pulse={c.state === 'running'} title={c.state} />
              <span className="run-when mono" title={new Date(c.updatedAt).toLocaleString()}>
                {when(c.updatedAt)}
              </span>
              <span className="dim small">
                {c.source}
                {c.opener === 'player' ? ' · player' : ''} · <span className="mono">{c.agentClass}</span> · {c.state}
                {c.costUsd !== undefined ? ` · ${fmtCost(c.costUsd)}` : ''}
              </span>
              {c.verdict && <Chip tone={c.verdict === 'NEEDS-INFO' ? 'amber' : c.verdict === 'ESCALATE' ? 'red' : 'grey'}>{c.verdict}</Chip>}
              {c.pr && <Chip tone={c.pr.state === 'merged' ? 'green' : c.pr.state === 'open' ? 'blue' : 'grey'}>{`PR #${c.pr.number} ${c.pr.state}`}</Chip>}
            </div>
            <div className="pv-title" title={c.title}>
              {c.url ? (
                <a href={c.url} target="_blank" rel="noreferrer noopener">
                  {c.title}
                </a>
              ) : (
                c.title
              )}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function Intake({ list }: { list?: ProviderIntakeEvent[] }) {
  if (!list) return <p className="dim small">Loading…</p>;
  if (!list.length) return <Empty text="No crash or desync reports yet." />;
  return (
    <div className="run-list" data-testid="provider-intake">
      {list.map((e) => (
        <div key={e.reportId} className="run-row pv-item" title={e.reportId}>
          <div className="pv-line">
            <Dot tone={e.kind === 'desync' ? 'amber' : 'red'} title={e.kind} />
            <span className="run-when mono" title={new Date(e.receivedAt).toLocaleString()}>
              {when(e.receivedAt)}
            </span>
            <span className="small">{e.kind}</span>
            <span className="dim small mono">{e.desync?.group ? `group ${e.desync.group.slice(0, 8)}` : e.desync?.why ?? ''}</span>
          </div>
          <div className="pv-title mono">
            {e.gameVersion} · {e.platform}
            {e.desync?.divergedSurfaces ? ` · ${e.desync.divergedSurfaces}` : ''}
            {e.desync?.role ? ` · from ${e.desync.role}` : ''}
            {e.desync?.verdictHeartbeat !== undefined ? ` · hb ${e.desync.verdictHeartbeat}` : ''}
          </div>
        </div>
      ))}
    </div>
  );
}

/** A class's model and tier, exactly as the connector reported them. */
function ModelTags({ tier, model }: { tier: ProviderClass['tier']; model: string }) {
  return (
    <>
      <Chip tone={tier === 'simple' ? 'amber' : 'blue'} title={tier === 'simple' ? 'Small, well-scoped work only' : 'Any well-briefed task'}>
        {tier === 'simple' ? 'simple work' : 'full'}
      </Chip>
      <span className="dim small mono">{model}</span>
    </>
  );
}
