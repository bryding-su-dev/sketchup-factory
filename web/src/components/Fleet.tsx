// Every computer and what it is working on (shared/fleet.ts), drawn twice: as collapsible groups in the
// sidebar, and as one card per computer on the Overview board. A group is its header (name, online, load,
// sandbox and editor counts), its sandboxes with their live agents, and a machine's main-clone agents.
import { useState, type ReactNode } from 'react';
import type { AppState, HostHealth, Machine, SessionInfo } from '../../../shared/types';
import { capacityLine, fleetOf, type FleetComputer, type FleetSandbox, type PlaceAgents } from '../../../shared/fleet';
import { useAttention } from '../attention';
import { sessionIndex } from '../store';
import { displayName, fmtBytes, fmtRelative, isUnused, lsGet, lsSet, machineGlance, machineSandboxGlance, navigate, sandboxGlance, unityLabel, unityTone, useNow, type Glance, type Route, type Tone } from '../util';
import { AttentionButton, DrawerButton } from './ShellButtons';
import { describe, gpuPct, level, ramLvl, ramPct, type Lvl } from './SystemMeters';
import { Dot, Icon } from './ui';
import { useKeepScroll } from '../scrollKeep';

type Variant = 'side' | 'board';

/** Where the user is, so the sidebar can mark it. */
export interface FleetSelection {
  sandbox?: string;
  machineMain?: string;
  sessionId?: string;
}

const osName = (p: string | undefined) => (!p ? '' : p.startsWith('win') ? 'Windows' : p.startsWith('darwin') ? 'Mac' : p.split(' ')[0]);

const ago = (iso: string, now: number) => fmtRelative(iso, now).replace(' ago', '').replace('just now', 'now');

/** An agent in a few words: waiting on someone, busy, starting or idle. */
function agentState(s: SessionInfo): { word: string; tone: Tone } {
  if (s.pendingPermissions.length || s.status === 'waiting_permission') return { word: 'needs you', tone: 'amber' };
  if (s.status === 'running') return { word: 'busy', tone: 'blue' };
  if (s.status === 'starting') return { word: 'starting', tone: 'blue' };
  return { word: 'idle', tone: 'grey' };
}

/** The tooltip's second line: the live agents by name. */
const agentsHint = (a: PlaceAgents) => (a.live.length ? `\nAgents: ${a.live.map((s) => s.title).join(', ')}` : '');

const sandboxRoute = (sb: FleetSandbox, sessionId?: string): Route =>
  sb.machineId ? { view: 'msandbox', machineId: sb.machineId, sandboxId: sb.id, sessionId } : { view: 'sandbox', sandboxId: sb.id, sessionId };

// ---------------------------------------------------------------- collapsed groups (per viewer)

const COLLAPSED = 'ffsb.fleet.collapsed';

function useCollapsed(): [Set<string>, (key: string) => void] {
  const [set, setSet] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(lsGet(COLLAPSED) ?? '[]') as string[]);
    } catch {
      return new Set();
    }
  });
  const toggle = (key: string) => {
    const next = new Set(set);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setSet(next);
    lsSet(COLLAPSED, next.size ? JSON.stringify([...next]) : null);
  };
  return [set, toggle];
}

// ---------------------------------------------------------------- the pieces

/** CPU, RAM, GPU and disk in one line: a small bar and a number each; hover for the full numbers. */
function Meters({ c, health, now }: { c: FleetComputer; health?: HostHealth; now: number }) {
  const s = c.stats;
  if (!s) {
    const m = c.machine;
    const text = !c.online ? `offline${m?.lastSeen ? ` · seen ${fmtRelative(m.lastSeen, now)}` : ''}` : 'no numbers yet';
    return <span className="fl-meters fl-meters-off">{text}</span>;
  }
  // The host's disks are its guard's volumes where it has them: the fullest one stands for them all.
  const guarded = c.host && health?.disks.length ? health.disks.filter((d) => d.totalBytes && d.freeBytes !== undefined) : [];
  const disk = guarded.length
    ? guarded.map((d) => ({ used: ((d.totalBytes! - d.freeBytes!) / d.totalBytes!) * 100, free: d.freeBytes!, lvl: (d.level === 'critical' ? 'crit' : d.level) as Lvl })).sort((a, b) => b.used - a.used)[0]
    : s.diskTotalBytes && s.diskFreeBytes !== undefined
      ? { used: ((s.diskTotalBytes - s.diskFreeBytes) / s.diskTotalBytes) * 100, free: s.diskFreeBytes, lvl: level(((s.diskTotalBytes - s.diskFreeBytes) / s.diskTotalBytes) * 100, 85, 95) }
      : undefined;
  const g = gpuPct(s);
  const cells: { label: string; pct?: number; text: string; lvl: Lvl }[] = [
    { label: 'CPU', pct: s.loadPct, text: `${Math.round(s.loadPct)}%`, lvl: level(s.loadPct) },
    { label: 'RAM', pct: ramPct(s), text: `${Math.round(ramPct(s))}%`, lvl: ramLvl(s) },
    // "GPU" either way (VRAM in use on a discrete card, how busy it is on Apple Silicon); the hover says which.
    ...(g !== undefined ? [{ label: 'GPU', pct: g, text: `${Math.round(g)}%`, lvl: level(g) }] : []),
    // "1.1T" free: the unit's letter only, so the four fit the sidebar on any font.
    ...(disk ? [{ label: 'Disk', pct: disk.used, text: fmtBytes(disk.free).replace(/ ([KMGT])B$/, '$1'), lvl: disk.lvl }] : []),
  ];
  return (
    <span className="fl-meters" title={describe({ name: c.name, stats: s, online: c.online, host: c.host })}>
      {cells.map((m) => (
        <span key={m.label} className="fl-meter" data-testid={`meter-${m.label}`}>
          <span className={`mbar lvl-bg-${m.lvl}`} aria-hidden>
            <i style={{ height: `${Math.max(8, Math.min(100, m.pct ?? 0))}%` }} />
          </span>
          {m.label} <b className={`lvl-${m.lvl}`}>{m.text}</b>
        </span>
      ))}
    </span>
  );
}

