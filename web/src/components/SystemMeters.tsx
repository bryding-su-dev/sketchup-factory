import { useState, type ReactNode } from 'react';
import type { AccountUsage, AppState, CleanupSummary, HostHealth, HostStats, PlanUsage, SessionInfo, SystemStats, UsageMeter } from '../../../shared/types';
import { memUsed as memUsedOf } from '../../../shared/stats';
import { fmtBytes, fmtClock, fmtCost, fmtRelative, lsGet, lsSet, useNow } from '../util';
import { Icon } from './ui';
import { api } from '../api';
import { attempt, sessionIndex } from '../store';

// The sidebar's footer: the load of every computer and the plan usage of every Claude account, in two
// quiet lines; a tap opens the meters. With machines connected each computer is a name and three mini
// bars (CPU, RAM, GPU), so the footer stays the size it was with the host alone.

export type Lvl = 'ok' | 'warn' | 'crit';
export const level = (pct: number, warn = 75, crit = 90): Lvl => (pct >= crit ? 'crit' : pct >= warn ? 'warn' : 'ok');
const worse = (a: Lvl, b: Lvl): Lvl => (a === 'crit' || b === 'crit' ? 'crit' : a === 'warn' || b === 'warn' ? 'warn' : 'ok');

/** One computer in the footer: the host (always first) or a machine, with its numbers when it has any. */
export interface Computer {
  name: string;
  stats?: HostStats;
  online: boolean;
  host?: boolean;
  /** Its last clean-up pass (server/cleanup.ts). */
  cleanup?: CleanupSummary;
}

export function computersOf(app: AppState): Computer[] {
  const host: Computer[] = app.system ? [{ name: shortHost(app.system.hostname), stats: app.system, online: true, host: true, cleanup: app.host?.health?.lastCleanup }] : [];
  // The host's own daemon (docs/beast-machine.md) is this same computer: the host's line stands for it.
  return [...host, ...app.machines.filter((m) => !m.local).map((m) => ({ name: m.id, stats: app.machineStats?.[m.id], online: m.online, cleanup: m.lastCleanup }))];
}

const shortHost = (h: string) => h.replace(/\.(local|lan|home)$/i, '');

export const ramPct = (s: HostStats) => (memUsedOf(s) / s.memTotalBytes) * 100;
/** RAM's level: its share, raised by the Mac's own memory pressure (the better signal where RAM is also the GPU's). */
export const ramLvl = (s: HostStats) => worse(level(ramPct(s), 85, 95), s.memPressure === 'critical' ? 'crit' : s.memPressure === 'warn' ? 'warn' : 'ok');
/** A discrete GPU: its VRAM in use. Apple Silicon shares RAM, so how busy it is says more. */
export const gpuPct = (s: HostStats) => (!s.gpu ? undefined : s.gpu.unified ? s.gpu.utilPct : (s.gpu.memUsedMiB / s.gpu.memTotalMiB) * 100);

