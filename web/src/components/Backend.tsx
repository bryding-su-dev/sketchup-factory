import { useState } from 'react';
import type { BackendStatus, SessionInfo } from '../../../shared/types';
import { api } from '../api';
import { attempt, useStore } from '../store';
import { fmtCost } from '../util';

// Which backend the agents run on (w38, docs/bedrock.md): a badge that is always in view, the Plan | Bedrock | Auto
// control, and per-agent marks. The plan is the default and stays unmarked on agent rows.

export const onBedrock = (s: Pick<SessionInfo, 'backend' | 'account'>) => s.backend === 'bedrock' || !!s.account?.startsWith('bedrock:');

/** "on Bedrock · $0.42" for a Bedrock session, '' otherwise. */
export const bedrockLine = (s: SessionInfo) => (onBedrock(s) ? `on Bedrock · ${fmtCost(s.bedrockCostUsd ?? 0)}` : '');

/** "Bedrock (profile)" for a session's "bedrock:<profile>" account key. */
export const bedrockAccountLabel = (s: Pick<SessionInfo, 'account'>) => (s.account?.startsWith('bedrock:') ? `Bedrock (${s.account.slice('bedrock:'.length)})` : undefined);

export const usd2 = (n: number) => `$${n.toFixed(2)}`;

export function backendView(b: BackendStatus | undefined): { label: string; tone: 'plan' | 'bedrock' | 'blocked'; title: string; spend?: string; problem?: string } {
  if (!b || !b.configured) return { label: 'Plan', tone: 'plan', title: 'Bedrock is not set up (config bedrock.profile)' };
  const tone = b.active;
  const label = tone === 'blocked' ? 'Bedrock cap reached – waiting' : tone === 'bedrock' ? 'Bedrock' : 'Plan';
  const showSpend = b.spend.todayUsd > 0 || tone === 'bedrock';
  return {
    label,
    tone,
    title: [`${label} (mode ${b.mode})`, b.reason, b.problem ? `Bedrock cannot be used: ${b.problem}` : ''].filter(Boolean).join('\n'),
    spend: showSpend ? `${usd2(b.spend.todayUsd)} of $${b.spend.dailyBudgetUsd.toFixed(0)} today` : undefined,
    problem: b.problem,
  };
}

/** The badge: always in the sidebar's head, so a phone's drawer shows it too. */
export function BackendBadge({ backend }: { backend?: BackendStatus }) {
  const v = backendView(backend);
  return (
    <div className={`backend-badge bk-${v.tone}`} data-testid="backend-badge" data-active={v.tone} title={v.title}>
      <span className="bk-label">
        {v.problem && <i className="bk-problem" data-testid="backend-problem" aria-label={`Problem: ${v.problem}`} />}
        {v.label}
      </span>
      {v.spend && <span className="bk-spend">{v.spend}</span>}
    </div>
  );
}

const MODES: { mode: BackendStatus['mode']; label: string; hint: string }[] = [
  { mode: 'plan', label: 'Plan', hint: 'Always the Claude plan' },
  { mode: 'bedrock', label: 'Bedrock', hint: 'Always Amazon Bedrock (spends SketchUp’s money)' },
  { mode: 'auto', label: 'Auto', hint: 'The plan, and Bedrock when the plan’s 5-hour usage nears its limit' },
];

/** Plan | Bedrock | Auto, shown only when a Bedrock profile is set. */
export function BackendMode({ backend }: { backend?: BackendStatus }) {
  const [busy, setBusy] = useState(false);
  if (!backend?.configured) return null;
  const pick = async (mode: BackendStatus['mode']) => {
    if (mode === backend.mode || busy) return;
    if (mode === 'bedrock' && !window.confirm('Run every agent on Amazon Bedrock? It spends SketchUp’s money, up to the daily cap.')) return;
    setBusy(true);
    await attempt(api.setBackendMode(mode));
    setBusy(false);
  };
  return (
    <div className="backend-mode" role="group" aria-label="Backend" data-testid="backend-mode">
      {MODES.map((m) => (
        <button key={m.mode} type="button" className={backend.mode === m.mode ? 'active' : ''} aria-pressed={backend.mode === m.mode} disabled={busy} title={m.hint} data-testid={`backend-mode-${m.mode}`} onClick={() => void pick(m.mode)}>
          {m.label}
        </button>
      ))}
    </div>
  );
}

/** The phone header's mark: nothing on the plan, "B" on Bedrock, "!" while blocked or in trouble. */
export function BackendMark() {
  const b = useStore((s) => s.app?.backend);
  if (!b?.configured) return null;
  const v = backendView(b);
  if (v.tone === 'plan' && !v.problem) return null;
  const fine = v.tone === 'bedrock' && !v.problem;
  return (
    <span className={`drawer-bk ${fine ? 'bk-bedrock' : 'bk-blocked'}`} data-testid="backend-mark" title={v.title} aria-hidden>
      {fine ? 'B' : '!'}
    </span>
  );
}