/** A computer's name, state, load and counts. */
function Head({ c, health, now, fold }: { c: FleetComputer; health?: HostHealth; now: number; fold?: boolean }) {
  // The host with its own daemon (docs/beast-machine.md): its dot says whether that daemon, which runs its sandboxes, is up.
  const d = c.daemon;
  const tone: Tone = c.machine
    ? c.machine.status === 'deploying'
      ? 'blue'
      : c.machine.status === 'error'
        ? 'red'
        : c.online
          ? 'green'
          : 'grey'
    : d && (!d.online || d.status === 'error')
      ? 'red'
      : d?.status === 'deploying'
        ? 'blue'
        : 'green';
  const state = c.machine?.status === 'deploying' ? 'setting up' : c.machine?.status === 'error' ? 'error' : c.online ? 'online' : 'offline';
  const daemonState = d ? (d.status === 'deploying' ? 'daemon setting up' : !d.online ? 'daemon offline' : d.status === 'error' ? 'daemon error' : '') : '';
  return (
    <>
      <span className="fl-title">
        <Dot tone={tone} pulse={tone === 'blue'} title={c.host ? daemonState || (d ? 'host and its daemon online' : 'host') : state} />
        <span className="fl-name">{c.name}</span>
        <span className="fl-os" data-testid="fl-os">{[osName(c.platform), c.host ? 'host' : state === 'online' ? '' : state, daemonState].filter(Boolean).join(' · ')}</span>
        {c.live > 0 && (
          <span className="fl-agents-sum" data-testid="fl-agents-sum">
            {c.live} {c.live === 1 ? 'agent' : 'agents'}
            {c.busy ? `, ${c.busy} busy` : ''}
          </span>
        )}
        {c.attention > 0 && (
          <span className="badge badge-amber" title="Waiting on you">
            {c.attention}
          </span>
        )}
        {fold && <Icon name="chevron" size={12} />}
      </span>
      <Meters c={c} health={health} now={now} />
      <span className="fl-cap" data-testid="fl-capacity">
        {capacityLine(c)}
      </span>
    </>
  );
}

function AgentLine({ s, now, active, variant, onOpen }: { s: SessionInfo; now: number; active: boolean; variant: Variant; onOpen: () => void }) {
  const st = agentState(s);
  return (
    <button
      className={`fl-agent${active ? ' active' : ''}`}
      onClick={onOpen}
      title={`${s.title}: ${st.word}, last active ${fmtRelative(s.lastActivityAt, now)}${s.requestedBy ? ` · for ${s.requestedBy.displayName}` : ''}${s.model ? ` · ${s.model}` : ''}`}
      data-testid="fl-agent"
    >
      <Dot tone={st.tone} pulse={s.status === 'running'} />
      <span className="fl-agent-title">{s.title}</span>
      {variant === 'board' && s.requestedBy && <span className="fl-agent-for">{s.requestedBy.displayName}</span>}
      <span className={`fl-agent-state tone-${st.tone}`}>{st.word}</span>
      <span className="fl-agent-age">{ago(s.lastActivityAt, now)}</span>
    </button>
  );
}

function Agents({ agents, now, sel, variant, open }: { agents: PlaceAgents; now: number; sel: FleetSelection; variant: Variant; open: (s: SessionInfo) => void }) {
  if (!agents.live.length && !agents.stopped) return null;
  return (
    <div className="fl-agents">
      {agents.live.map((s) => (
        <AgentLine key={s.id} s={s} now={now} active={sel.sessionId === s.id} variant={variant} onOpen={() => open(s)} />
      ))}
      {agents.stopped > 0 && (
        <span className="fl-stopped" title="Stopped or failed agents: open the place to see them">
          +{agents.stopped} stopped
        </span>
      )}
    </div>
  );
}

