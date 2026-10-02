import { useEffect, useRef, useState } from 'react';
import type { AppState, Sandbox } from '../../../shared/types';
import { api } from '../api';
import { attempt, focusDetails, sessionsByIds, useStore } from '../store';
import { displayName, fmtRelative, isUnused, navigate, sandboxGlance, unityLabel, unityTone, useNow } from '../util';
import { NewAgentModal } from './Modals';
import { ScreenshotsDrawer } from './Images';
import { GitFacts, SwitchBranchModal } from './Git';
import { SessionDetails, SessionView } from './SessionView';
import { AgentPicker, AgentTabs, AttentionStrip, DetailsSection, DetailsSheet, PanelHeader, useDetailsOpen } from './PanelChrome';
import { Chip, Confirm, CopyButton, Icon, StateText } from './ui';

export function SandboxPanel({
  app,
  sandbox,
  sessionId,
  onClose,
}: {
  app: AppState;
  sandbox: Sandbox;
  sessionId?: string;
  onClose?: () => void;
}) {
  const now = useNow();
  const sessions = sessionsByIds(app.sessions, sandbox.sessionIds);
  // Default to the most recent session.
  const selected = sessions.find((s) => s.id === sessionId) ?? sessions[sessions.length - 1];

  const [newAgent, setNewAgent] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const [shotsOpen, setShotsOpen] = useState(false);
  const [switchOpen, setSwitchOpen] = useState(false);
  const [unityBusy, setUnityBusy] = useState(false);

  const u = sandbox.unity.state;
  const nameOf = `${displayName(sandbox)} (slot ${sandbox.id})`;
  const unityOn = u === 'running' || u === 'starting' || u === 'blocked';
  const blocked = u === 'blocked' ? sandbox.unity.blocked : undefined;
  const dismissed = (sandbox.unity.dismissed ?? []).slice(-3).reverse();
  const ready = sandbox.status === 'ready';
  // A host without a per-sandbox editor (config unity.editorPath empty): no editor state, buttons or log.
  const editor = useStore((s) => s.app?.host?.editor !== false);

  const toggleUnity = async () => {
    setUnityBusy(true);
    await attempt(api.unity(sandbox.id, unityOn ? 'stop' : 'start'));
    setUnityBusy(false);
  };

  const [details, setDetails] = useDetailsOpen('sandbox');
  const pick = (id: string) => navigate({ view: 'sandbox', sandboxId: sandbox.id, sessionId: id }, true);
  const glance = sandboxGlance(sandbox, sessions);
  const waiting = sessions.find((s) => s.pendingPermissions.length > 0);

  // "Unity is stuck" in the attention list opens the details; a permission request of another agent here selects it.
  const detailsFor = useStore((s) => s.focusDetails);
  useEffect(() => {
    if (detailsFor !== sandbox.id) return;
    setDetails(true);
    focusDetails(null);
  }, [detailsFor, sandbox.id]);
  const focusRequest = useStore((s) => s.focusRequestId);
  useEffect(() => {
    const owner = focusRequest ? sessions.find((s) => s.pendingPermissions.some((p) => p.requestId === focusRequest)) : undefined;
    if (owner && owner.id !== selected?.id) pick(owner.id);
  }, [focusRequest]);

  const facts = [editor && u !== 'blocked' && ready ? unityLabel[u] : '', sandbox.git?.branch ?? ''].filter(Boolean);

  return (
    <section className="sb-panel">
      <PanelHeader
        onBack={onClose}
        title={displayName(sandbox)}
        titleClass={isUnused(sandbox.purpose) ? 'is-unused' : ''}
        state={<StateText tone={glance.tone} label={glance.label} pulse={glance.tone === 'blue'} />}
        extra={
          <>
            {glance.progress || sandbox.status === 'error' ? null : (
              <span className="ph-facts hide-phone">
                {facts.map((f, i) => (
                  <span key={i} className={f === sandbox.git?.branch ? 'mono' : undefined}>
                    <span className="ph-sep">·</span>
                    {f}
                  </span>
                ))}
              </span>
            )}
            {ready && <AgentPicker place={displayName(sandbox)} sessions={sessions} selected={selected} onSelect={pick} onNew={() => setNewAgent(true)} newDisabled={!ready} />}
          </>
        }
        detailsOpen={details}
        onToggleDetails={() => setDetails(!details)}
      />
      <AttentionStrip session={waiting} unity={blocked} onUnity={() => setDetails(true)} />
      {(sandbox.status === 'creating' || sandbox.status === 'deleting') && (
        <div className="sb-progress">
          <div className="indeterminate" />
          <span>{sandbox.statusDetail ?? (sandbox.status === 'creating' ? 'Creating…' : 'Deleting…')}</span>
        </div>
      )}
      {sandbox.status === 'error' && (
        <div className="banner banner-error banner-action">
          <span>
            <b>This sandbox could not be set up.</b> {sandbox.statusDetail}
          </span>
          <button className="btn btn-sm btn-outline" onClick={() => setConfirmDelete(true)}>
            <Icon name="trash" size={14} /> Delete it
          </button>
        </div>
      )}
      <DetailsSheet open={details} onClose={() => setDetails(false)} title={displayName(sandbox)}>
        <DetailsSection
          title="Sandbox"
          actions={
            <button
              className="btn btn-ghost btn-sm danger-hover"
              title="Delete sandbox"
              disabled={sandbox.status === 'deleting'}
              onClick={() => setConfirmDelete(true)}
            >
              <Icon name="trash" size={14} /> Delete
            </button>
          }
        >
          <div className="details-row dim small">
            <span title="The sandbox's folder and Unity project: historical, not its current task">
              Slot <span className="mono">{sandbox.id}</span>
            </span>
            <span title={new Date(sandbox.createdAt).toLocaleString()}>created {fmtRelative(sandbox.createdAt, now)}</span>
          </div>
          <div className="sb-facts">
            <GitFacts git={sandbox.git} />
            <span className="fact mono">
              <Icon name="folder" size={13} /> <span className="ellipsis">{sandbox.path}</span>
              <CopyButton text={sandbox.path} label="Copy path" />
            </span>
          </div>
        </DetailsSection>
        <DetailsSection title={editor ? 'Unity' : 'Sandbox'}>
          {editor && (
          <div className="unity-bar">
            <Chip tone={unityTone(u)} title={sandbox.unity.detail}>
              {unityLabel[u]}
              {sandbox.unity.pid ? <span className="mono dim"> pid {sandbox.unity.pid}</span> : null}
            </Chip>
            {sandbox.unity.startedAt && u === 'running' && <span className="dim small">up {fmtRelative(sandbox.unity.startedAt, now).replace(' ago', '')}</span>}
            {sandbox.unity.detail && u !== 'running' && u !== 'blocked' && <span className="dim small ellipsis">{sandbox.unity.detail}</span>}
            <div className="spacer" />
            <button
              className={`btn btn-sm ${unityOn ? 'btn-outline' : 'btn-primary'}`}
              disabled={!ready || unityBusy || u === 'stopping'}
              onClick={toggleUnity}
            >
              <Icon name={unityOn ? 'power' : 'play'} size={14} /> {unityOn ? 'Stop Unity' : 'Start Unity'}
            </button>
          </div>
          )}
          <div className="details-buttons">
            {editor && (
              <button className="btn btn-ghost btn-sm" onClick={() => setLogOpen(true)}>
                <Icon name="log" size={14} /> Log
              </button>
            )}
            <button className="btn btn-ghost btn-sm" onClick={() => setShotsOpen(true)} title="Screenshots, videos and other images agents left here">
              <Icon name="image" size={14} /> Screenshots
            </button>
            <button className="btn btn-ghost btn-sm" disabled={!ready} onClick={() => setSwitchOpen(true)} title="Switch this sandbox to another branch">
              <Icon name="branch" size={14} /> Branch
            </button>
          </div>
          {blocked && (
            <div className="banner banner-warn unity-blocked">
              <b>{blocked.reason === 'dialog' ? `Dialog: ${blocked.title}` : blocked.title}</b>
              {blocked.text && <div className="pre-wrap">{blocked.text}</div>}
              {blocked.buttons?.length ? <div className="dim small">Buttons: {blocked.buttons.join(' · ')}</div> : null}
              {blocked.advice && <div className="small">{blocked.advice}</div>}
              <div className="dim small">since {fmtRelative(blocked.since, now)}</div>
            </div>
          )}
          {(sandbox.unity.restarts?.length ?? 0) > 0 && (
            <div className="dim small unity-dismissed">
              Restarted after a hang or crash:{' '}
              {sandbox.unity.restarts!.slice(-3).map((r, i) => (
                <span key={r.at + i} title={`${new Date(r.at).toLocaleString()}: ${r.reason}`}>
                  {i > 0 ? ' · ' : ''}
                  {r.reason.split(':')[0]} {fmtRelative(r.at, now)}
                </span>
              ))}
            </div>
          )}
          {dismissed.length > 0 && (
            <div className="dim small unity-dismissed">
              Auto-dismissed:{' '}
              {dismissed.map((d, i) => (
                <span key={d.at + i} title={new Date(d.at).toLocaleString()}>
                  {i > 0 ? ' · ' : ''}
                  {d.title} → “{d.button}” {fmtRelative(d.at, now)}
                </span>
              ))}
            </div>
          )}
        </DetailsSection>
        {selected && <SessionDetails session={selected} />}
      </DetailsSheet>

      <AgentTabs sessions={sessions} selected={selected} onSelect={pick} onNew={() => setNewAgent(true)} newDisabled={!ready} />

      {selected ? (
        <SessionView key={selected.id} session={selected} embedded />
      ) : sandbox.status === 'error' ? null : (
        <div className="panel-empty">
          <Icon name="bot" size={28} />
          <p>{ready ? 'No agents here yet.' : 'Agents can start once the sandbox is ready.'}</p>
          {ready && (
            <div className="panel-empty-actions">
              <button className="btn btn-primary" onClick={() => setNewAgent(true)}>
                <Icon name="plus" size={14} /> New agent
              </button>
              {editor && u === 'stopped' && (
                <button className="btn btn-outline" disabled={unityBusy} onClick={toggleUnity}>
                  <Icon name="play" size={14} /> Start Unity
                </button>
              )}
            </div>
          )}
          {ready && <p className="dim small">Or ask the orchestrator to put it to work.</p>}
        </div>
      )}

      {newAgent && <NewAgentModal app={app} target={{ sandboxId: sandbox.id, name: displayName(sandbox) }} onClose={() => setNewAgent(false)} />}
      {logOpen && <UnityLogDrawer name={displayName(sandbox)} logPath={sandbox.unity.logPath} load={(lines) => api.unityLog(sandbox.id, lines)} onClose={() => setLogOpen(false)} />}
      {shotsOpen && <ScreenshotsDrawer place={{ sandbox: sandbox.id }} title={displayName(sandbox)} onClose={() => setShotsOpen(false)} />}
      {switchOpen && <SwitchBranchModal target={{ sandbox: sandbox.id }} name={nameOf} git={sandbox.git} onClose={() => setSwitchOpen(false)} />}
      {confirmDelete && (
        <Confirm
          title={`Delete ${nameOf}?`}
          danger
          confirmLabel="Delete sandbox"
          body={
            <>
              <p>
                Stops Unity and every agent in it, then removes the worktree at <code>{sandbox.path}</code>.
              </p>
              <p className="dim">
                Anything not committed and pushed on <code>{sandbox.git?.branch ?? sandbox.branch}</code> is lost.
              </p>
            </>
          }
          onConfirm={async () => {
            const ok = await attempt(api.deleteSandbox(sandbox.id));
            if (ok !== undefined) navigate({ view: 'home' });
          }}
          onClose={() => setConfirmDelete(false)}
        />
      )}
    </section>
  );
}

