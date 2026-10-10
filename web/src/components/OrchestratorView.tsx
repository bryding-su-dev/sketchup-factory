import { memo, useCallback, useEffect, useState } from 'react';
import type { SessionInfo } from '../../../shared/types';
import { api } from '../api';
import { attempt, openSession, reloadTranscript, toast, useStore } from '../store';
import { Composer } from './Composer';
import { ModeSelect } from './SessionView';
import { Transcript } from './Transcript';
import { AttentionButton, DrawerButton } from './ShellButtons';
import { Confirm, Icon, Menu, StateText } from './ui';
import { chatOwner, contextGlance, fmtCost, fmtRelative, sessionLabel, sessionTone, useNow } from '../util';
import { accountOf } from './SystemMeters';
import { TimersButton } from './Timers';

const SUGGESTIONS = ["What's running, and what needs me?", 'Start work on spec 098', 'Play the tutorial single-player and log the bugs', 'Read the Discord forums and find bugs'];

const HEARTBEATS = [10, 15, 30, 60];

/** Your heartbeat: while your workers are busy, your orchestrator is woken every N minutes for a one-line status (server/wake.ts). */
const useHeartbeat = () => useStore((s) => (s.app?.me ? (s.app.settings?.heartbeat?.[s.app.me.userId] ?? null) : (s.app?.settings?.heartbeatMinutes ?? null)));

function HeartbeatSelect() {
  const minutes = useHeartbeat();
  return (
    <select className="input input-sm" value={minutes ?? ''} aria-label="Heartbeat" onChange={(e) => void attempt(api.setSettings({ heartbeatMinutes: e.target.value ? Number(e.target.value) : null }))}>
      <option value="">Off</option>
      {HEARTBEATS.map((m) => (
        <option key={m} value={m}>
          Every {m} min
        </option>
      ))}
    </select>
  );
}

/**
 * An orchestrator's chat (docs/orchestrators.md): your own, or with `readOnly`, someone else's, which only they write
 * to (their name in the header, no menu, and a line where the composer would be).
 */
