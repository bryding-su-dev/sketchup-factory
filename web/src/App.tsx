import { useEffect, useState, type ReactNode } from 'react';
import type { AppState, HostStatus } from '../../shared/types';
import { useAttention } from './attention';
import { Login } from './components/Login';
import { NewSandboxModal } from './components/Modals';
import { OrchestratorView } from './components/OrchestratorView';
import { DispatcherPanel } from './components/DispatcherPanel';
import { SandboxPanel } from './components/SandboxPanel';
import { SessionView } from './components/SessionView';
import { Sidebar } from './components/Sidebar';
import { Icon } from './components/ui';
import { StandingAgentModal } from './components/StandingModal';
import { StandingPanel } from './components/StandingPanel';
import { AddMachineModal, MachinePanel } from './components/MachinePanel';
import { ProviderPanel } from './components/ProviderPanel';
import { MaxPanel } from './components/MaxPanel';
import { MachineSandboxPanel } from './components/MachineSandboxPanel';
import { OverviewBoard } from './components/Fleet';
import { Toasts } from './components/Toasts';
import { Lightbox } from './components/Images';
import { SearchView } from './components/SearchView';
import { reloadNow, useNewVersion } from './freshness';
import { setDrawer, useStore } from './store';
import { sessionRoute } from './attention';
import { displayName, fmtBytes, fmtClock, href, navigate, useMediaQuery, useRoute, type Route } from './util';

export function App() {
  const auth = useStore((s) => s.auth);
  const app = useStore((s) => s.app);

  if (auth === 'needed') return <Login />;
  if (auth === 'unknown' || !app) {
    return (
      <div className="splash">
        <span className="spinner" /> Connecting…
        <Toasts />
      </div>
    );
  }
  return <Shell app={app} />;
}

function Shell({ app }: { app: AppState }) {
  const route = useRoute();
  const wide = useMediaQuery('(min-width: 1280px)');
  const mobile = useMediaQuery('(max-width: 860px)');
  const drawer = useStore((s) => s.drawer);
  const [newSandbox, setNewSandbox] = useState(false);
  const [newStanding, setNewStanding] = useState(false);
  const [newMachine, setNewMachine] = useState(false);
  const waiting = useAttention(app).length;

  useEffect(() => {
    document.title = waiting ? `(${waiting}) SketchUp Factory` : 'SketchUp Factory';
  }, [waiting]);

  useEffect(() => {
    if (!mobile) setDrawer(false);
  }, [mobile]);

  // Any navigation closes the phone drawer, including one from a modal opened in it (a new standing agent opens its page).
  const at = href(route);
  useEffect(() => setDrawer(false), [at]);

  const orch = app.sessions.find((s) => s.id === app.orchestratorId);
  const content = renderRoute(route, app, wide);

  return (
    <div className={`shell${drawer ? ' drawer-open' : ''}`}>
      <div className="sidebar-wrap">
        <Sidebar app={app} route={route} onNewSandbox={() => setNewSandbox(true)} onNewStanding={() => setNewStanding(true)} onNewMachine={() => setNewMachine(true)} onNavigate={() => setDrawer(false)} />
      </div>
      <div className="scrim" onClick={() => setDrawer(false)} />

      <div className="main-col">
        {/* Global notices sit above the page in the layout flow: they push it down, never cover its header. */}
        <div className="gbars">
          <ConnectionBanner />
          <NewVersionBanner />
          <HostBanner host={app.host} app={app} />
        </div>
        <main className={`main main-${content.layout}`}>{content.node ?? <OrchestratorView session={orch} />}</main>
      </div>

      {newSandbox && <NewSandboxModal app={app} onClose={() => setNewSandbox(false)} />}
      {newStanding && <StandingAgentModal app={app} onClose={() => setNewStanding(false)} />}
      {newMachine && <AddMachineModal onClose={() => setNewMachine(false)} />}
      <Lightbox />
      <Toasts />
    </div>
  );
}

