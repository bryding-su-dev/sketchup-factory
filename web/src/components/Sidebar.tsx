import { useState, type ReactNode } from 'react';
import type { AppState, SessionInfo } from '../../../shared/types';
import type { FleetComputer } from '../../../shared/fleet';
import { sessionIndex } from '../store';
import { useAttention, type AttentionItem } from '../attention';
import {
  chatOwner,
  dispatcherGlance,
  fmtCost,
  isBusy,
  isOpenWork,
  navigate,
  providerGlance,
  sessionLabel,
  sessionTone,
  standingGlance,
  useNow,
  versionLabel,
  type Glance,
  type Route,
} from '../util';
import { Dot, Icon, type IconName } from './ui';
import { usePush } from '../notify';
import { SettingsModal } from './Settings';
import { SystemFooter } from './SystemMeters';
import { ExternalStrip } from './External';
import { FleetGroups, fleetFor, type FleetSelection } from './Fleet';

export function Sidebar({
  app,
  route,
  onNewSandbox,
  onNewStanding,
  onNewMachine,
  onNavigate,
}: {
  app: AppState;
  route: Route;
  onNewSandbox: () => void;
  onNewStanding: () => void;
  onNewMachine: () => void;
  onNavigate: () => void;
}) {
  const push = usePush();
  const now = useNow(15_000);
  const [settings, setSettings] = useState(false);
  const attention = useAttention(app);
  const sessionsById = sessionIndex(app.sessions);
  const orch = sessionsById.get(app.orchestratorId);
  // The other people's own orchestrators (read only here), and the dispatcher with its open requests (docs/orchestrators.md).
  const others = app.sessions.filter((s) => s.id !== app.orchestratorId && chatOwner(s)).sort((a, b) => a.title.localeCompare(b.title));
  const dispatcher = app.dispatcherId ? sessionsById.get(app.dispatcherId) : undefined;
  const ledger = dispatcherGlance(dispatcher, (app.work ?? []).filter(isOpenWork), app.me?.userId);
  const selection = selectionOf(route, sessionsById);
  const fleet = fleetFor(app);

  const go = (r: Route) => {
    navigate(r);
    onNavigate();
  };

  return (
    <aside className="sidebar">
      <div className="side-head">
        <div className="brand-mark" aria-hidden>
          <svg viewBox="0 0 32 32" width="24" height="24">
            <rect width="32" height="32" rx="7" fill="var(--panel-2)" />
            <path d="M8 23V9h13M8 16h9" stroke="var(--accent)" strokeWidth="3.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
            <circle cx="24" cy="22" r="3" fill="var(--accent)" />
          </svg>
        </div>
        <div className="brand-text">
          <span className="brand-name">SketchUp Factory</span>
          {app.system?.hostname && <span className="brand-host">{app.system.hostname}</span>}
        </div>
        <button className="btn btn-ghost btn-icon side-icon" title="Search every conversation" aria-label="Search" onClick={() => go({ view: 'search' })}>
          <Icon name="search" size={17} />
        </button>
        <button className="btn btn-ghost btn-icon side-icon" title={push.endpoint ? 'Settings: notifications are on' : 'Settings: notifications and voice'} aria-label="Settings" onClick={() => setSettings(true)}>
          <Icon name={push.endpoint ? 'bell' : 'bellOff'} size={17} />
        </button>
      </div>

      <div className="side-scroll">
        {orch && (
          <Row
            active={route.view === 'home'}
            icon="chat"
            tone={sessionTone(orch.status)}
            pulse={orch.status === 'running'}
            title="Orchestrator"
            sub={<span className={`tone-${sessionTone(orch.status)}`}>{sessionLabel[orch.status]}</span>}
            badge={orch.personMessages?.length ? { count: orch.personMessages.length, hint: `Unread: ${peopleMessagesHint(orch.personMessages)}` } : undefined}
            onClick={() => go({ view: 'home' })}
          />
        )}
        {others.map((s) => {
          const who = chatOwner(s)!;
          return (
            <Row
              key={s.id}
              active={route.view === 'chat' && route.userId.toLowerCase() === who.userId.toLowerCase()}
              icon="chat"
              tone={sessionTone(s.status)}
              pulse={s.status === 'running'}
              title={who.displayName}
              sub={
                <>
                  <span className="row-prefix">Orchestrator · </span>
                  <span className={`tone-${sessionTone(s.status)}`}>{sessionLabel[s.status]}</span>
                </>
              }
              hint={`${who.displayName}’s own orchestrator (read only)`}
              onClick={() => go({ view: 'chat', userId: who.userId })}
            />
          );
        })}
        {dispatcher && (
          <Row
            active={route.view === 'dispatcher'}
            icon="inbox"
            tone={ledger.tone}
            pulse={isBusy(dispatcher)}
            title="Dispatcher"
            sub={<span className={`tone-${ledger.tone}`}>{ledger.label}</span>}
            hint="Everyone’s requests for work and what became of them"
            onClick={() => go({ view: 'dispatcher' })}
          />
        )}

        <Row
          active={route.view === 'overview'}
          icon="monitor"
          tone={fleet.some((c) => c.busy > 0) ? 'blue' : 'grey'}
          title="Overview"
          sub={<span>{overviewLine(fleet)}</span>}
          onClick={() => go({ view: 'overview' })}
        />

        {attention.length > 0 && <AttentionList items={attention} onPick={onNavigate} />}

        <Section title="Computers" count={app.machines.filter((m) => !m.local).length + 1} add="New sandbox" onAdd={onNewSandbox}>
          <FleetGroups app={app} sel={selection} go={go} onNewSandbox={onNewSandbox} />
          <button className="link-btn fl-add-machine" onClick={onNewMachine}>
            {app.machines.length ? 'Add a machine' : 'Add a Mac or Windows PC where agents can work'}
          </button>
        </Section>

        {(app.providers ?? []).length > 0 && (
          <Section title="Providers" count={app.providers!.length}>
            {app.providers!.map((p) => (
              <PlaceRow
                key={p.id}
                title={p.name}
                glance={providerGlance(p, now)}
                active={route.view === 'provider' && route.providerId === p.id}
                hint={`${p.name}: CPU-only containers, reached through its connector${p.connector ? ` (${p.connector.version})` : ''}`}
                onClick={() => go({ view: 'provider', providerId: p.id })}
              />
            ))}
          </Section>
        )}

        <Section title="Standing agents" count={app.standingAgents.length} add="New standing agent" onAdd={onNewStanding}>
          {app.standingAgents.length === 0 && (
            <p className="side-empty">
              Long-lived agents with a job and a schedule.{' '}
              <button className="link-btn" onClick={onNewStanding}>
                Define one
              </button>
              .
            </p>
          )}
          {app.standingAgents.map((a) => (
            <PlaceRow
              key={a.id}
              title={a.name}
              glance={standingGlance(
                a,
                app.delegations.filter((d) => d.agentId === a.id && d.status === 'pending').length,
                now,
              )}
              active={route.view === 'agent' && route.agentId === a.id}
              hint={`${a.model} · today ${fmtCost(a.spend.usd)} of $${a.budget.perDayUsd.toFixed(0)}`}
              onClick={() => go({ view: 'agent', agentId: a.id })}
            />
          ))}
        </Section>
      </div>

      <ExternalStrip app={app} route={route} onNavigate={onNavigate} />
      <SystemFooter app={app} />
      {app.app && (
        <div className="side-foot" data-testid="app-version" title="SketchUp Factory version and git commit">
          {versionLabel(app.app)}
        </div>
      )}
      {settings && <SettingsModal app={app.app} onClose={() => setSettings(false)} />}
    </aside>
  );
}

