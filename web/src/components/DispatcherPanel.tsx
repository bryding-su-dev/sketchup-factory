import { useEffect, useState } from 'react';
import type { AppState, IntakeSummary, WorkItem, WorkSource } from '../../../shared/types';
import { api } from '../api';
import { isMine, ledgerOrder } from '../../../shared/workOrder';
import { sessionRoute } from '../attention';
import { attempt, reloadTranscript, sessionsByIds } from '../store';
import { dispatcherGlance, fmtCost, fmtRelative, isBusy, isOpenWork, navigate, useNow, workLabel, workTone } from '../util';
import { Markdown } from './Markdown';
import { SessionView } from './SessionView';
import { accountOf } from './SystemMeters';
import { Chip, Confirm, Dot, Icon, Menu } from './ui';
import { TimersButton } from './Timers';

type Tab = 'requests' | 'intake' | 'conversation';

const names = (w: WorkItem) => w.requesters.map((r) => r.displayName).join(', ');

/** "Discord bug", "Discord request", "FFBox branch", …: where an intake request came from (docs/intake.md). */
export function sourceLabel(s: WorkSource): string {
  switch (s.kind) {
    case 'discord-bug':
      return 'Discord bug';
    case 'discord-request':
      return `Discord request${s.reporter ? ` from ${s.reporter}` : ''}`;
    case 'ffbox-branch':
      return 'FFBox branch';
    case 'ffbox-diagnosis':
      return 'FFBox diagnosis';
    case 'ffbox-request':
      return 'FFBox request';
    case 'release':
      return 'Release follow-up';
    case 'nightly':
      return `Nightly e2e${s.nightly?.date ? ` ${s.nightly.date}` : ''}`;
  }
}

const pendingApproval = (w: WorkItem) => w.approval?.state === 'pending' && isOpenWork(w);

/** The triage in two words: "obvious bug", "needs a human", "asked by a person", "follow-up". */
export const triageLabel: Record<NonNullable<WorkItem['triage']>['class'], string> = {
  'obvious-bug': 'obvious bug',
  'needs-human': 'needs a human',
  person: 'asked by a person',
  'follow-up': 'follow-up',
  regression: 'nightly regression',
};

/** What a pending intake request waits for, as its status reads. */
const waitingLabel = (w: WorkItem) => (w.triage?.class === 'needs-human' ? 'Needs a human' : 'Awaiting approval');

/**
 * The dispatcher (docs/orchestrators.md): the ledger of everyone's requests with what was decided and who works on
 * them, the intake from Discord and FFBox (docs/intake.md), and its conversation, which only the owner writes to.
 * `tab`: "intake", "conversation", or a request id to open.
 */
