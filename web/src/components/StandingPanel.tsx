import { useState } from 'react';
import type { AppState, DelegationRequest, StandingAgent, StandingRun } from '../../../shared/types';
import { STANDING_TOOL_GROUPS } from '../../../shared/types';
import { api } from '../api';
import { attempt, toast } from '../store';
import {
  describeTrigger,
  displayName,
  fmtClock,
  fmtCost,
  fmtDuration,
  fmtRelative,
  fmtUntil,
  headline,
  lastRun,
  navigate,
  outcomeLabel,
  outcomeTone,
  spentToday,
  standingLabel,
  standingTone,
  useNow,
} from '../util';
import { Markdown } from './Markdown';
import { SessionView } from './SessionView';
import { StandingAgentModal } from './StandingModal';
import { Chip, Confirm, CopyButton, Dot, Icon } from './ui';
import { useKeepScroll } from '../scrollKeep';

type Tab = 'runs' | 'conversation' | 'delegations';

export function StandingPanel({ app, agent, tab, onClose }: { app: AppState; agent: StandingAgent; tab?: string; onClose?: () => void }) {
  const now = useNow(10000);
  const [edit, setEdit] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const session = app.sessions.find((s) => s.id === agent.sessionId);
  const delegations = app.delegations.filter((d) => d.agentId === agent.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const pendingDelegations = delegations.filter((d) => d.status === 'pending').length;
  const current: Tab = tab === 'conversation' || tab === 'delegations' ? tab : 'runs';
  const setTab = (t: Tab) => navigate({ view: 'agent', agentId: agent.id, tab: t === 'runs' ? undefined : t }, true);

  const act = async (p: Promise<{ note?: string } | unknown>) => {
    setBusy(true);
    const r = await attempt(p);
    setBusy(false);
    const note = (r as { note?: string } | undefined)?.note;
    if (note) toast(note);
  };

  const active = agent.state === 'running' || agent.state === 'waiting';
  const spent = spentToday(agent);
  const pct = Math.min(100, (spent / agent.budget.perDayUsd) * 100);
  const last = lastRun(agent);

  return (
    <section className="sb-panel sa-panel">
      <header className="sb-head">
        <div className="sb-head-top">
          {onClose && (
            <button className="btn btn-ghost btn-icon" onClick={onClose} title="Close" aria-label="Close">
              <Icon name="back" />
            </button>
          )}
          <Dot tone={standingTone(agent)} pulse={active} />
          <h2 className="ellipsis">{agent.name}</h2>
          <span className="dim small hide-sm">standing agent</span>
          <div className="spacer" />
          <button className="btn btn-ghost btn-icon" title="Edit" aria-label="Edit" onClick={() => setEdit(true)}>
            <Icon name="edit" />
          </button>
          <button className="btn btn-ghost btn-icon danger-hover" title="Delete agent" aria-label="Delete agent" onClick={() => setConfirmDelete(true)}>
            <Icon name="trash" />
          </button>
        </div>
        <p className="sb-head-purpose sa-charter" title={agent.charter}>
          {agent.charter}
        </p>
        <div className="sb-facts">
          <span className="fact fact-wrap">
            <Icon name="clock" size={13} />
            <span>
              {describeTrigger(agent.trigger)} · {agent.model}
              {agent.machineId && ` · on ${agent.machineId}`}
              {agent.autoApprove?.enabled && (
                <span className="tone-blue" title={`Delegations start without you: ${agent.autoApprove.model}, ${agent.autoApprove.effort} effort, ${agent.autoApprove.maxPerRun}/run, ${agent.autoApprove.maxPerDay}/day`}>
                  {' '}
                  · auto-approves {agent.autoApprove.maxPerDay}/day
                </span>
              )}
              {' · '}
              {agent.tools.length ? agent.tools.map((g) => STANDING_TOOL_GROUPS.find((x) => x.value === g)?.label ?? g).join(', ') : 'read-only'}
            </span>
          </span>
          <span className="fact mono">
            <Icon name="folder" size={13} /> <span className="ellipsis">{agent.folder}</span>
            <CopyButton text={agent.folder} label="Copy folder" />
          </span>
        </div>
        <div className="unity-bar">
          <Chip tone={standingTone(agent)} title={agent.stateDetail}>
            {standingLabel[agent.state]}
          </Chip>
          <span className="dim small ellipsis">
            {agent.state === 'waiting'
              ? agent.stateDetail
              : agent.state === 'running'
                ? `since ${fmtRelative(agent.runs.at(-1)?.startedAt, now).replace(' ago', '')}`
                : agent.nextRunAt
                  ? `next run ${fmtUntil(agent.nextRunAt, now)} (${fmtClock(agent.nextRunAt)})`
                  : agent.enabled
                    ? 'runs when started by hand'
                    : 'no scheduled runs'}
          </span>
          <div className="spacer" />
          {active ? (
            <button className="btn btn-sm btn-stop" disabled={busy} onClick={() => act(api.stopStanding(agent.id))}>
              <Icon name="stop" size={13} /> {agent.state === 'waiting' ? 'Cancel' : 'Stop run'}
            </button>
          ) : (
            <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => act(api.runStanding(agent.id))}>
              <Icon name="play" size={13} /> Run now
            </button>
          )}
          <button className="btn btn-sm btn-outline" disabled={busy} onClick={() => act(api.pauseStanding(agent.id, agent.enabled))}>
            <Icon name={agent.enabled ? 'pause' : 'play'} size={13} /> {agent.enabled ? 'Pause' : 'Resume'}
          </button>
        </div>
        <div className={`meter sa-budget meter-${pct >= 100 ? 'crit' : pct >= 75 ? 'warn' : 'ok'}`}>
          <div className="meter-row">
            <span className="meter-label">Today</span>
            <span className="meter-value mono">
              {fmtCost(spent)} of ${agent.budget.perDayUsd.toFixed(2)} · max ${agent.budget.perRunUsd.toFixed(2)}/run, {agent.budget.maxMinutes} min
            </span>
          </div>
          <div className="meter-bar">
            <i style={{ width: `${pct}%` }} />
          </div>
        </div>
      </header>

      <nav className="tabs" role="tablist">
        <button role="tab" aria-selected={current === 'runs'} className={`tab${current === 'runs' ? ' active' : ''}`} onClick={() => setTab('runs')}>
          Runs <span className="dim">{agent.runs.length}</span>
        </button>
        <button role="tab" aria-selected={current === 'conversation'} className={`tab${current === 'conversation' ? ' active' : ''}`} onClick={() => setTab('conversation')}>
          Conversation
        </button>
        <button role="tab" aria-selected={current === 'delegations'} className={`tab${current === 'delegations' ? ' active' : ''}`} onClick={() => setTab('delegations')}>
          Delegations {pendingDelegations > 0 ? <span className="badge badge-amber">{pendingDelegations}</span> : <span className="dim">{delegations.length}</span>}
        </button>
      </nav>

      {current === 'runs' && <Runs agent={agent} last={last} now={now} />}
      {current === 'conversation' &&
        (session ? (
          <SessionView key={session.id} session={session} />
        ) : (
          <div className="panel-empty">
            <p>No conversation yet.</p>
          </div>
        ))}
      {current === 'delegations' && <Delegations list={delegations} now={now} app={app} />}

      {edit && <StandingAgentModal app={app} agent={agent} onClose={() => setEdit(false)} />}
      {confirmDelete && (
        <Confirm
          title={`Delete ${agent.name}?`}
          danger
          confirmLabel="Delete agent"
          body={
            <>
              <p>Stops any run in progress and removes the agent, its schedule and its conversation.</p>
              <p className="dim">
                Its folder <code>{agent.folder}</code> (with NOTES.md) is left on disk.
              </p>
            </>
          }
          onConfirm={async () => {
            const ok = await attempt(api.deleteStanding(agent.id));
            if (ok !== undefined) navigate({ view: 'home' });
          }}
          onClose={() => setConfirmDelete(false)}
        />
      )}
    </section>
  );
}