/** What the sidebar marks as open: a sandbox (host "alpha" or machine "m5/sb1"), a machine's main clone, an agent. */
function selectionOf(route: Route, sessions: Map<string, SessionInfo>): FleetSelection {
  if (route.view === 'sandbox') return { sandbox: route.sandboxId, sessionId: route.sessionId };
  if (route.view === 'msandbox') return { sandbox: `${route.machineId}/${route.sandboxId}`, sessionId: route.sessionId };
  if (route.view === 'machine') return { machineMain: route.machineId, sessionId: route.sessionId };
  if (route.view !== 'session') return {};
  const s = sessions.get(route.sessionId);
  if (s?.sandboxId) return { sandbox: s.sandboxId, sessionId: s.id };
  if (s?.machineId && s.machineSandbox) return { sandbox: `${s.machineId}/${s.machineSandbox}`, sessionId: s.id };
  if (s?.machineId) return { machineMain: s.machineId, sessionId: s.id };
  return {};
}

/** The Overview row's line: how many agents are live and busy across every computer. */
function overviewLine(fleet: FleetComputer[]): string {
  const live = fleet.reduce((n, c) => n + c.live, 0);
  const busy = fleet.reduce((n, c) => n + c.busy, 0);
  return `${fleet.length} ${fleet.length === 1 ? 'computer' : 'computers'} · ${busy} of ${live} ${live === 1 ? 'agent' : 'agents'} busy`;
}