export const OrchestratorView = memo(function OrchestratorView({ session, compact, readOnly }: { session: SessionInfo | undefined; compact?: boolean; readOnly?: boolean }) {
  const [prefill, setPrefill] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const clearPrefill = useCallback(() => setPrefill(null), []);
  // `/clear` (or `/new`, as in Claude Code) asks before starting a fresh conversation, like the menu's New conversation (w518).
  const clearCommand = useCallback((t: string) => /^\/(clear|new)$/i.test(t.trim()) && (setConfirmReset(true), true), []);
  const heartbeat = useHeartbeat();
  const now = useNow(30_000);
  const account = useStore((s) => (s.app && session ? accountOf(s.app, session.id) : undefined));

  useEffect(() => (session ? openSession(session.id) : undefined), [session?.id]);

  // Messages from other people are unread until you have your own chat in front of you.
  const unread = !readOnly && !!session?.personMessages?.length;
  useEffect(() => {
    if (!unread || !session) return;
    const mark = () => {
      if (document.visibilityState === 'visible') void attempt(api.seen(session.id));
    };
    mark();
    document.addEventListener('visibilitychange', mark);
    return () => document.removeEventListener('visibilitychange', mark);
  }, [unread, session?.id]);

  if (!session) {
    return (
      <section className="orch orch-missing">
        <div className="transcript-loading">
          <span className="spinner" /> Waiting for the orchestrator…
        </div>
      </section>
    );
  }

  const running = session.status === 'running' || session.status === 'starting';
  const owner = readOnly ? chatOwner(session) : undefined;
  // Its context and last compaction (w535): what each turn sends again, and when it was last cut down.
  const ctx = contextGlance(session, now);
  const ctxChip = ctx && (
    <span className="hb-on hide-phone" title={ctx.line} data-testid="context-size">
      Context {ctx.short}
    </span>
  );
  if (owner) {
    return (
      <section className={`orch orch-readonly${compact ? ' orch-compact' : ''}`}>
        <header className="orch-head">
          {!compact && <DrawerButton />}
          <div className="orch-title">
            <span className="orch-name">{owner.displayName}</span>
            <StateText tone={sessionTone(session.status)} label={sessionLabel[session.status]} pulse={running} className="orch-state" />
          </div>
          {ctxChip}
          {!compact && <AttentionButton />}
        </header>
        <Transcript
          session={session}
          size={compact ? 'normal' : 'large'}
          readOnlyFor={owner.displayName}
          empty={
            <div className="panel-empty">
              <p>{owner.displayName} has not written to their orchestrator yet.</p>
            </div>
          }
        />
        <p className="orch-readonly-note" data-testid="read-only-note">
          {owner.displayName}’s conversation · only {owner.displayName} writes here
        </p>
      </section>
    );
  }
  const empty = (
    <div className="orch-empty">
      <div className="orch-mark" aria-hidden>
        <span />
        <span />
        <span />
      </div>
      <h1>What should the factory work on?</h1>
      <p>Say it in plain words. Your orchestrator checks what is already in flight, hands the work to the dispatcher, and reports back here.</p>
      <div className="chips">
        {SUGGESTIONS.map((s) => (
          <button key={s} className="suggest" onClick={() => setPrefill(s)}>
            {s}
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <section className={`orch${compact ? ' orch-compact' : ''}`}>
      <header className="orch-head">
        {!compact && <DrawerButton />}
        <div className="orch-title">
          <span className="orch-name">Orchestrator</span>
          <StateText tone={sessionTone(session.status)} label={sessionLabel[session.status]} pulse={running} className="orch-state" />
        </div>
        {heartbeat && (
          <span className="hb-on hide-phone" title={`Heartbeat: while workers are busy, a one-line status every ${heartbeat} minutes`}>
            <Icon name="pulse" size={13} /> {heartbeat} min
          </span>
        )}
        {ctxChip}
        <TimersButton sessionId={session.id} />
        {!compact && <AttentionButton />}
        <Menu label="Conversation options" className="orch-menu">
          {(close) => (
            <>
              <label className="menu-field">
                <span>
                  Heartbeat
                  <small>A one-line status while workers are busy</small>
                </span>
                <HeartbeatSelect />
              </label>
              <label className="menu-field">
                <span>
                  Permissions
                  <small>When the orchestrator asks first</small>
                </span>
                <ModeSelect session={session} plain />
              </label>
              <button
                className="menu-item"
                onClick={() => {
                  close();
                  setConfirmReset(true);
                }}
              >
                <Icon name="plus" size={15} /> New conversation…
              </button>
              <button
                className="menu-item"
                title="Summarise the conversation so far, so each turn costs less (the same as typing /compact)"
                onClick={async () => {
                  close();
                  const ok = await attempt(api.compact(session.id));
                  if (ok?.note) toast(ok.note);
                }}
              >
                <Icon name="refresh" size={15} /> Compact conversation
              </button>
              <div className="menu-foot">
                {session.model ?? 'default model'}
                {account ? ` on ${account.label}` : ''} · {fmtCost(session.costUsd)} over {session.turns} turns · active {fmtRelative(session.lastActivityAt, now)}
                {ctx && (
                  <>
                    <br />
                    {ctx.line}
                  </>
                )}
              </div>
            </>
          )}
        </Menu>
      </header>
      <Transcript session={session} size={compact ? 'normal' : 'large'} empty={empty} interactive />
      <div className="orch-composer-wrap">
        <Composer key={session.id} session={session} size={compact ? 'normal' : 'large'} placeholder="Message the orchestrator" prefill={prefill} onPrefillUsed={clearPrefill} autoFocus={!compact} onCommand={clearCommand} />
      </div>
      {confirmReset && (
        <Confirm
          title="Start a new conversation?"
          confirmLabel="New conversation"
          body="Your orchestrator starts fresh. Your requests, sandboxes and worker agents carry on."
          onConfirm={async () => {
            const ok = await attempt(api.resetOrchestrator('mine'));
            if (ok !== undefined) reloadTranscript(ok.id);
          }}
          onClose={() => setConfirmReset(false)}
        />
      )}
    </section>
  );
});