/**
 * One global notice: an opaque one-line bar in the layout flow above the page (it pushes the page down, never
 * covers it). The text is cut to one line; hover shows it all (title), a click or tap unfolds it. `onDismiss`
 * adds a close button.
 */
function Bar({ kind, text, children, onDismiss, busy, action }: { kind: 'warn' | 'error'; text: string; children: ReactNode; onDismiss?: () => void; busy?: boolean; action?: { label: string; onClick: () => void } }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`gbar gbar-${kind}${open ? ' open' : ''}`} role="status">
      {busy && <span className="spinner spinner-sm" />}
      <button type="button" className="gbar-text" title={text} aria-expanded={open} onClick={() => setOpen(!open)}>
        {children}
      </button>
      {action && (
        <button type="button" className="btn btn-sm gbar-x" onClick={action.onClick}>
          {action.label}
        </button>
      )}
      {onDismiss && (
        <button type="button" className="btn btn-ghost btn-sm gbar-x" aria-label="Dismiss" title="Dismiss" onClick={onDismiss}>
          <Icon name="x" size={12} />
        </button>
      )}
    </div>
  );
}

/** The live connection dropped: say so (after a moment, so a quick reconnect does not flash). */
function ConnectionBanner() {
  const ws = useStore((s) => s.ws);
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (ws === 'open') {
      setShow(false);
      return;
    }
    const t = setTimeout(() => setShow(true), 2500);
    return () => clearTimeout(t);
  }, [ws]);
  if (!show) return null;
  return (
    <Bar kind="warn" busy text="Connection lost. Reconnecting…">
      <b>Connection lost.</b> Reconnecting…
    </Bar>
  );
}

/** The server serves a newer web UI than this page runs, and reloading by itself now would lose something (web/src/freshness.ts). */
function NewVersionBanner() {
  if (!useNewVersion()) return null;
  return (
    <Bar kind="warn" text="A new version of FF Factory is ready. Reload to use it: a typed message is kept, pictures and files not yet sent are not." action={{ label: 'Reload', onClick: reloadNow }}>
      <b>A new version of FF Factory is ready.</b> Reload to use it: a typed message is kept, pictures and files not yet sent are not.
    </Bar>
  );
}

/**
 * The server's own trouble: running elevated (no Unity), a restart waiting for agents, the host guard's alarms.
 * Each can be dismissed; it comes back when what it says changes.
 */
function HostBanner({ host, app }: { host?: HostStatus; app: AppState }) {
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const h = host?.health;
  const drive = h && h.sandboxRoot !== 'ok';
  const disk = h && h.level !== 'ok';
  if (!host?.elevated && !host?.drain && !drive && !disk) return null;
  const low = h?.disks.filter((d) => d.level !== 'ok').map((d) => `${d.path} ${d.freeBytes === undefined ? '?' : fmtBytes(d.freeBytes)} free`).join(', ');
  const title = (id: string) => app.sessions.find((s) => s.id === id)?.title ?? id;
  const bars: { key: string; kind: 'warn' | 'error'; lead: string; rest: string }[] = [];
  if (host.elevated) {
    bars.push({
      key: 'elevated',
      kind: 'error',
      lead: 'SketchUp Factory is running with administrator rights.',
      rest: `It will not start Unity editors (they would stop on Unity's administrator dialog), and every agent shell has admin rights. Run scripts\\restart.cmd to bring it back non-elevated.${host.elevatedWhy ? ` (${host.elevatedWhy})` : ''}`,
    });
  }
  if (drive) {
    bars.push({ key: 'drive', kind: 'error', lead: 'The sandbox drive is offline', rest: `(${h.sandboxRoot}${h.detail ? `: ${h.detail}` : ''}). SketchUp Factory is reattaching it by itself; the editors and agents that were working there come back afterwards.` });
  }
  if (disk && !drive) {
    bars.push({
      key: 'disk',
      kind: h.level === 'critical' ? 'error' : 'warn',
      lead: `Disk space ${h.level === 'critical' ? 'critical' : 'low'}`,
      rest: `(${low}). New editors and agents wait until space is freed${h.level === 'critical' ? '; busy agents were asked to checkpoint, idle editors stopped, and known-safe junk is cleaned up' : ''}.`,
    });
  }
  if (host.drain) {
    const d = host.drain;
    bars.push({
      key: 'drain',
      kind: 'warn',
      lead: 'Restart pending',
      rest: `(${d.reason}): waiting for ${d.waitingFor.length ? d.waitingFor.map(title).join(', ') : 'nothing'} to finish, at the latest ${fmtClock(d.deadline)}. Interrupted agents are resumed afterwards.`,
    });
  }
  const shown = bars.filter((b) => !dismissed.has(`${b.key}:${b.lead} ${b.rest}`));
  if (!shown.length) return null;
  return (
    <>
      {shown.map((b) => (
        <Bar key={b.key} kind={b.kind} text={`${b.lead} ${b.rest}`} onDismiss={() => setDismissed((s) => new Set(s).add(`${b.key}:${b.lead} ${b.rest}`))}>
          <b>{b.lead}</b> {b.rest}
        </Bar>
      ))}
    </>
  );
}

