import { useEffect, useState } from 'react';
import type { PermissionMode, SessionInfo } from '../../../shared/types';
import { api } from '../api';
import { attempt, openSession, useStore } from '../store';
import { fmtCost, fmtRelative, navigate, PERMISSION_MODES, sessionLabel, sessionTone, useNow } from '../util';
import { Composer } from './Composer';
import { Transcript } from './Transcript';
import { Confirm, Dot, Icon, StateText } from './ui';
import { AttentionStrip, DetailsSection, DetailsSheet, PanelHeader, useDetailsOpen } from './PanelChrome';
import { accountOf, accountTag } from './SystemMeters';
import { bedrockAccountLabel, bedrockLine } from './Backend';

/**
 * A conversation: the transcript takes the height, the composer sits under it. Inside a sandbox or
 * machine panel (`embedded`) the panel's header and details carry the controls; on its own page it
 * has a one-row header and its controls in the details sheet. `readOnly`: a line saying who writes
 * here, in place of the composer (the dispatcher, for anyone but the owner).
 */
export function SessionView({
  session,
  fullWidth,
  embedded,
  onBack,
  readOnly,
}: {
  session: SessionInfo;
  fullWidth?: boolean;
  embedded?: boolean;
  onBack?: () => void;
  readOnly?: string;
}) {
  useEffect(() => openSession(session.id), [session.id]);
  const [details, setDetails] = useDetailsOpen('session');

  return (
    <section className={`session-view${fullWidth ? ' session-full' : ''}`}>
      {!embedded && (
        <>
          <PanelHeader
            onBack={onBack}
            title={session.title}
            state={<StateText tone={sessionTone(session.status)} label={sessionLabel[session.status]} pulse={session.status === 'running'} />}
            detailsOpen={details}
            onToggleDetails={() => setDetails(!details)}
          />
          <AttentionStrip session={session} />
          <DetailsSheet open={details} onClose={() => setDetails(false)} title={session.title}>
            <SessionDetails session={session} fullWidth={fullWidth} />
          </DetailsSheet>
        </>
      )}
      {session.status === 'error' && session.statusDetail && <div className="banner banner-error">{session.statusDetail}</div>}
      <Transcript session={session} size={fullWidth ? 'large' : 'normal'} readOnlyFor={readOnly ? 'the owner' : undefined} />
      {readOnly ? (
        <p className="orch-readonly-note" data-testid="read-only-note">
          {readOnly}
        </p>
      ) : (
        <Composer
          key={session.id}
          session={session}
          size={fullWidth ? 'large' : 'normal'}
          placeholder={session.kind === 'standing' ? `Message ${session.title} (starts a run, or joins one)` : `Message ${session.title}`}
          autoFocus
        />
      )}
    </section>
  );
}

/** One agent's controls, for a details sheet: name (rename), id, status and cost, permission mode, open full width, end. */
export function SessionDetails({ session, fullWidth }: { session: SessionInfo; fullWidth?: boolean }) {
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState('');
  return (
    <DetailsSection
      title="Agent"
      actions={
        <span className="details-actions">
          {!fullWidth && (session.sandboxId || session.standingId || session.machineId) && (
            <button className="btn btn-ghost btn-sm" title="Open this conversation full width" onClick={() => navigate({ view: 'session', sessionId: session.id })}>
              <Icon name="expand" size={14} /> Full width
            </button>
          )}
          {session.kind === 'worker' && (
            <button className="btn btn-ghost btn-sm danger-hover" title="End session" onClick={() => setConfirmEnd(true)}>
              <Icon name="trash" size={14} /> End
            </button>
          )}
        </span>
      }
    >
      <div className="session-title">
        <Dot tone={sessionTone(session.status)} pulse={session.status === 'running'} />
        {renaming ? (
          <form
            className="rename-form"
            onSubmit={async (e) => {
              e.preventDefault();
              const ok = draft.trim() && draft.trim() !== session.title ? await attempt(api.renameSession(session.id, draft.trim())) : true;
              if (ok) setRenaming(false);
            }}
          >
            <input className="input" value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setRenaming(false)} maxLength={80} autoFocus aria-label="Agent name" />
            <button className="btn btn-primary btn-xs" type="submit">
              Save
            </button>
          </form>
        ) : (
          <>
            <span className="ellipsis">{session.title}</span>
            {session.kind === 'worker' && (
              <button
                className="btn btn-ghost btn-icon btn-xs"
                title="Rename"
                aria-label="Rename"
                onClick={() => {
                  setDraft(session.title);
                  setRenaming(true);
                }}
              >
                <Icon name="edit" size={12} />
              </button>
            )}
          </>
        )}
      </div>
      <div className="details-row">
        <SessionMeta session={session} />
        <span className="session-id mono" title="Session id">
          {session.id}
        </span>
      </div>
      {session.kind !== 'standing' && (
        <div className="details-row">
          <span className="dim small">Permissions</span>
          <ModeSelect session={session} />
        </div>
      )}
      {confirmEnd && (
        <Confirm
          title="End this session?"
          danger
          confirmLabel="End session"
          body={
            <>
              Stops <strong>{session.title}</strong> and removes it from the list. The sandbox and its worktree are left
              alone.
            </>
          }
          onConfirm={() => attempt(api.deleteSession(session.id))}
          onClose={() => setConfirmEnd(false)}
        />
      )}
    </DetailsSection>
  );
}

export function SessionMeta({ session }: { session: SessionInfo }) {
  const now = useNow();
  const account = useStore((s) => (s.app ? accountOf(s.app, session.id) : undefined));
  return (
    <div className="session-meta">
      <span className={`tone-${sessionTone(session.status)}`}>{sessionLabel[session.status]}</span>
      {session.model && <span className="mono">{session.model}</span>}
      {session.requestedBy && (
        <span title={`Requested by ${session.requestedBy.displayName} (${session.requestedBy.userId}): the person this agent works for`} data-testid="session-requested-by">
          for {session.requestedBy.displayName}
        </span>
      )}
      {bedrockLine(session) && (
        <span className="mono" title={`Amazon Bedrock account: ${bedrockAccountLabel(session) ?? 'Bedrock'}. The cost is estimated from token counts at list prices.`} data-testid="session-bedrock">
          {bedrockLine(session)}
        </span>
      )}
      {account && !bedrockLine(session) && (
        <span className="mono" title={`Claude account: ${account.label}`} data-testid="session-account">
          {accountTag(account)}
        </span>
      )}
      <span title={`${session.turns} turns`}>{fmtCost(session.costUsd)}</span>
      <span title={new Date(session.lastActivityAt).toLocaleString()}>{fmtRelative(session.lastActivityAt, now)}</span>
    </div>
  );
}

/** The permission mode: a pill in the details, or a plain select inside a menu or form (`plain`). */
export function ModeSelect({ session, plain }: { session: SessionInfo; plain?: boolean }) {
  const [busy, setBusy] = useState(false);
  const select = (
    <select
      className={plain ? 'input input-sm' : undefined}
      value={session.permissionMode}
      disabled={busy}
      aria-label="Permission mode"
      onChange={async (e) => {
        setBusy(true);
        await attempt(api.setMode(session.id, e.target.value as PermissionMode));
        setBusy(false);
      }}
    >
      {PERMISSION_MODES.map((m) => (
        <option key={m.value} value={m.value} title={m.hint}>
          {plain ? `${m.label}: ${m.hint.toLowerCase()}` : m.label}
        </option>
      ))}
    </select>
  );
  if (plain) return select;
  return (
    <label className={`mode-select mode-${session.permissionMode}`} title="Permission mode">
      {select}
    </label>
  );
}