function Runs({ agent, last, now }: { agent: StandingAgent; last: StandingRun | undefined; now: number }) {
  const keep = useKeepScroll(`agent:${agent.id}:runs`);
  const [open, setOpen] = useState<string | null>(null);
  if (!agent.runs.length) {
    return (
      <div className="panel-empty">
        <Icon name="clock" size={28} />
        <p>No runs yet.</p>
      </div>
    );
  }
  const history = [...agent.runs].reverse();
  return (
    <div className="sa-scroll" ref={keep}>
      {last && (
        <div className="sa-last">
          <div className="sa-last-head">
            <Chip tone={outcomeTone(last.outcome)}>{outcomeLabel[last.outcome]}</Chip>
            <span className="dim small">
              last run {fmtRelative(last.endedAt ?? last.startedAt ?? last.dueAt, now)} · {last.trigger}
              {last.requestedBy && last.trigger !== 'schedule' ? ` by ${last.requestedBy.displayName}` : ''} · {fmtCost(last.costUsd)}
              {last.startedAt && last.endedAt ? ` · ${fmtDuration(Date.parse(last.endedAt) - Date.parse(last.startedAt))}` : ''}
            </span>
          </div>
          {last.summary ? <Markdown text={last.summary} /> : <p className="dim small">{last.outcome === 'running' ? 'Working…' : 'No summary.'}</p>}
        </div>
      )}
      <div className="section-head sa-history-head">
        <span>History</span>
        <span className="count">{agent.runs.length}</span>
      </div>
      <div className="run-list">
        {history.map((r) => (
          <div key={r.id} className={`run-row${open === r.id ? ' open' : ''}`}>
            <button className="run-row-top" onClick={() => setOpen(open === r.id ? null : r.id)} aria-expanded={open === r.id}>
              <Dot tone={outcomeTone(r.outcome)} pulse={r.outcome === 'running'} title={outcomeLabel[r.outcome]} />
              <span className="run-when mono" title={new Date(r.startedAt ?? r.dueAt).toLocaleString()}>
                {new Date(r.startedAt ?? r.dueAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
              </span>
              <span className={`run-outcome tone-${outcomeTone(r.outcome)}`}>{outcomeLabel[r.outcome]}</span>
              <span className="run-headline ellipsis">
                {r.requestedBy && r.trigger !== 'schedule' ? <span className="dim">{r.requestedBy.displayName}: </span> : null}
                {headline(r.summary)}
              </span>
              <span className="run-cost mono dim">{r.outcome === 'skipped' ? '' : fmtCost(r.costUsd)}</span>
            </button>
            {open === r.id && r.summary && (
              <div className="run-detail">
                <Markdown text={r.summary} />
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function Delegations({ list, now, app }: { list: DelegationRequest[]; now: number; app: AppState }) {
  const keep = useKeepScroll('agent:delegations');
  const where = (d: DelegationRequest) => {
    const sb = d.sandboxId ? app.sandboxes.find((x) => x.id === d.sandboxId) : undefined;
    const m = d.machineId ? app.machines.find((x) => x.id === d.machineId) : undefined;
    return sb ? displayName(sb) : m ? displayName(m) : (d.sandboxId ?? d.machineId ?? '');
  };
  const [busy, setBusy] = useState<string | null>(null);
  if (!list.length) {
    return (
      <div className="panel-empty">
        <p>No delegation requests.</p>
        <p className="dim small">With the Delegate tool group, this agent can ask for a worker in an unused sandbox. Requests wait here for you.</p>
      </div>
    );
  }
  const decide = async (d: DelegationRequest, approve: boolean) => {
    setBusy(d.id);
    const r = await attempt(api.decideDelegation(d.id, approve));
    setBusy(null);
    if (r && approve && (r.sandboxId || r.machineId)) toast(`Worker started in ${where(r)}`);
  };
  return (
    <div className="sa-scroll" ref={keep}>
      {list.map((d) => (
        <div key={d.id} className={`deleg deleg-${d.status}`}>
          <div className="deleg-head">
            <Chip tone={d.status === 'pending' ? 'amber' : d.status === 'approved' ? 'green' : d.status === 'expired' ? 'red' : 'grey'}>{d.status}</Chip>
            {d.autoApproved && <span className="chip chip-blue">auto-approved</span>}
            {d.approvedBy && (
              <span className="chip" data-testid="deleg-approved-by">
                approved by {d.approvedBy.displayName}
              </span>
            )}
            {d.status === 'pending' && d.auto === 'queued' && (
              <span className="chip chip-blue" title="Starts by itself when a sandbox or machine frees up">
                auto · queued until {d.expiresAt ? new Date(d.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '?'}
              </span>
            )}
            <strong className="ellipsis">{d.title}</strong>
            <span className="spacer" />
            <span className="dim small">{fmtRelative(d.createdAt, now)}</span>
          </div>
          <Markdown text={d.task} />
          {d.status === 'pending' && (
            <div className="deleg-actions">
              <button className="btn btn-sm btn-outline" disabled={busy === d.id} onClick={() => decide(d, false)}>
                Reject
              </button>
              <button className="btn btn-sm btn-primary" disabled={busy === d.id} onClick={() => decide(d, true)}>
                Approve: start a worker
              </button>
            </div>
          )}
          {d.status === 'approved' && (d.sandboxId || d.machineId) && (
            <button
              className="link-btn small"
              onClick={() =>
                navigate(d.sandboxId ? { view: 'sandbox', sandboxId: d.sandboxId, sessionId: d.sessionId } : { view: 'machine', machineId: d.machineId!, sessionId: d.sessionId })
              }
            >
              Open the worker in {where(d)}
              {d.model ? ` (${d.model}${d.effort ? `, ${d.effort}` : ''})` : ''}
            </button>
          )}
          {d.log?.length ? (
            <details className="deleg-log">
              <summary className="dim small">Log · {d.log.at(-1)}</summary>
              <pre className="code">{d.log.join('\n')}</pre>
            </details>
          ) : null}
          {d.note && <p className="dim small">Note: {d.note}</p>}
        </div>
      ))}
    </div>
  );
}