function renderRoute(route: Route, app: AppState, wide: boolean): { node: ReactNode; layout: string; title: string } {
  const orch = app.sessions.find((s) => s.id === app.orchestratorId);
  if (route.view === 'chat') {
    // Someone else's own orchestrator, read only; your own is the home page.
    const s = app.sessions.find((x) => x.kind === 'orchestrator' && x.orchestratorRole === 'personal' && x.requestedBy?.userId.toLowerCase() === route.userId.toLowerCase());
    if (!s) return { node: <Missing what="conversation" />, layout: 'single', title: 'Not found' };
    if (s.id === app.orchestratorId) return { node: null, layout: 'single', title: 'Orchestrator' };
    return { layout: 'single', title: s.title, node: <OrchestratorView key={s.id} session={s} readOnly /> };
  }
  if (route.view === 'dispatcher') {
    const panel = <DispatcherPanel app={app} tab={route.tab} onClose={() => navigate({ view: 'home' })} />;
    if (wide) {
      return {
        layout: 'split',
        title: 'Dispatcher',
        node: (
          <>
            <OrchestratorView session={orch} compact />
            {panel}
          </>
        ),
      };
    }
    return { layout: 'single', title: 'Dispatcher', node: panel };
  }
  if (route.view === 'sandbox') {
    const sb = app.sandboxes.find((s) => s.id === route.sandboxId);
    if (!sb) return { node: <Missing what="sandbox" />, layout: 'single', title: 'Not found' };
    if (wide) {
      return {
        layout: 'split',
        title: displayName(sb),
        node: (
          <>
            <OrchestratorView session={orch} compact />
            <SandboxPanel app={app} sandbox={sb} sessionId={route.sessionId} onClose={() => navigate({ view: 'home' })} />
          </>
        ),
      };
    }
    return {
      layout: 'single',
      title: displayName(sb),
      node: <SandboxPanel app={app} sandbox={sb} sessionId={route.sessionId} onClose={() => navigate({ view: 'home' })} />,
    };
  }
  if (route.view === 'search') {
    return { layout: 'single', title: 'Search', node: <SearchView key={route.q ?? ''} app={app} initial={route.q} /> };
  }
  if (route.view === 'machine') {
    const m = app.machines.find((x) => x.id === route.machineId);
    if (!m) return { node: <Missing what="machine" />, layout: 'single', title: 'Not found' };
    const panel = <MachinePanel app={app} machine={m} sessionId={route.sessionId} onClose={() => navigate({ view: 'home' })} />;
    if (wide) {
      return {
        layout: 'split',
        title: displayName(m),
        node: (
          <>
            <OrchestratorView session={orch} compact />
            {panel}
          </>
        ),
      };
    }
    return { layout: 'single', title: displayName(m), node: panel };
  }
  if (route.view === 'msandbox') {
    const m = app.machines.find((x) => x.id === route.machineId);
    const sb = m?.sandboxes?.find((x) => x.id === route.sandboxId);
    if (!m || !sb) return { node: <Missing what="sandbox" />, layout: 'single', title: 'Not found' };
    const panel = <MachineSandboxPanel app={app} machine={m} sandbox={sb} sessionId={route.sessionId} onClose={() => navigate({ view: 'home' })} />;
    if (wide) {
      return {
        layout: 'split',
        title: displayName(sb),
        node: (
          <>
            <OrchestratorView session={orch} compact />
            {panel}
          </>
        ),
      };
    }
    return { layout: 'single', title: displayName(sb), node: panel };
  }
  if (route.view === 'overview') {
    return { layout: 'single', title: 'Overview', node: <OverviewBoard app={app} /> };
  }
  if (route.view === 'max') {
    if (!app.max) return { node: <Missing what="page" />, layout: 'single', title: 'Not found' };
    const panel = <MaxPanel app={app} max={app.max} tab={route.tab} onClose={() => navigate({ view: 'home' })} />;
    if (wide) {
      return {
        layout: 'split',
        title: 'Max',
        node: (
          <>
            <OrchestratorView session={orch} compact />
            {panel}
          </>
        ),
      };
    }
    return { layout: 'single', title: 'Max', node: panel };
  }
  if (route.view === 'provider') {
    // FFBox is listed only while switched on or set up; its page (with what it needs) opens either way.
    const p = app.providers?.find((x) => x.id === route.providerId) ?? (app.ffbox?.id === route.providerId ? app.ffbox : undefined);
    if (!p) return { node: <Missing what="provider" />, layout: 'single', title: 'Not found' };
    const panel = <ProviderPanel provider={p} tab={route.tab} onClose={() => navigate({ view: 'home' })} />;
    if (wide) {
      return {
        layout: 'split',
        title: p.name,
        node: (
          <>
            <OrchestratorView session={orch} compact />
            {panel}
          </>
        ),
      };
    }
    return { layout: 'single', title: p.name, node: panel };
  }
  if (route.view === 'agent') {
    const a = app.standingAgents.find((x) => x.id === route.agentId);
    if (!a) return { node: <Missing what="standing agent" />, layout: 'single', title: 'Not found' };
    const panel = <StandingPanel app={app} agent={a} tab={route.tab} onClose={() => navigate({ view: 'home' })} />;
    if (wide) {
      return {
        layout: 'split',
        title: a.name,
        node: (
          <>
            <OrchestratorView session={orch} compact />
            {panel}
          </>
        ),
      };
    }
    return { layout: 'single', title: a.name, node: panel };
  }
  if (route.view === 'session') {
    const s = app.sessions.find((x) => x.id === route.sessionId);
    if (!s) return { node: <Missing what="session" />, layout: 'single', title: 'Not found' };
    if (s.id === app.orchestratorId) return { node: null, layout: 'single', title: 'Orchestrator' };
    if (s.kind === 'orchestrator') return renderRoute(sessionRoute(s, app), app, wide);
    return {
      layout: 'single',
      title: s.title,
      node: (
        <SessionView
          session={s}
          fullWidth
          onBack={() =>
            navigate(
              s.sandboxId
                ? { view: 'sandbox', sandboxId: s.sandboxId, sessionId: s.id }
                : s.machineId && s.machineSandbox
                  ? { view: 'msandbox', machineId: s.machineId, sandboxId: s.machineSandbox, sessionId: s.id }
                  : s.machineId && !s.standingId
                  ? { view: 'machine', machineId: s.machineId, sessionId: s.id }
                  : s.standingId
                  ? { view: 'agent', agentId: s.standingId, tab: 'conversation' }
                  : { view: 'home' },
            )
          }
        />
      ),
    };
  }
  return { node: null, layout: 'single', title: 'Orchestrator' };
}

function Missing({ what }: { what: string }) {
  return (
    <div className="panel-empty">
      <p>That {what} no longer exists.</p>
      <button className="btn btn-outline" onClick={() => navigate({ view: 'home' })}>
        Back to the orchestrator
      </button>
    </div>
  );
}