export function DispatcherPanel({ app, tab, onClose }: { app: AppState; tab?: string; onClose?: () => void }) {
  const now = useNow(15_000);
  const [confirmReset, setConfirmReset] = useState(false);
  const session = app.sessions.find((s) => s.id === app.dispatcherId);
  // Open requests first (questions, new, queued, active), then the closed ones; the viewer's own first within each (shared/workOrder.ts).
  const work = ledgerOrder(app.work ?? [], app.me?.userId);
  const open = work.filter(isOpenWork);
  const closed = work.filter((w) => !isOpenWork(w));
  const current: Tab = tab === 'conversation' ? 'conversation' : tab === 'intake' ? 'intake' : 'requests';
  const focus = tab && /^w\d+$/.test(tab) ? tab : undefined;
  const setTab = (t: Tab) => navigate({ view: 'dispatcher', tab: t === 'requests' ? undefined : t }, true);
  const owner = app.me?.role === 'owner';
  const glance = dispatcherGlance(session, open, app.me?.userId);
  const account = session ? accountOf(app, session.id) : undefined;
  const waiting = work.filter((w) => w.source && pendingApproval(w)).length;

  return (
    <section className="sb-panel sa-panel dispatcher-panel">
      <header className="sb-head">
        <div className="sb-head-top">
          {onClose && (
            <button className="btn btn-ghost btn-icon" onClick={onClose} title="Close" aria-label="Close">
              <Icon name="back" />
            </button>
          )}
          <Dot tone={glance.tone} pulse={isBusy(session)} />
          <h2 className="ellipsis">Dispatcher</h2>
          <div className="spacer" />
          {owner && session && <TimersButton sessionId={session.id} label="Dispatcher" />}
          {owner && session && (
            <Menu label="Dispatcher options">
              {(close) => (
                <>
                  <button
                    className="menu-item"
                    onClick={() => {
                      close();
                      setConfirmReset(true);
                    }}
                  >
                    <Icon name="plus" size={15} /> New conversation…
                  </button>
                  <div className="menu-foot">
                    {session.model ?? 'default model'}
                    {account ? ` on ${account.label}` : ''} · {fmtCost(session.costUsd)} over {session.turns} turns · active {fmtRelative(session.lastActivityAt, now)}
                  </div>
                </>
              )}
            </Menu>
          )}
        </div>
        <p className="sb-head-purpose">Everyone’s requests for work, what was decided, and who is on them.</p>
      </header>

      <nav className="tabs" role="tablist">
        <button role="tab" aria-selected={current === 'requests'} className={`tab${current === 'requests' ? ' active' : ''}`} onClick={() => setTab('requests')}>
          Requests <span className="dim">{open.length}</span>
        </button>
        {app.intake && (
          <button role="tab" aria-selected={current === 'intake'} className={`tab${current === 'intake' ? ' active' : ''}`} onClick={() => setTab('intake')}>
            Intake {waiting > 0 && <span className="tone-amber" title="Needs a human">{waiting}</span>}
          </button>
        )}
        <button role="tab" aria-selected={current === 'conversation'} className={`tab${current === 'conversation' ? ' active' : ''}`} onClick={() => setTab('conversation')}>
          Conversation
        </button>
      </nav>

      {current === 'requests' && <Requests app={app} open={open} closed={closed} focus={focus} now={now} />}
      {current === 'intake' && app.intake && <IntakeTab app={app} intake={app.intake} work={work} now={now} />}
      {current === 'conversation' &&
        (session ? (
          <SessionView key={session.id} session={session} embedded readOnly={owner ? undefined : 'Only the owner writes to the dispatcher. To ask for work, write to your own orchestrator.'} />
        ) : (
          <div className="panel-empty">
            <p>No dispatcher yet.</p>
          </div>
        ))}

      {confirmReset && (
        <Confirm
          title="Start the dispatcher afresh?"
          confirmLabel="New conversation"
          body="The dispatcher forgets its conversation. The requests, sandboxes and agents all stay, and it is told which requests still wait for it."
          onConfirm={async () => {
            const ok = await attempt(api.resetOrchestrator('dispatcher'));
            if (ok !== undefined) reloadTranscript(ok.id);
          }}
          onClose={() => setConfirmReset(false)}
        />
      )}
    </section>
  );
}

function Requests({ app, open, closed, focus, now }: { app: AppState; open: WorkItem[]; closed: WorkItem[]; focus?: string; now: number }) {
  const [expanded, setExpanded] = useState<string | null>(focus ?? null);
  const [showClosed, setShowClosed] = useState(() => !!focus && closed.some((w) => w.id === focus));
  useEffect(() => {
    if (!focus) return;
    setExpanded(focus);
    if (closed.some((w) => w.id === focus)) setShowClosed(true);
    requestAnimationFrame(() => document.getElementById(`work-${focus}`)?.scrollIntoView({ block: 'nearest' }));
    // The focus comes from a link (a notice in a chat): open it once, then leave the rows to the user.
  }, [focus]);

  if (!open.length && !closed.length) {
    return (
      <div className="panel-empty">
        <Icon name="inbox" size={28} />
        <p>No requests yet.</p>
        <p className="dim small">When someone asks their orchestrator for work, the request shows here with what the dispatcher decided.</p>
      </div>
    );
  }
  const row = (w: WorkItem) => <WorkRow key={w.id} app={app} w={w} open={expanded === w.id} onToggle={() => setExpanded(expanded === w.id ? null : w.id)} now={now} />;
  return (
    <div className="sa-scroll">
      {open.length ? <div className="run-list">{open.map(row)}</div> : <p className="dim small ledger-none">Nothing open.</p>}
      {closed.length > 0 && (
        <>
          <button className="link-btn small ledger-closed" onClick={() => setShowClosed(!showClosed)} aria-expanded={showClosed}>
            {showClosed ? 'Hide closed' : `${closed.length} closed`}
          </button>
          {showClosed && <div className="run-list">{closed.map(row)}</div>}
        </>
      )}
    </div>
  );
}

