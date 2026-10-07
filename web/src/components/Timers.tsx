import { useCallback, useEffect, useState } from 'react';
import type { TimerInfo, TimersAnswer } from '../../../shared/types';
import { api } from '../api';
import { attempt } from '../store';
import { Icon, Modal } from './ui';
import { fmtRelative, useNow } from '../util';

/**
 * An orchestrator's timers (docs/orchestrators.md "Timers"): its standing jobs, each with its schedule, next and last
 * fire, and pause, resume and cancel. Your own orchestrator's, and the dispatcher's for an owner; the server refuses
 * anyone else (server/index.ts /api/timers, mayDrive). The orchestrator sets them with set_timer; here you see and stop them.
 */
export function TimersButton({ sessionId, label }: { sessionId: string; label?: string }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<TimersAnswer | null>(null);
  const load = useCallback(async () => {
    try {
      setData(await api.timers(sessionId));
    } catch {
      // Not yours to see, or the server is restarting: nothing to show.
    }
  }, [sessionId]);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 60_000);
    return () => clearInterval(t);
  }, [load]);
  const active = data?.timers.filter((t) => t.state !== 'ended').length ?? 0;
  return (
    <>
      <button
        className="btn btn-ghost btn-icon timers-btn"
        onClick={() => {
          setOpen(true);
          void load();
        }}
        title={active ? `${active} timer${active === 1 ? '' : 's'}` : 'Timers'}
        aria-label="Timers"
        data-testid="timers-button"
      >
        <Icon name="clock" size={14} />
        {active > 0 && <span className="timers-count">{active}</span>}
      </button>
      {open && <TimersModal data={data} label={label} onClose={() => setOpen(false)} act={async (id, action) => {
        const next = await attempt(api.timerAction(sessionId, id, action));
        if (next) setData(next);
      }} />}
    </>
  );
}

function TimersModal({ data, label, onClose, act }: { data: TimersAnswer | null; label?: string; onClose: () => void; act: (id: string, action: 'pause' | 'resume' | 'cancel') => Promise<void> }) {
  const now = useNow(30_000);
  const timers = data?.timers ?? [];
  return (
    <Modal title={label ? `Timers · ${label}` : 'Timers'} onClose={onClose} wide>
      {!data ? (
        <p className="dim">Loading…</p>
      ) : !timers.length ? (
        <p className="dim" data-testid="timers-empty">
          No timers. Ask your orchestrator for a standing job ("check FFBox for new desync PRs every hour") and it sets one.
        </p>
      ) : (
        <>
          <p className="dim small">
            {data.deliveredToday} of {data.limits.deliveriesPerDay} timer messages in the last 24 hours · at most {data.limits.activePerOwner} active
          </p>
          <ul className="timers-list" data-testid="timers-list">
            {timers.map((t) => (
              <TimerRow key={t.id} t={t} now={now} act={act} />
            ))}
          </ul>
        </>
      )}
    </Modal>
  );
}

function TimerRow({ t, now, act }: { t: TimerInfo; now: number; act: (id: string, action: 'pause' | 'resume' | 'cancel') => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const run = async (action: 'pause' | 'resume' | 'cancel') => {
    setBusy(true);
    try {
      await act(t.id, action);
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className={`timer-row timer-${t.state}`} data-testid={`timer-${t.id}`}>
      <div className="timer-main">
        <strong className="ellipsis">{t.title}</strong>
        <span className="dim small">
          {t.scheduleText}
          {t.state === 'active' && t.nextFireAt ? ` · next ${fmtRelative(t.nextFireAt, now)}` : ''}
          {t.state === 'paused' ? ' · paused' : ''}
          {t.state === 'ended' ? ` · ended${t.endReason ? ` (${t.endReason.replace('_', ' ')})` : ''}` : ''}
          {t.lastFiredAt ? ` · last ${fmtRelative(t.lastFiredAt, now)}` : ''}
          {t.pending ? ` · ${t.pending} waiting` : ''}
        </span>
        <span className="small timer-note">{t.note}</span>
      </div>
      {t.state !== 'ended' && (
        <div className="timer-actions">
          {t.state === 'active' ? (
            <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void run('pause')} aria-label={`Pause ${t.title}`}>
              <Icon name="pause" size={14} /> Pause
            </button>
          ) : (
            <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void run('resume')} aria-label={`Resume ${t.title}`}>
              <Icon name="play" size={14} /> Resume
            </button>
          )}
          <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void run('cancel')} aria-label={`Cancel ${t.title}`}>
            <Icon name="x" size={14} /> Cancel
          </button>
        </div>
      )}
    </li>
  );
}