// ---------------------------------------------------------------- rows

function Row({
  active,
  icon,
  tone,
  pulse,
  title,
  sub,
  hint,
  badge,
  onClick,
}: {
  active: boolean;
  icon: IconName;
  tone: Glance['tone'];
  pulse?: boolean;
  title: string;
  sub: ReactNode;
  hint?: string;
  /** Unread messages from other people in your own chat. */
  badge?: { count: number; hint: string };
  onClick: () => void;
}) {
  return (
    <button className={`row${active ? ' active' : ''}`} onClick={onClick} aria-current={active ? 'page' : undefined} title={hint}>
      <span className="row-icon">
        <Icon name={icon} size={16} />
      </span>
      <span className="row-main">
        <span className="row-title">{title}</span>
        <span className="row-sub">{sub}</span>
      </span>
      {badge && (
        <span className="badge badge-amber" title={badge.hint} data-testid="unread-people">
          {badge.count}
        </span>
      )}
      <Dot tone={tone} pulse={pulse} />
    </button>
  );
}

/** A sandbox, machine or standing agent: its name, then what it is doing in words (coloured) and for whom. */
function PlaceRow({ title, unused, prefix, glance: g, active, hint, onClick }: { title: string; unused?: boolean; prefix?: string; glance: Glance; active: boolean; hint: string; onClick: () => void }) {
  return (
    <button className={`row place${active ? ' active' : ''}${g.attention ? ' has-attn' : ''}`} onClick={onClick} title={`${title}\n${hint}`} aria-current={active ? 'page' : undefined}>
      <span className="row-icon">
        <Dot tone={g.tone} pulse={g.tone === 'blue'} />
      </span>
      <span className="row-main">
        <span className={`row-title${unused ? ' is-unused' : ''}`}>{title}</span>
        <span className="row-sub">
          {prefix && <span className="row-prefix">{prefix} · </span>}
          <span className={`tone-${g.tone}`}>{g.label}</span>
          {g.detail && <span className="row-detail"> · {g.detail}</span>}
        </span>
        {g.progress && <span className="indeterminate row-progress" />}
      </span>
      {g.attention > 0 && (
        <span className="badge badge-amber" title="Waiting on you">
          {g.attention}
        </span>
      )}
    </button>
  );
}

function Section({ title, count, add, onAdd, children }: { title: string; count: number; add?: string; onAdd?: () => void; children: ReactNode }) {
  return (
    <section className="side-section">
      <div className="section-head">
        <span>{title}</span>
        {count > 0 && <span className="count">{count}</span>}
        {add && onAdd && (
          <button className="btn btn-ghost btn-icon section-add" onClick={onAdd} title={add} aria-label={add}>
            <Icon name="plus" size={15} />
          </button>
        )}
      </div>
      {children}
    </section>
  );
}

const ATTN_ICON: Record<AttentionItem['kind'], IconName> = { permission: 'bell', unity: 'alert', delegation: 'inbox' };

/** Everything waiting on the user, oldest first; each opens where it is answered. */
function AttentionList({ items, onPick }: { items: AttentionItem[]; onPick: () => void }) {
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, 4);
  return (
    <section className="attn" aria-label="Needs you">
      <div className="attn-head">
        <Icon name="bell" size={14} />
        <span>Needs you</span>
        <span className="count">{items.length}</span>
      </div>
      {shown.map((it) => (
        <button
          key={it.key}
          className="attn-item"
          onClick={() => {
            it.open();
            onPick();
          }}
        >
          <Icon name={ATTN_ICON[it.kind]} size={15} />
          <span className="attn-text">
            <span className="attn-title">{it.title}</span>
            <span className="attn-detail">{it.detail}</span>
          </span>
          <Icon name="chevron" size={12} />
        </button>
      ))}
      {items.length > shown.length && (
        <button className="link-btn attn-more" onClick={() => setAll(true)}>
          {items.length - shown.length} more
        </button>
      )}
    </section>
  );
}

/** "2 from Lothsahn, 1 from Ben": whose messages wait in your chat. */
function peopleMessagesHint(list: NonNullable<SessionInfo['personMessages']>): string {
  const by = new Map<string, number>();
  for (const m of list) by.set(m.from.displayName, (by.get(m.from.displayName) ?? 0) + 1);
  return [...by].map(([name, n]) => `${n} ${n === 1 ? 'message' : 'messages'} from ${name}`).join(', ');
}