const onOff = (on: boolean) => (on ? 'on' : 'off');

/**
 * The intake (docs/intake.md): what is switched on, today's numbers, the Discord and FFBox requests waiting for a
 * person's approval (Approve / Decline), those already in the ledger with their state and how the fix reaches players,
 * and what the intake saw lately. The settings are config.json's; this page only shows them.
 */
function IntakeTab({ app, intake: s, work, now }: { app: AppState; intake: IntakeSummary; work: WorkItem[]; now: number }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const items = work.filter((w) => w.source);
  const pending = items.filter(pendingApproval);
  const reviewer = !!app.me && s.reviewerIds.some((id) => id.toLowerCase() === app.me!.userId.toLowerCase());
  const rest = items.filter((w) => !pendingApproval(w));
  const anyOn = s.discord.enabled || s.ffbox.enabled || s.release.enabled || !!s.nightly?.enabled;
  const act = async (id: string, f: () => Promise<unknown>) => {
    setBusy(id);
    await attempt(f());
    setBusy(null);
  };
  const row = (w: WorkItem) => <WorkRow key={w.id} app={app} w={w} open={expanded === w.id} onToggle={() => setExpanded(expanded === w.id ? null : w.id)} now={now} />;
  const d = s.discord;
  const f = s.ffbox;
  const n = s.nightly;
  return (
    <div className="sa-scroll intake-tab" data-testid="intake-tab">
      <section className="intake-settings" data-testid="intake-settings">
        <div className="intake-source">
          <Chip tone={d.enabled ? 'green' : 'grey'}>Discord {onOff(d.enabled)}</Chip>
          <span className="dim small">
            bug reports from {d.bugChannels.map((c) => `#${c.replace(/_/g, '-')}`).join(', ') || 'no channel'}{d.ffboxOwned?.length ? ` (${d.ffboxOwned.map((c) => `#${c.replace(/_/g, '-')}`).join(', ')}: FFBox's, never filed from)` : ''}; requests to Max in {d.requestChannels.map((c) => `#${c.replace(/_/g, '-')}`).join(', ') || 'no channel'} from {d.trustedPeople.length ? d.trustedPeople.join(', ') : 'nobody trusted yet'}; at most {d.dailyCap} a day, {d.perReporterPerDay} per reporter; auto-approve {d.autoApprove.enabled ? `on, ${d.autoApprove.maxPerDay} a day${!d.autoApprove.bugs ? ', not bug reports' : ''}${!d.autoApprove.requests ? ', not requests' : ''}` : 'off'}
            {d.polledAt ? `; checked ${fmtRelative(d.polledAt, now)}` : ''}
          </span>
        </div>
        <div className="intake-source">
          <Chip tone={f.enabled ? 'green' : 'grey'}>FFBox {onOff(f.enabled)}</Chip>
          <span className="dim small">
            fix branches {onOff(f.branches)}, diagnoses {onOff(f.diagnoses)}, its own requests {onOff(f.requests)}, its ledger check {onOff(f.boardCheck)}, sending it work {onOff(f.sendWork)}; at most {f.dailyCap} a day; auto-approve {f.autoApprove.enabled ? `on, ${f.autoApprove.maxPerDay} a day` : 'off'}
          </span>
        </div>
        <div className="intake-source">
          <Chip tone={s.release.enabled ? 'green' : 'grey'}>Release follow-ups {onOff(s.release.enabled)}</Chip>
          <span className="dim small">
            a “live in {s.release.lastVersion ?? '<version>'}” reply {s.release.delayMinutes} min after the release that carries each fix{s.release.checkedAt ? `; checked ${fmtRelative(s.release.checkedAt, now)}` : ''}
          </span>
        </div>
        {n && (
          <div className="intake-source">
            <Chip tone={n.enabled ? 'green' : 'grey'}>Nightly e2e {onOff(n.enabled)}</Chip>
            <span className="dim small">
              new regressions, and scenarios flaky {n.flakyNights} nights running, from the lab's report; more than {n.batchOver} in a night become one request; at most {n.dailyCap} a day; auto-approve {n.autoApprove.enabled ? `on, ${n.autoApprove.maxPerDay} a day` : 'off'}
              {n.last ? `; last report ${n.last.date} from ${n.last.lab} (develop ${n.last.sha.slice(0, 9)}): ${n.last.filed} filed, ${n.last.attached} added to open requests, ${n.last.skipped} skipped` : ''}
            </span>
          </div>
        )}
        <p className="dim small">
          Today: {s.today.filed} filed, {s.today.autoApproved} auto-approved, {s.today.skipped} skipped, {s.today.pending} need a human. Reviewers (approve, decline, answer design questions): {s.reviewers.join(', ') || 'the owner'}. Only obvious bugs and nightly regressions are ever worked without them, and only with their auto-approve on.{' '}
          {anyOn ? 'Settings live in config.json, "intake".' : 'Everything is off: switch it on in config.json, "intake" (docs/intake.md).'}
        </p>
        {d.error && <p className="small tone-red">Last problem: {d.error}</p>}
        {d.enabled && (
          <button className="btn btn-sm btn-outline" disabled={busy === 'poll'} onClick={() => void act('poll', () => api.intakePoll())}>
            <Icon name="refresh" size={14} /> Check Discord now
          </button>
        )}
      </section>

      <h3 className="intake-h">Needs a human</h3>
      <p className="dim small ledger-none">
        Player reports that are not obvious bugs, design questions and FFBox work wait here. Nothing is worked until {s.reviewers.join(' or ') || 'a reviewer'} approves it (then the dispatcher decides it like any request) or declines it.
      </p>
      {pending.length ? (
        <div className="run-list">
          {pending.map((w) => (
            <div key={w.id} className="intake-pending">
              {row(w)}
              <div className="intake-actions">
                <span className="dim small">{w.approval?.why}</span>
                <div className="spacer" />
                {reviewer ? (
                  <>
                    <button className="btn btn-sm btn-primary" disabled={busy === w.id} onClick={() => void act(w.id, () => api.approveWork(w.id))}>
                      Approve {w.id}
                    </button>
                    <button className="btn btn-sm btn-ghost" disabled={busy === w.id} onClick={() => void act(w.id, () => api.declineWork(w.id))}>
                      Decline
                    </button>
                  </>
                ) : (
                  <span className="dim small">{s.reviewers.join(' or ')} decides</span>
                )}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="dim small ledger-none">Nothing needs a human.</p>
      )}

      <h3 className="intake-h">In the ledger</h3>
      {rest.length ? <div className="run-list">{rest.map(row)}</div> : <p className="dim small ledger-none">No Discord or FFBox requests yet.</p>}

      {s.recent.length > 0 && (
        <details className="deleg-log intake-recent">
          <summary className="dim small">What the intake saw lately · {s.recent.length}</summary>
          <ul className="intake-log">
            {s.recent.map((e, i) => (
              <li key={`${e.at}-${i}`} className="small">
                <span className="mono dim">{fmtRelative(e.at, now)}</span> <span className={e.action === 'filed' ? 'tone-green' : e.action === 'skipped' ? 'tone-amber' : 'dim'}>{e.action}</span> {e.title}
                {e.workId ? <span className="mono"> {e.workId}</span> : null}
                {e.why ? <span className="dim"> ({e.why})</span> : null}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/** How an intake fix is reaching players: landed, replied in Discord, thread closed, released. */
function deliveryLine(w: WorkItem): string {
  const d = w.delivery;
  if (!d) return '';
  return [d.fixCommit && `fix ${d.fixCommit.slice(0, 10)}`, d.landedAt && 'on develop', d.repliedAt && 'replied in Discord', d.closedAt && 'thread closed', d.releasedIn && `live in ${d.releasedIn}`, d.announcedBy && `follow-up ${d.announcedBy}`].filter(Boolean).join(' · ');
}

function WorkRow({ app, w, open, onToggle, now }: { app: AppState; w: WorkItem; open: boolean; onToggle: () => void; now: number }) {
  const workers = sessionsByIds(app.sessions, w.sessionIds);
  const working = workers.some(isBusy);
  const tone = w.approval?.state === 'pending' && isOpenWork(w) ? 'amber' : workTone(w.status);
  const s = w.source;
  const delivery = deliveryLine(w);
  return (
    <div id={`work-${w.id}`} className={`run-row work-row${open ? ' open' : ''}`} data-testid={`work-${w.id}`}>
      <button className="run-row-top" onClick={onToggle} aria-expanded={open}>
        <Dot tone={tone} pulse={w.status === 'active' && working} title={workLabel[w.status]} />
        <span className="work-main">
          <span className="work-title">{w.title}</span>
          <span className="work-sub">
            <span className={`tone-${tone}`}>{pendingApproval(w) ? waitingLabel(w) : workLabel[w.status]}</span>
            {w.mergedInto ? ` into ${w.mergedInto}` : ''} · <span className="mono">{w.id}</span> · {s ? sourceLabel(s) : names(w)}
            {isMine(w, app.me?.userId) ? <span className="tone-blue" data-testid="work-yours"> · yours</span> : null}
            {w.triage && !(pendingApproval(w) && w.triage.class === 'needs-human') ? <span className={w.triage.class === 'needs-human' ? 'tone-amber' : ''}> · {triageLabel[w.triage.class]}</span> : null}
            {w.priority === 'urgent' || w.priority === 'high' ? <span className="tone-amber"> · {w.priority}</span> : null}
            {w.flag ? <span className="tone-amber"> · design question</span> : null}
          </span>
        </span>
        <span className="run-cost mono dim" title={new Date(w.updatedAt).toLocaleString()}>
          {fmtRelative(w.updatedAt, now)}
        </span>
      </button>
      {open && (
        <div className="run-detail work-detail">
          {s && (
            <p className="small intake-facts">
              {sourceLabel(s)}
              {s.untrusted ? <span className="tone-amber"> · players’ text, untrusted</span> : null}
              {s.version ? ` · version ${s.version}` : ''}
              {s.reporter ? ` · reported by ${s.reporter}` : ''}
              {s.url ? (
                <>
                  {' · '}
                  <a href={s.url} target="_blank" rel="noreferrer noopener">
                    {s.url.startsWith('https://discord.com/') ? 'Discord thread' : 'on FFBox'}
                  </a>
                </>
              ) : null}
              {s.alsoThreads?.length ? ` · also reported ${s.alsoThreads.length} more time(s)` : ''}
              {' · for '}
              {names(w)}
            </p>
          )}
          {w.triage && (
            <p className={`small ${w.triage.class === 'needs-human' ? 'tone-amber' : 'dim'}`} data-testid="triage">
              Triage: {w.triage.reason}
            </p>
          )}
          {/* Players' text is shown as it is, never as Markdown: no links, images or formatting from it. */}
          {s?.untrusted ? <pre className="code intake-brief">{w.brief}</pre> : <Markdown text={w.brief} />}
          {w.constraints && <p className="dim small">Constraints: {w.constraints}</p>}
          {w.flag && (
            <p className="small tone-amber">
              Design question for {w.flag.for.map((r) => r.displayName).join(', ')}: {w.flag.text}
            </p>
          )}
          {w.outcome && (
            <p className="small">
              <span className="dim">Latest: </span>
              {w.outcome}
            </p>
          )}
          {delivery && <p className="small dim">To players: {delivery}</p>}
          {w.ffbox && (
            <p className="small dim">
              On FFBox: {w.ffbox.state} ({w.ffbox.class}){w.ffbox.branch ? `, branch ${w.ffbox.branch}` : ''}
              {w.ffbox.reason ? `, ${w.ffbox.reason}` : ''}
            </p>
          )}
          {w.mergedInto && (
            <button className="link-btn small" onClick={() => navigate({ view: 'dispatcher', tab: w.mergedInto })}>
              Continues as {w.mergedInto}
            </button>
          )}
          {workers.map((x) => (
            <button key={x.id} className="link-btn small" onClick={() => navigate(sessionRoute(x, app))}>
              Open {x.title}
              {x.sandboxId ? ` in ${x.sandboxId}` : x.machineId && x.machineSandbox ? ` in ${x.machineId}/${x.machineSandbox}` : x.machineId ? ` on ${x.machineId}` : ''}
            </button>
          ))}
          {w.overlaps.length > 0 && (
            <p className="dim small">
              Found at filing, may repeat: {w.overlaps.map((o) => `${o.ref} “${o.title}” (${o.why})`).join('; ')}
            </p>
          )}
          {w.log.length > 0 && (
            <details className="deleg-log">
              <summary className="dim small">Log · {w.log.at(-1)}</summary>
              <pre className="code">{w.log.join('\n')}</pre>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