export function describe(c: Computer): string {
  const s = c.stats;
  if (!s) return c.online ? `${c.name}: online, no numbers yet` : `${c.name}: offline`;
  const gpu = !s.gpu
    ? 'GPU n/a'
    : s.gpu.unified
      ? `GPU ${Math.round(s.gpu.utilPct)}% busy (${(s.gpu.memUsedMiB / 1024).toFixed(1)} GB of the shared RAM)`
      : `VRAM ${Math.round(gpuPct(s)!)}% (${(s.gpu.memUsedMiB / 1024).toFixed(1)} of ${(s.gpu.memTotalMiB / 1024).toFixed(0)} GB), GPU ${Math.round(s.gpu.utilPct)}%`;
  return [
    `${c.name} · ${s.cpuModel} x${s.cpuCount}`,
    `CPU ${Math.round(s.loadPct)}%`,
    `RAM ${Math.round(ramPct(s))}% (${fmtBytes(memUsedOf(s))} of ${fmtBytes(s.memTotalBytes)})${s.memPressure ? `, pressure ${s.memPressure}` : ''}`,
    gpu,
    s.diskFreeBytes !== undefined ? `Disk ${fmtBytes(s.diskFreeBytes)} free` : '',
    c.cleanup ? `Last clean-up ${fmtClock(c.cleanup.at)}: ${fmtBytes(c.cleanup.freedBytes ?? 0)} freed (${c.cleanup.removed} item(s))` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

// ---------------------------------------------------------------- accounts

/** The account a session runs on, where the server knows it and there is more than one to tell apart. */
export const accountOf = (app: AppState, sessionId: string) => (app.accounts && app.accounts.length > 1 ? app.accounts.find((a) => a.sessionIds.includes(sessionId)) : undefined);

/** A few characters that tell accounts apart: "…9AAA", or a login's name before the @. */
export function accountTag(a: AccountUsage): string {
  if (a.kind === 'token') return a.label.slice(a.label.indexOf('…'));
  return (a.email ?? a.label).split('@')[0].slice(0, 10);
}

const isLive = (s: SessionInfo | undefined) => !!s && s.status !== 'stopped' && s.status !== 'error';

/** The plan cell: the account closest to its weekly limit, with its hottest other window, and how many more there are. */
function planGlance(app: AppState): { weekly?: UsageMeter; hot?: UsageMeter; tag?: string; more: number; title: string } {
  const accounts = app.accounts;
  if (!accounts) {
    const u = app.usage;
    return { weekly: u?.available ? u.weekly : undefined, hot: hottest(u), more: 0, title: 'Claude plan usage' };
  }
  const known = accounts.filter((a) => a.usage?.available && a.usage.weekly);
  const top = known.sort((a, b) => b.usage!.weekly!.percent - a.usage!.weekly!.percent)[0];
  const title = accounts.map((a) => `${a.label}: ${a.usage?.available && a.usage.weekly ? `weekly ${Math.round(a.usage.weekly.percent)}%` : 'unknown'}`).join('\n');
  return { weekly: top?.usage?.weekly, hot: hottest(top?.usage), tag: accounts.length > 1 && top ? accountTag(top) : undefined, more: Math.max(0, accounts.length - 1), title };
}

function hottest(u: PlanUsage | undefined): UsageMeter | undefined {
  if (!u?.available) return undefined;
  return [u.session, ...u.models].filter((m): m is UsageMeter => !!m && m.percent >= 75).sort((a, b) => b.percent - a.percent)[0];
}

// ---------------------------------------------------------------- the footer

export function SystemFooter({ app }: { app: AppState }) {
  const [open, setOpen] = useState(() => lsGet('ffsb.meters') === '1');
  const sys = app.system;
  if (!sys) return null;
  const toggle = () => {
    setOpen(!open);
    lsSet('ffsb.meters', open ? null : '1');
  };
  const computers = computersOf(app);
  const many = computers.length > 1;
  const unityOn = app.sandboxes.filter((s) => s.unity.state !== 'stopped' && s.unity.state !== 'crashed').length;
  // Agents mid-turn on this host are what limits.maxSessions counts (w384: idle ones take no slot); a machine's count toward its own limit.
  const agentsOn = app.sessions.filter((s) => s.kind !== 'orchestrator' && !s.machineId && (s.status === 'running' || s.status === 'starting' || s.status === 'waiting_permission')).length;
  const plan = planGlance(app);
  const short = (label: string) => label.replace(/^Weekly\s+/i, '').replace(/^Session \(5 h\)$/i, '5h');
  const Val = ({ pct, children, warn, crit, lvl }: { pct: number; children: ReactNode; warn?: number; crit?: number; lvl?: Lvl }) => <b className={`lvl-${lvl ?? level(pct, warn, crit)}`}>{children}</b>;
  const vram = gpuPct(sys);
  const hasPlan = !!app.usage || !!app.accounts?.length;
  return (
    <div className={`sys-foot${open ? ' open' : ''}${many ? ' many' : ''}`}>
      {open && (
        <div className="sys-detail">
          {many ? (
            <MachineTable computers={computers} health={app.host?.health} limits={<Limits sys={sys} unityOn={unityOn} agentsOn={agentsOn} />} />
          ) : (
            <Meters sys={sys} health={app.host?.health} limits={<Limits sys={sys} unityOn={unityOn} agentsOn={agentsOn} />} />
          )}
          <CleanupLines computers={computers} />
          {hasPlan && <UsageRefresh />}
          {app.accounts ? <AccountsMeters app={app} /> : app.usage && <PlanMeters usage={app.usage} />}
        </div>
      )}
      <button className="sys-toggle" onClick={toggle} aria-expanded={open} title={many ? 'Every computer and Claude account. Tap for the meters.' : `${sys.cpuModel} · ${sys.cpuCount} threads. Tap for the meters.`}>
        <span className="sys-cells">
            {many && computers.map((c) => <MiniBars key={c.name} c={c} />)}
            {!many && (
              <>
                <span>
                  CPU <Val pct={sys.loadPct}>{Math.round(sys.loadPct)}%</Val>
                </span>
                <span>
                  RAM <Val pct={ramPct(sys)} lvl={ramLvl(sys)}>{Math.round(ramPct(sys))}%</Val>
                </span>
                {vram !== undefined && (
                  <span>
                    {sys.gpu?.unified ? 'GPU' : 'VRAM'} <Val pct={vram}>{Math.round(vram)}%</Val>
                  </span>
                )}
              </>
            )}
            <span>
              Unity <Val pct={(unityOn / sys.limits.maxUnity) * 100} warn={100} crit={101}>{`${unityOn}/${sys.limits.maxUnity}`}</Val>
            </span>
            <span>
              Agents <Val pct={(agentsOn / sys.limits.maxSessions) * 100} warn={100} crit={101}>{`${agentsOn}/${sys.limits.maxSessions}`}</Val>
            </span>
            {hasPlan && (
              <span title={plan.title} data-testid="plan-glance">
                Plan{' '}
                {plan.weekly ? (
                  <>
                    <Val pct={plan.weekly.percent}>{Math.round(plan.weekly.percent)}%</Val>
                    {plan.tag && <span className="plan-tag"> {plan.tag}</span>}
                    {plan.hot && (
                      <>
                        {' · '}
                        {short(plan.hot.label)} <Val pct={plan.hot.percent}>{Math.round(plan.hot.percent)}%</Val>
                      </>
                    )}
                    {plan.more > 0 && <span className="plan-more"> +{plan.more}</span>}
                  </>
                ) : (
                  <b className="lvl-warn">?</b>
                )}
              </span>
            )}
        </span>
        <Icon name="chevron" size={12} />
      </button>
    </div>
  );
}

/** A computer in the collapsed footer: its name and three bars (CPU, RAM, GPU); hover for the numbers. */
function MiniBars({ c }: { c: Computer }) {
  const s = c.stats;
  const bars: [string, number | undefined, Lvl | undefined][] = s
    ? [
        ['CPU', s.loadPct, undefined],
        ['RAM', ramPct(s), ramLvl(s)],
        [s.gpu?.unified ? 'GPU' : 'VRAM', gpuPct(s), undefined],
      ]
    : [];
  const text = describe(c);
  return (
    <span className={`mcell${s ? '' : ' mcell-off'}`} title={text} aria-label={text.replace(/\n/g, ', ')} data-testid={`mcell-${c.name}`}>
      <span className="mname">{c.name}</span>
      {s ? (
        <span className="mbars" aria-hidden>
          {bars.map(([label, pct, lvl]) => (
            <span key={label} className={`mbar lvl-bg-${pct === undefined ? 'none' : (lvl ?? level(pct))}`}>
              <i style={{ height: `${Math.max(pct === undefined ? 0 : 8, Math.min(100, pct ?? 0))}%` }} />
            </span>
          ))}
        </span>
      ) : (
        <span className="moff">{c.online ? '…' : 'off'}</span>
      )}
    </span>
  );
}

function Meter({ label, pct, value, warn = 75, crit = 90, lvl }: { label: string; pct: number; value: string; warn?: number; crit?: number; lvl?: Lvl }) {
  const p = Math.max(0, Math.min(100, pct));
  return (
    <div className={`meter meter-${lvl ?? level(p, warn, crit)}`}>
      <div className="meter-row">
        <span className="meter-label">{label}</span>
        <span className="meter-value">{value}</span>
      </div>
      <div className="meter-bar">
        <i style={{ width: `${p}%` }} />
      </div>
    </div>
  );
}

/** The host alone (no machines): its meters, as before. */
function Meters({ sys, health, limits }: { sys: SystemStats; health?: HostHealth; limits: ReactNode }) {
  const memUsed = memUsedOf(sys);
  return (
    <div className="meters">
      <Meter label="CPU" pct={sys.loadPct} value={`${Math.round(sys.loadPct)}%`} />
      <Meter label="RAM" pct={(memUsed / sys.memTotalBytes) * 100} value={`${fmtBytes(memUsed)} of ${fmtBytes(sys.memTotalBytes)}`} lvl={ramLvl(sys)} />
      {sys.gpu && (
        <Meter
          label={sys.gpu.unified ? 'GPU' : 'VRAM'}
          pct={gpuPct(sys)!}
          value={
            sys.gpu.unified
              ? `${Math.round(sys.gpu.utilPct)}% busy · ${(sys.gpu.memUsedMiB / 1024).toFixed(1)} GB shared`
              : `${(sys.gpu.memUsedMiB / 1024).toFixed(1)} of ${(sys.gpu.memTotalMiB / 1024).toFixed(0)} GB · GPU ${Math.round(sys.gpu.utilPct)}%`
          }
        />
      )}
      <HostDisks sys={sys} health={health} />
      {limits}
    </div>
  );
}

function HostDisks({ sys, health }: { sys: HostStats; health?: HostHealth }) {
  if (health?.disks.length) {
    // The host guard's volumes, coloured by its own levels (hostGuard.warnFreeGB / criticalFreeGB).
    return (
      <>
        {health.disks.map((d) =>
          d.totalBytes !== undefined && d.freeBytes !== undefined ? (
            <Meter
              key={d.path}
              label={`Disk ${d.path.replace(/[\\/]+$/, '')}`}
              pct={((d.totalBytes - d.freeBytes) / d.totalBytes) * 100}
              value={`${fmtBytes(d.freeBytes)} free`}
              lvl={d.level === 'critical' ? 'crit' : d.level}
            />
          ) : (
            <Meter key={d.path} label={`Disk ${d.path.replace(/[\\/]+$/, '')}`} pct={0} value="offline" lvl="crit" />
          ),
        )}
      </>
    );
  }
  if (sys.diskTotalBytes === undefined || sys.diskFreeBytes === undefined) return null;
  return <Meter label="Disk" pct={((sys.diskTotalBytes - sys.diskFreeBytes) / sys.diskTotalBytes) * 100} value={`${fmtBytes(sys.diskFreeBytes)} free`} warn={85} crit={95} />;
}

/** Every computer, one compact row each: a bar and a number per resource. */
function MachineTable({ computers, health, limits }: { computers: Computer[]; health?: HostHealth; limits: ReactNode }) {
  const Cell = ({ pct, text, lvl, title }: { pct?: number; text: string; lvl?: Lvl; title?: string }) => (
    <span className={`mt-cell meter-${pct === undefined ? 'ok' : (lvl ?? level(pct))}`} title={title}>
      <span className="mt-num">{text}</span>
      <span className="meter-bar">
        <i style={{ width: `${Math.max(0, Math.min(100, pct ?? 0))}%` }} />
      </span>
    </span>
  );
  return (
    <div className="meters mtable" role="table" aria-label="Load of every computer">
      <div className="mt-row mt-head" role="row">
        <span />
        <span>CPU</span>
        <span>RAM</span>
        <span>GPU</span>
        <span>Disk</span>
      </div>
      {computers.map((c) => {
        const s = c.stats;
        if (!s)
          return (
            <div key={c.name} className="mt-row mt-off" role="row">
              <span className="mt-name">{c.name}</span>
              <span className="mt-note">{c.online ? 'online, no numbers yet' : 'offline'}</span>
            </div>
          );
        const g = gpuPct(s);
        // The host's disks are the guard's volumes where it has them: the fullest one stands for them all.
        const disks = c.host && health?.disks.length ? health.disks.filter((d) => d.totalBytes && d.freeBytes !== undefined) : [];
        const disk = disks.length
          ? disks.map((d) => ({ used: ((d.totalBytes! - d.freeBytes!) / d.totalBytes!) * 100, free: d.freeBytes!, lvl: (d.level === 'critical' ? 'crit' : d.level) as Lvl })).sort((a, b) => b.used - a.used)[0]
          : s.diskTotalBytes && s.diskFreeBytes !== undefined
            ? { used: ((s.diskTotalBytes - s.diskFreeBytes) / s.diskTotalBytes) * 100, free: s.diskFreeBytes, lvl: level(((s.diskTotalBytes - s.diskFreeBytes) / s.diskTotalBytes) * 100, 85, 95) }
            : undefined;
        return (
          <div key={c.name} className="mt-row" role="row" data-testid={`mrow-${c.name}`} title={describe(c)}>
            <span className="mt-name">{c.name}</span>
            <Cell pct={s.loadPct} text={`${Math.round(s.loadPct)}%`} />
            <Cell pct={ramPct(s)} lvl={ramLvl(s)} text={`${Math.round(ramPct(s))}%`} title={`${fmtBytes(memUsedOf(s))} of ${fmtBytes(s.memTotalBytes)}${s.memPressure ? `, pressure ${s.memPressure}` : ''}`} />
            {g === undefined ? <span className="mt-note">n/a</span> : <Cell pct={g} text={`${Math.round(g)}%`} title={s.gpu?.unified ? 'GPU busy (Apple Silicon shares the RAM)' : 'VRAM in use'} />}
            {disk ? <Cell pct={disk.used} lvl={disk.lvl} text={fmtBytes(disk.free)} title={`${fmtBytes(disk.free)} free`} /> : <span className="mt-note">n/a</span>}
          </div>
        );
      })}
      {limits}
    </div>
  );
}

/** Each computer's last clean-up pass: when, what it freed, and whether free space is still below its soft threshold. */
function CleanupLines({ computers }: { computers: Computer[] }) {
  const now = useNow(60_000);
  const withCleanup = computers.filter((c) => c.cleanup);
  if (!withCleanup.length) return null;
  return (
    <div className="meters cleanup-lines" data-testid="cleanup-lines">
      {withCleanup.map((c) => {
        const x = c.cleanup!;
        return (
          <div key={c.name} className={`plan-asof${x.belowSoft ? ' lvl-warn' : ''}`} title={x.top?.map((t) => `${t.path}: ${fmtBytes(t.bytes)}`).join('\n') || undefined}>
            Clean-up {c.name}: {fmtRelative(x.at, now)}, {fmtBytes(x.freedBytes ?? 0)} freed
            {x.belowSoft && x.freeBytes !== undefined ? ` · only ${fmtBytes(x.freeBytes)} free (soft ${x.softFreeGB} GB)` : ''}
          </div>
        );
      })}
    </div>
  );
}

function Limits({ sys, unityOn, agentsOn }: { sys: SystemStats; unityOn: number; agentsOn: number }) {
  return (
    <div className="limits">
      <span className={unityOn >= sys.limits.maxUnity ? 'at-limit' : ''}>
        Unity editors <b>{unityOn}/{sys.limits.maxUnity}</b>
      </span>
      <span className={agentsOn >= sys.limits.maxSessions ? 'at-limit' : ''}>
        Agents here <b>{agentsOn}/{sys.limits.maxSessions}</b>
      </span>
    </div>
  );
}

/**
 * Poll every Claude account's usage now (they are polled every config usagePollMinutes, default 15): here and on each
 * connected machine. The numbers arrive by themselves; each account's "as of" says when.
 */
function UsageRefresh() {
  const [busy, setBusy] = useState(false);
  const refresh = async () => {
    setBusy(true);
    await attempt(api.refreshUsage());
    // A poll takes a few seconds (a minute at most); the button stays quiet meanwhile.
    setTimeout(() => setBusy(false), 5_000);
  };
  return (
    <div className="plan-refresh">
      <button className="btn btn-ghost btn-sm" onClick={() => void refresh()} disabled={busy} title="Ask every Claude account for its usage now, here and on each machine" data-testid="usage-refresh">
        <Icon name="refresh" size={12} /> {busy ? 'Refreshing…' : 'Refresh usage'}
      </button>
    </div>
  );
}

/** Every Claude account in use: who it is, where it is used, which agents run on it, its limits. */
function AccountsMeters({ app }: { app: AppState }) {
  const sessions = sessionIndex(app.sessions);
  return (
    <>
      {app.accounts!.map((a) => {
        const live = a.sessionIds.map((id) => sessions.get(id)).filter(isLive);
        return (
          <PlanMeters
            key={a.id}
            usage={a.usage}
            head={
              <div className="acct-head" data-testid={`account-${accountTag(a)}`}>
                <span className="acct-label">{a.label}</span>
                <span className="acct-agents">{live.length === 1 ? '1 agent' : `${live.length} agents`}</span>
                <div className="acct-where">{a.where.join(' · ')}</div>
              </div>
            }
          />
        );
      })}
    </>
  );
}

/** One account's plan limits (server/usage.ts): weekly first, then the 5-hour session and per-model weekly windows. */
function PlanMeters({ usage: u, head }: { usage?: PlanUsage; head?: ReactNode }) {
  const now = useNow(60_000);
  if (!u) {
    return (
      <div className="meters plan-meters">
        {head}
        <div className="plan-asof">not fetched yet</div>
      </div>
    );
  }
  const asOf = `as of ${fmtClock(u.asOf)}${u.error ? ' (refresh failed)' : ''}`;
  if (!u.available) {
    return (
      <div className="meters plan-meters" title={u.why}>
        {head}
        <div className="meter-row">
          <span className="meter-label">Claude plan</span>
          <span className="meter-value">unavailable</span>
        </div>
        {u.why && <div className="plan-asof">{u.why}</div>}
        {u.spendWeekUsd !== undefined && (
          <div className="meter-row" title="What SketchUp Factory's own agents cost over the last 7 days, from their reported cost. This is spend, not the plan's usage limit.">
            <span className="meter-label">Portal spend, 7 days</span>
            <span className="meter-value">{fmtCost(u.spendWeekUsd)}</span>
          </div>
        )}
        <div className="plan-asof">{asOf}</div>
      </div>
    );
  }
  const rows = [u.weekly, u.session, ...u.models].filter((m): m is UsageMeter => !!m);
  return (
    <div className="meters plan-meters" title={`Claude ${u.plan ?? ''} plan usage limits, from ${u.source ? `the API's ${u.source}` : 'the claude.ai usage endpoint'}`}>
      {head}
      {rows.map((m) => (
        <Meter key={m.label} label={m.label} pct={m.percent} value={`${Math.round(m.percent)}%${m.resetsAt ? ` · ${resetLabel(m.resetsAt, now)}` : ''}`} />
      ))}
      <div className="plan-asof">
        Claude {u.plan ?? 'plan'} · {asOf}
        {u.source ? ` · from ${u.source}` : ''}
      </div>
    </div>
  );
}

function resetLabel(iso: string, now: number): string {
  const t = Date.parse(iso);
  if (isNaN(t)) return '';
  const h = (t - now) / 3_600_000;
  if (h <= 0) return 'resetting';
  if (h < 1) return `resets in ${Math.max(1, Math.round(h * 60))}m`;
  if (h < 24) return `resets in ${Math.round(h)}h`;
  const d = new Date(t);
  return `resets ${d.toLocaleDateString([], { weekday: 'short' })} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}
