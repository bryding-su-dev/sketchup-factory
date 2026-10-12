import { useRef, useState } from 'react';
import type { AppState, AutoApprove, EffortLevel, StandingAgent, StandingToolGroup, StandingTrigger } from '../../../shared/types';
import { EFFORT_LEVELS, STANDING_TOOL_GROUPS } from '../../../shared/types';
import { api } from '../api';
import { attempt, upsertStanding } from '../store';
import { displayName, FREE_TEXT, navigate } from '../util';
import { useTextareaDictation } from '../voice/useTextareaDictation';
import { DictationBar, MicButton } from './Mic';
import { Modal } from './ui';

type TriggerKind = StandingTrigger['kind'];

/** Create a standing agent, or edit one (`agent` set). */
export function StandingAgentModal({ app, agent, onClose }: { app: AppState; agent?: StandingAgent; onClose: () => void }) {
  const t = agent?.trigger;
  const [name, setName] = useState(agent?.name ?? '');
  const [charter, setCharter] = useState(agent?.charter ?? '');
  const charterRef = useRef<HTMLTextAreaElement>(null);
  const voice = useTextareaDictation({ value: charter, setValue: setCharter, ref: charterRef });
  const [model, setModel] = useState(agent?.model ?? app.config.defaultModel);
  const [kind, setKind] = useState<TriggerKind>(t?.kind ?? 'interval');
  const [minutes, setMinutes] = useState(String(t?.kind === 'interval' ? t.minutes : 60));
  const [cron, setCron] = useState(t?.kind === 'cron' ? t.expr : '0 9 * * 1-5');
  const [tools, setTools] = useState<StandingToolGroup[]>(agent?.tools ?? []);
  const [perRun, setPerRun] = useState(String(agent?.budget.perRunUsd ?? 2));
  const [perDay, setPerDay] = useState(String(agent?.budget.perDayUsd ?? 10));
  const [maxMinutes, setMaxMinutes] = useState(String(agent?.budget.maxMinutes ?? 45));
  const [enabled, setEnabled] = useState(true);
  const [machineId, setMachineId] = useState(agent?.machineId ?? '');
  const aa = agent?.autoApprove;
  const [auto, setAuto] = useState(!!aa?.enabled);
  const [autoRun, setAutoRun] = useState(String(aa?.maxPerRun ?? 3));
  const [autoDay, setAutoDay] = useState(String(aa?.maxPerDay ?? 3));
  const [autoModel, setAutoModel] = useState(aa?.model ?? (app.config.models.includes('sonnet') ? 'sonnet' : app.config.defaultModel));
  const [autoEffort, setAutoEffort] = useState<EffortLevel>(aa?.effort ?? 'high');
  const [autoTargets, setAutoTargets] = useState<AutoApprove['targets']>(aa?.targets ?? 'sandboxes-then-machines');
  const [autoExpiry, setAutoExpiry] = useState(String(aa?.expiryHours ?? 8));
  const [autoExclude, setAutoExclude] = useState((aa?.exclude ?? ['mp-r2']).join(', '));
  const [busy, setBusy] = useState(false);

  const valid =
    name.trim().length > 0 &&
    charter.trim().length > 0 &&
    (kind !== 'interval' || Number(minutes) >= 5) &&
    (kind !== 'cron' || cron.trim().split(/\s+/).length === 5);
  const trigger = (): StandingTrigger => (kind === 'interval' ? { kind, minutes: Number(minutes) } : kind === 'cron' ? { kind, expr: cron.trim() } : { kind: 'manual' });
  const toggle = (g: StandingToolGroup) => setTools((x) => (x.includes(g) ? x.filter((y) => y !== g) : [...x, g]));

  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    const body = {
      name: name.trim(),
      charter: charter.trim(),
      model,
      trigger: trigger(),
      tools,
      machineId,
      ...(auto || aa
        ? {
            autoApprove: {
              enabled: auto && tools.includes('delegate'),
              maxPerRun: Number(autoRun),
              maxPerDay: Number(autoDay),
              model: autoModel,
              effort: autoEffort,
              targets: autoTargets,
              expiryHours: Number(autoExpiry),
              exclude: autoExclude.split(/[\s,]+/).filter(Boolean),
            },
          }
        : {}),
      budget: { perRunUsd: Number(perRun), perDayUsd: Number(perDay), maxMinutes: Number(maxMinutes) },
    };
    const saved = await attempt(agent ? api.updateStanding(agent.id, body) : api.createStanding({ ...body, enabled }));
    setBusy(false);
    if (saved) {
      upsertStanding(saved);
      if (!agent) navigate({ view: 'agent', agentId: saved.id });
      onClose();
    }
  };

  const models = app.config.models.includes(app.config.defaultModel) ? app.config.models : [app.config.defaultModel, ...app.config.models];

  return (
    <Modal
      title={
        agent ? (
          <>
            Edit <span className="accent">{agent.name}</span>
          </>
        ) : (
          'New standing agent'
        )
      }
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!valid || busy} onClick={submit}>
            {busy ? 'Saving…' : agent ? 'Save' : 'Create agent'}
          </button>
        </>
      }
    >
      <div className="form">
        <div className="field-row">
          <label className="field">
            <span>Name</span>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Discord triage" autoFocus />
            {agent && (
              <small className="dim">
                id and folder stay <span className="mono">{agent.id}</span>
              </small>
            )}
          </label>
          <label className="field">
            <span>Model</span>
            <select className="input" value={model} onChange={(e) => setModel(e.target.value)}>
              {models.map((m) => (
                <option key={m} value={m}>
                  {m}
                  {m === app.config.defaultModel ? ' (default)' : ''}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="field">
          <span>Charter</span>
          <span className="dictate-wrap">
            <textarea
              ref={charterRef}
              {...FREE_TEXT}
              className="input"
              rows={9}
              value={charter}
              onChange={(e) => setCharter(e.target.value)}
              {...voice.textareaProps}
              onKeyDown={(e) => voice.keyDown(e)}
              placeholder="Its standing job: what to check each run, what it may post and where, what to keep in NOTES.md, and what its summary should say."
            />
            <MicButton d={voice.d} className="dictate-mic" />
          </span>
          <DictationBar d={voice.d} />
        </label>
        <div className="field-row">
          <label className="field">
            <span>Runs</span>
            <select className="input" value={kind} onChange={(e) => setKind(e.target.value as TriggerKind)}>
              <option value="interval">Every N minutes</option>
              <option value="cron">On a cron schedule</option>
              <option value="manual">Manual only</option>
            </select>
          </label>
          {kind === 'interval' && (
            <label className="field">
              <span>Minutes (at least 5)</span>
              <input className="input mono" type="number" min={5} value={minutes} onChange={(e) => setMinutes(e.target.value)} />
            </label>
          )}
          {kind === 'cron' && (
            <label className="field">
              <span>Cron, host time</span>
              <input className="input mono" value={cron} onChange={(e) => setCron(e.target.value)} placeholder="min hour day month weekday" />
            </label>
          )}
          {kind === 'manual' && <div className="field" />}
        </div>
        {(app.machines.length > 0 || agent?.machineId) && (
          <label className="field">
            <span>Runs on</span>
            <select className="input" value={machineId} onChange={(e) => setMachineId(e.target.value)}>
              <option value="">{app.system?.hostname ?? 'this host'} (with the sandboxes)</option>
              {app.machines.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.id} · {displayName(m)} {m.online ? '' : '(offline)'}
                </option>
              ))}
            </select>
            {agent && (agent.machineId ?? '') !== machineId && <small className="tone-amber">Moving it starts a fresh conversation there; NOTES.md does not move.</small>}
          </label>
        )}
        <div className="field">
          <span>Tools</span>
          <small className="dim">Always: read files anywhere, write only in its own folder.</small>
          {STANDING_TOOL_GROUPS.map((g) => (
            <label key={g.value} className="check">
              <input type="checkbox" checked={tools.includes(g.value)} onChange={() => toggle(g.value)} />
              <span>
                {g.label} <small className="dim">{g.hint}</small>
              </span>
            </label>
          ))}
        </div>
        {tools.includes('delegate') && (
          <div className="field">
            <label className="check">
              <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
              <span>
                Auto-approve its delegation requests{' '}
                <small className="dim">start workers without asking you, within these limits; they work on a branch and open PRs into develop, never merge</small>
              </span>
            </label>
            {auto && (
              <div className="auto-box">
                <div className="field-row field-row-3">
                  <label className="field">
                    <span>Per run</span>
                    <input className="input mono" type="number" min={1} max={20} value={autoRun} onChange={(e) => setAutoRun(e.target.value)} />
                  </label>
                  <label className="field">
                    <span>Per day</span>
                    <input className="input mono" type="number" min={1} max={20} value={autoDay} onChange={(e) => setAutoDay(e.target.value)} />
                  </label>
                  <label className="field">
                    <span>Give up after (h)</span>
                    <input className="input mono" type="number" min={1} max={48} value={autoExpiry} onChange={(e) => setAutoExpiry(e.target.value)} />
                  </label>
                </div>
                <div className="field-row field-row-3">
                  <label className="field">
                    <span>Worker model</span>
                    <select className="input" value={autoModel} onChange={(e) => setAutoModel(e.target.value)}>
                      {models.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    <span>Effort</span>
                    <select className="input" value={autoEffort} onChange={(e) => setAutoEffort(e.target.value as EffortLevel)}>
                      {EFFORT_LEVELS.map((x) => (
                        <option key={x} value={x}>
                          {x}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    <span>Where</span>
                    <select className="input" value={autoTargets} onChange={(e) => setAutoTargets(e.target.value as AutoApprove['targets'])}>
                      <option value="sandboxes-then-machines">Unused sandboxes, then idle machines</option>
                      <option value="sandboxes">Unused sandboxes only</option>
                      <option value="machines">Idle machines only</option>
                    </select>
                  </label>
                </div>
                <label className="field">
                  <span>Never use</span>
                  <input className="input mono" value={autoExclude} onChange={(e) => setAutoExclude(e.target.value)} placeholder="mp-r2" />
                  <small className="dim">Only sandboxes labelled "unused" (and machines labelled "unused" with no agents and a clean tree) are ever used.</small>
                </label>
              </div>
            )}
          </div>
        )}
        <div className="field-row field-row-3">
          <label className="field">
            <span>$ per run</span>
            <input className="input mono" type="number" min={0.05} step={0.5} value={perRun} onChange={(e) => setPerRun(e.target.value)} />
          </label>
          <label className="field">
            <span>$ per day</span>
            <input className="input mono" type="number" min={0.05} step={1} value={perDay} onChange={(e) => setPerDay(e.target.value)} />
          </label>
          <label className="field">
            <span>Max minutes/run</span>
            <input className="input mono" type="number" min={1} max={240} value={maxMinutes} onChange={(e) => setMaxMinutes(e.target.value)} />
          </label>
        </div>
        {!agent && (
          <label className="check">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            <span>
              Enabled <small className="dim">off = created paused; Run now still works</small>
            </span>
          </label>
        )}
      </div>
    </Modal>
  );
}