/** A sandbox editor's log, followed every few seconds: a host sandbox's, or a machine sandbox's through its daemon. */
export function UnityLogDrawer({ name, logPath, load: fetchLines, onClose }: { name: string; logPath?: string; load: (lines: number) => Promise<{ lines: string[] }>; onClose: () => void }) {
  const [lines, setLines] = useState<string[] | null>(null);
  const [follow, setFollow] = useState(true);
  const [loading, setLoading] = useState(false);
  const pre = useRef<HTMLPreElement>(null);

  const load = async () => {
    setLoading(true);
    const r = await attempt(fetchLines(400));
    setLoading(false);
    if (r) setLines(r.lines);
  };

  useEffect(() => {
    void load();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [name]);

  useEffect(() => {
    if (!follow) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [follow, name]);

  useEffect(() => {
    if (follow && pre.current) pre.current.scrollTop = pre.current.scrollHeight;
  }, [lines, follow]);

  return (
    <div className="overlay overlay-drawer" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="drawer" role="dialog" aria-modal>
        <header className="drawer-head">
          <Icon name="log" />
          <span className="ellipsis">
            Unity log · <span className="accent">{name}</span>
          </span>
          {logPath && (
            <span className="mono dim small ellipsis hide-sm" title={logPath}>
              {logPath}
            </span>
          )}
          <div className="spacer" />
          <label className="check check-inline">
            <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> Follow
          </label>
          <button className="btn btn-ghost btn-icon" onClick={load} title="Refresh" aria-label="Refresh">
            {loading ? <span className="spinner" /> : <Icon name="refresh" />}
          </button>
          <button className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Close">
            <Icon name="x" />
          </button>
        </header>
        <pre className="log" ref={pre}>
          {lines === null
            ? 'Loading…'
            : lines.length === 0
              ? 'Log is empty.'
              : lines.map((l, i) => (
                  <div key={i} className={/error|exception|CS\d{4}/i.test(l) ? 'log-err' : /warning/i.test(l) ? 'log-warn' : undefined}>
                    {l}
                  </div>
                ))}
        </pre>
      </div>
    </div>
  );
}