/** A place row: the state dot, the label (with a FREE badge or the Unity mark), and a line under it. */
function PlaceHead({ glance: g, title, unused, free, unity, sub, active, hint, onClick, testId }: { glance: Glance; title: string; unused: boolean; free?: boolean; unity?: { tone: Tone; label: string }; sub: ReactNode; active: boolean; hint: string; onClick: () => void; testId: string }) {
  return (
    <button className={`row place fl-place${active ? ' active' : ''}${g.attention ? ' has-attn' : ''}`} onClick={onClick} title={`${title}\n${hint}`} aria-current={active ? 'page' : undefined} data-testid={testId}>
      <span className="row-icon">
        <Dot tone={g.tone} pulse={g.tone === 'blue'} />
      </span>
      <span className="row-main">
        <span className="fl-place-title">
          <span className={`row-title${unused ? ' is-unused' : ''}`}>{title}</span>
          {free && <span className="fl-free">FREE</span>}
          {unity && !free && (
            <span className={`fl-unity tone-${unity.tone}`} title={unity.label}>
              Unity
            </span>
          )}
        </span>
        <span className="row-sub">{sub}</span>
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

function SandboxItem({ sb, now, sel, variant, go }: { sb: FleetSandbox; now: number; sel: FleetSelection; variant: Variant; go: (r: Route) => void }) {
  const g = sb.sandbox ? sandboxGlance(sb.sandbox, sb.agents.live) : machineSandboxGlance(sb.machineSandbox!, sb.agents.live);
  const unityAbout = /^Unity/.test(g.label);
  const title = displayName(sb);
  return (
    <div className="fl-sb" data-testid={`fl-sandbox-${sb.key}`}>
      <PlaceHead
        glance={g}
        title={title}
        unused={isUnused(sb.purpose)}
        free={sb.free}
        unity={sb.status === 'ready' ? { tone: unityTone(sb.unity), label: unityLabel[sb.unity] } : undefined}
        sub={
          <>
            {!sb.free && (
              <>
                <span className={`tone-${g.tone}`}>{g.label}</span>
                {' · '}
              </>
            )}
            <span className="mono fl-branch">{sb.branch}</span>
            {variant === 'board' && sb.status === 'ready' && !unityAbout && <span className={`tone-${unityTone(sb.unity)}`}> · {unityLabel[sb.unity]}</span>}
          </>
        }
        active={sel.sandbox === sb.key && !sel.sessionId}
        hint={`Slot ${sb.key} · ${sb.branch}${sb.status === 'ready' ? ` · ${unityLabel[sb.unity]}` : ''}${agentsHint(sb.agents)}`}
        onClick={() => go(sandboxRoute(sb))}
        testId="fl-sandbox-row"
      />
      <Agents agents={sb.agents} now={now} sel={sel} variant={variant} open={(s) => go(sandboxRoute(sb, s.id))} />
    </div>
  );
}

function MainClone({ m, agents, now, sel, variant, go }: { m: Machine; agents: PlaceAgents; now: number; sel: FleetSelection; variant: Variant; go: (r: Route) => void }) {
  const g = machineGlance(m, agents.live, now);
  return (
    <div className="fl-sb fl-main" data-testid={`fl-main-${m.id}`}>
      <PlaceHead
        glance={g}
        title={displayName(m)}
        unused={isUnused(m.purpose)}
        sub={
          <>
            <span className="row-prefix">main clone · </span>
            <span className={`tone-${g.tone}`}>{g.label}</span>
            {m.git && (
              <>
                {' · '}
                <span className="mono fl-branch">{m.git.branch}</span>
              </>
            )}
          </>
        }
        active={sel.machineMain === m.id && !sel.sessionId}
        hint={`The main clone on ${m.name ?? m.id}${m.repoPath ? ` (${m.repoPath})` : ''}${m.git ? ` · ${m.git.branch}` : ''}${agentsHint(agents)}`}
        onClick={() => go({ view: 'machine', machineId: m.id })}
        testId="fl-main-row"
      />
      <Agents agents={agents} now={now} sel={sel} variant={variant} open={(s) => go({ view: 'machine', machineId: m.id, sessionId: s.id })} />
    </div>
  );
}

/** A computer's places: its sandboxes (free ones last) and a machine's main clone. On the board, free sandboxes are one line of chips. */
function Places({ c, now, sel, variant, go, onNewSandbox }: { c: FleetComputer; now: number; sel: FleetSelection; variant: Variant; go: (r: Route) => void; onNewSandbox?: () => void }) {
  const free = variant === 'board' ? c.sandboxes.filter((s) => s.free) : [];
  const shown = variant === 'board' ? c.sandboxes.filter((s) => !s.free) : c.sandboxes;
  return (
    <div className="fl-places">
      {shown.map((sb) => (
        <SandboxItem key={sb.key} sb={sb} now={now} sel={sel} variant={variant} go={go} />
      ))}
      {free.length > 0 && (
        <div className="fl-free-line" data-testid="fl-free-line">
          <span className="fl-free">FREE</span>
          {free.map((sb) => (
            <button key={sb.key} className="fl-chip mono" onClick={() => go(sandboxRoute(sb))} title={`${sb.key} · ${sb.branch} · ${unityLabel[sb.unity]}`}>
              {sb.id}
            </button>
          ))}
        </div>
      )}
      {c.host && c.sandboxes.length === 0 && (
        <p className="side-empty">
          No sandboxes yet. Ask the orchestrator for work
          {onNewSandbox && (
            <>
              , or{' '}
              <button className="link-btn" onClick={onNewSandbox}>
                create one
              </button>
            </>
          )}
          .
        </p>
      )}
      {c.machine && <MainClone m={c.machine} agents={c.main!} now={now} sel={sel} variant={variant} go={go} />}
    </div>
  );
}

/** The inputs and result of the last fleetFor: the sidebar, its groups and the Overview share one per state change. */
let lastFleet: { key: unknown[]; fleet: FleetComputer[] } | undefined;

/** fleetOf, computed once per change of what it reads (the page re-renders on every server event). */
export function fleetFor(app: AppState): FleetComputer[] {
  const key = [app.sandboxes, app.sessions, app.machines, app.system, app.machineStats];
  if (!lastFleet || key.some((k, i) => k !== lastFleet!.key[i])) lastFleet = { key, fleet: fleetOf(app, sessionIndex(app.sessions)) };
  return lastFleet.fleet;
}

// ---------------------------------------------------------------- the sidebar's groups

export function FleetGroups({ app, sel, go, onNewSandbox }: { app: AppState; sel: FleetSelection; go: (r: Route) => void; onNewSandbox: () => void }) {
  const now = useNow(15_000);
  const [collapsed, toggle] = useCollapsed();
  return (
    <>
      {fleetFor(app).map((c) => {
        const closed = collapsed.has(c.key);
        return (
          <div key={c.key} className={`fl-group${closed ? ' collapsed' : ''}`} data-testid={`fl-group-${c.key}`}>
            <button className="fl-head" onClick={() => toggle(c.key)} aria-expanded={!closed} title={closed ? `Show ${c.name}'s sandboxes and agents` : `Hide ${c.name}'s sandboxes and agents`}>
              <Head c={c} health={c.host ? app.host?.health : undefined} now={now} fold />
            </button>
            {!closed && <Places c={c} now={now} sel={sel} variant="side" go={go} onNewSandbox={c.host ? onNewSandbox : undefined} />}
          </div>
        );
      })}
    </>
  );
}

// ---------------------------------------------------------------- the Overview board

export function OverviewBoard({ app }: { app: AppState }) {
  const keep = useKeepScroll('overview');
  const now = useNow(15_000);
  const fleet = fleetFor(app);
  const live = fleet.reduce((n, c) => n + c.live, 0);
  const busy = fleet.reduce((n, c) => n + c.busy, 0);
  const waiting = useAttention(app).length;
  const go = (r: Route) => navigate(r);
  return (
    <section className="overview" data-testid="overview">
      <header className="page-head">
        <DrawerButton />
        <span className="page-title">Overview</span>
        <span className="overview-sum dim small">
          {live} {live === 1 ? 'agent' : 'agents'} live · {busy} busy{waiting ? ` · ${waiting} waiting on you` : ''}
        </span>
        <span className="spacer" />
        <AttentionButton />
      </header>
      <div className="board" ref={keep}>
        {fleet.map((c) => (
          <article key={c.key} className="board-card" data-testid={`board-${c.key}`}>
            <header className="board-head">
              {c.machine ? (
                <button className="board-head-link" onClick={() => go({ view: 'machine', machineId: c.machine!.id })} title={`Open ${c.name}`}>
                  <Head c={c} now={now} />
                </button>
              ) : c.daemon ? (
                <button className="board-head-link" onClick={() => go({ view: 'machine', machineId: c.daemon!.id })} title={`Open ${c.name}'s daemon (${c.daemon.id})`}>
                  <Head c={c} health={app.host?.health} now={now} />
                </button>
              ) : (
                <div className="board-head-link">
                  <Head c={c} health={app.host?.health} now={now} />
                </div>
              )}
            </header>
            <Places c={c} now={now} sel={{}} variant="board" go={go} />
          </article>
        ))}
      </div>
    </section>
  );
}
