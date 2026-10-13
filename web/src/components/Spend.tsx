// What work costs (w859, docs/spend.md): a request's dollars and tokens by model and session with its transcripts linked, and the
// analysis tab of the dispatcher's page (top requests, kinds of work, where the tokens go, the transcripts' footprint).
// Dollars and tokens are Claude Code's own per-turn usage; what is estimated says so where it is shown.
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { AppState } from '../../../shared/types';
import { CATEGORY_LABEL, COORDINATION_NOTE, isCoordinatorRole, type SpendReportReply, type SpendRequestReply, type SpendSummaryReply } from '../../../shared/spend';
import { api } from '../api';
import { sessionRoute } from '../attention';
import { fmtCost, fmtTokens, href, navigate } from '../util';

type Summary = SpendSummaryReply['requests'];

// One poll for every row that shows a cost: the summary is read again every minute while any row is mounted.
let summary: Summary = {};
let timer: ReturnType<typeof setInterval> | undefined;
const listeners = new Set<() => void>();
const loadSummary = () => void api.spendSummary().then((r) => { summary = r.requests; listeners.forEach((l) => l()); }).catch(() => {});
function subscribe(l: () => void) {
  listeners.add(l);
  if (!timer) {
    loadSummary();
    timer = setInterval(loadSummary, 60_000);
  }
  return () => {
    listeners.delete(l);
    if (!listeners.size && timer) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}
/** The cost of every request the page holds. */
export const useSpendSummary = (): Summary => useSyncExternalStore(subscribe, () => summary);

const money = (usd: number) => (usd >= 100 ? `$${Math.round(usd)}` : fmtCost(usd));
const pct = (x: number) => `${Math.round(x * 100)}%`;
const tokLine = (t: { in: number; out: number; cr: number; cw: number }) => `in ${fmtTokens(t.in)} · out ${fmtTokens(t.out)} · cache read ${fmtTokens(t.cr)} · cache write ${fmtTokens(t.cw)}`;

/** A request's cost so far, small, for its row. */
export function CostChip({ id, summary }: { id: string; summary: Summary }) {
  const c = summary[id];
  if (!c || (c.usd <= 0 && c.coordinationUsd <= 0)) return null;
  // the workers' own cost; the dispatcher's and orchestrators' turns on the request are billed beside it (w1160)
  return (
    <span className="mono dim" title={`Workers: ${tokLine(c)}${c.estimatedUsd > 0.005 ? ` · ${money(c.estimatedUsd)} of the request's cost estimated` : ''} · ${c.sessions} session(s)${c.coordinationUsd > 0.005 ? ` · Coordination ${money(c.coordinationUsd)}. ${COORDINATION_NOTE}` : ''}`} data-testid={`cost-${id}`}>
      {' '}
      · {money(c.usd)}
      {c.coordinationUsd > 0.005 ? ` + ${money(c.coordinationUsd)} coord.` : ''}
    </span>
  );
}

/** One request's spend, in its opened row: models, sessions with their transcripts, where the context went. */
export function RequestSpendBlock({ id, app }: { id: string; app: AppState }) {
  const [r, setR] = useState<SpendRequestReply>();
  const [err, setErr] = useState<string>();
  useEffect(() => {
    let alive = true;
    api
      .spendRequest(id)
      .then((x) => alive && setR(x))
      .catch((e: Error) => alive && setErr(e.message));
    return () => {
      alive = false;
    };
  }, [id]);
  if (err) return <p className="small dim">Spend: {err}</p>;
  if (!r) return <p className="small dim">Spend: reading…</p>;
  const q = r.request;
  if (!q || q.total.usd <= 0) return <p className="small dim" data-testid={`spend-${id}`}>Spend: nothing recorded yet (it is recorded from the turns after this feature, and backfilled from older transcripts).</p>;
  const models = Object.entries(q.models).sort((a, b) => b[1].usd - a[1].usd);
  const coordUsd = r.sessions.filter((s) => isCoordinatorRole(s.role)).reduce((a, s) => a + s.share.total.usd, 0);
  const cats = Object.entries(q.cats).sort((a, b) => b[1].usd - a[1].usd);
  const catSum = cats.reduce((a, [, c]) => a + c.usd, 0);
  return (
    <div className="spend-block" data-testid={`spend-${id}`}>
      <p className="small">
        <strong>Workers {money(Math.max(0, q.total.usd - coordUsd))}</strong>
        {coordUsd > 0.005 ? <span> · <strong>Coordination {money(coordUsd)}</strong></span> : null} · all together {money(q.total.usd)} · {tokLine(q.total)} · {Math.round(q.turns)} turn(s)
        {q.estimated.usd > 0.005 ? <span className="tone-amber"> · {money(q.estimated.usd)} of it backfilled or estimated: its tokens are estimates</span> : null}
      </p>
      {coordUsd > 0.005 && <p className="small dim">{COORDINATION_NOTE}</p>}
      <table className="spend-table small">
        <thead>
          <tr>
            <th>Model</th>
            <th>Cost</th>
            <th>In</th>
            <th>Out</th>
            <th>Cache read</th>
            <th>Cache write</th>
          </tr>
        </thead>
        <tbody>
          {models.map(([m, t]) => (
            <tr key={m}>
              <td className="mono">{m}</td>
              <td>{money(t.usd)}</td>
              <td>{fmtTokens(t.in)}</td>
              <td>{fmtTokens(t.out)}</td>
              <td>{fmtTokens(t.cr)}</td>
              <td>{fmtTokens(t.cw)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="small dim">Sessions (one that served several requests shows this request’s share):</p>
      <ul className="spend-sessions small">
        {r.sessions.map((s) => {
          const live = app.sessions.find((x) => x.id === s.id);
          const kept = s.transcript.state === 'pruned' ? `transcript pruned ${s.transcript.prunedAt?.slice(0, 10) ?? ''}` : !s.hasTranscript ? 'transcript gone' : s.keptWhileOpen ? `transcript kept ${s.transcript.state === 'gz' ? '(compressed) ' : ''}while the request is open` : s.keptUntil ? `transcript kept ${s.transcript.state === 'gz' ? '(compressed) ' : ''}until ${s.keptUntil.slice(0, 10)}` : 'transcript kept';
          return (
            <li key={s.id}>
              {s.hasTranscript ? (
                <a href={live ? href(sessionRoute(live, app)) : `#/session/${encodeURIComponent(s.id)}`} data-testid={`spend-session-${s.id}`}>
                  {s.id.slice(0, 8)}
                </a>
              ) : (
                <span className="mono">{s.id.slice(0, 8)}</span>
              )}{' '}
              <span className="dim">
                {isCoordinatorRole(s.role) ? `coordination (${s.role})` : s.role}
                {s.machine ? ` on ${s.machine}` : ''}
              </span>{' '}
              “{s.title}” · {money(s.share.total.usd)} · {tokLine(s.share.total)} · {Math.round(s.share.turns)} turn(s)
              {Object.keys(s.share.how).length ? <span className="dim"> · tied by {Object.entries(s.share.how).map(([h, n]) => `${h} ${Math.round(n)}`).join(', ')}</span> : null}
              <span className="dim"> · {kept}</span>
            </li>
          );
        })}
      </ul>
      {catSum > 0 && (
        <>
          <p className="small dim">Where the money went (each model call’s real tokens shared among what the context held, by characters: the split is an estimate, the total is not):</p>
          <Bars rows={cats.slice(0, 8).map(([k, c]) => ({ key: k, label: k, pct: c.usd / catSum, note: money((c.usd / catSum) * q.total.usd), title: CATEGORY_LABEL[k] ?? k }))} />
        </>
      )}
    </div>
  );
}

function Bars({ rows }: { rows: { key: string; label: string; pct: number; note: string; title?: string }[] }) {
  return (
    <div className="spend-bars">
      {rows.map((r) => (
        <div key={r.key} className="spend-bar-row" title={r.title}>
          <span className="spend-bar-label small">{r.label}</span>
          <span className="spend-bar">
            <span className="spend-bar-fill" style={{ width: `${Math.max(1, Math.round(r.pct * 100))}%` }} />
          </span>
          <span className="spend-bar-note small mono">
            {pct(r.pct)} · {r.note}
          </span>
        </div>
      ))}
    </div>
  );
}

/** The dispatcher's Spend tab: the analysis lothsahn and the orchestrators use to spot waste. */
export function SpendTab() {
  const [days, setDays] = useState(7);
  const [r, setR] = useState<SpendReportReply>();
  const [err, setErr] = useState<string>();
  useEffect(() => {
    let alive = true;
    setR(undefined);
    api
      .spendReport(days, 12)
      .then((x) => alive && setR(x))
      .catch((e: Error) => alive && setErr(e.message));
    return () => {
      alive = false;
    };
  }, [days]);
  if (err) return <div className="panel-empty"><p>Spend: {err}</p></div>;
  if (!r) return <div className="panel-empty"><p>Reading the spend record…</p></div>;
  const { report: p, footprint: f, guard: g } = r;
  const total = p.total.usd || 1;
  const GB = 1024 ** 3;
  return (
    <div className="spend-tab" data-testid="spend-tab">
      <p className="small">
        <label>
          Last{' '}
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {[1, 3, 7, 14, 30].map((d) => (
              <option key={d} value={d}>
                {d} day{d > 1 ? 's' : ''}
              </option>
            ))}
          </select>
        </label>{' '}
        (UTC days {p.sinceDay} to {p.untilDay}): <strong>{money(p.total.usd)}</strong> · {tokLine(p.total)}
        {p.estimated.usd > 0.005 ? <span className="tone-amber"> · {money(p.estimated.usd)} backfilled or estimated (its tokens are estimates)</span> : null}
      </p>
      <p className="small" data-testid="spend-split">
        Workers’ own cost on requests <strong>{money(p.workers.usd)}</strong> · coordination on requests <strong>{money(p.coordination.usd)}</strong>
        {p.coordination.by.length ? ` (${p.coordination.by.map((b) => `${b.who} ${money(b.usd)}`).join(', ')})` : ''} · no request’s {money(p.buckets.reduce((a, b) => a + b.usd, 0))}
      </p>
      <p className="small dim">{COORDINATION_NOTE}</p>
      {r.backfill && (
        <p className="small dim">
          Backfilled {r.backfill.at.slice(0, 10)} from {r.backfill.sessions} transcripts that ran before the record: {r.backfill.turns} turns, {money(r.backfill.usd)} (dollars as recorded then; tokens estimated).
        </p>
      )}
      <h3 className="small">By model</h3>
      <Bars rows={Object.entries(p.models).sort((a, b) => b[1].usd - a[1].usd).map(([m, t]) => ({ key: m, label: m.replace('claude-', ''), pct: t.usd / total, note: `${money(t.usd)} · out ${fmtTokens(t.out)} · read ${fmtTokens(t.cr)} · write ${fmtTokens(t.cw)}` }))} />
      <h3 className="small">Top requests by the workers’ own cost</h3>
      <table className="spend-table small">
        <thead>
          <tr>
            <th>Request</th>
            <th>Workers</th>
            <th>Coordination</th>
            <th>Kind</th>
            <th>Where its tokens went</th>
          </tr>
        </thead>
        <tbody>
          {p.top.map((t) => (
            <tr key={t.id}>
              <td>
                <a href={href({ view: 'dispatcher', tab: t.id })}>{t.id}</a> {t.title.slice(0, 70)}
                <div className="dim">
                  {t.sessions} session(s){t.person ? ` · ${t.person}` : ''}
                  {t.closed ? ' · closed' : ''}
                </div>
              </td>
              <td className="mono">{money(t.usd)}</td>
              <td className="mono" title={t.coordination.by.map((b) => `${b.who} ${money(b.usd)}`).join(', ')}>{t.coordination.usd > 0.005 ? money(t.coordination.usd) : '–'}</td>
              <td>{t.kind}</td>
              <td>{t.cats.length ? t.cats.map((c) => `${c.cat} ${pct(c.pct)}`).join(', ') : <span className="dim">no context reading yet</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3 className="small">By kind of work</h3>
      <Bars rows={p.kinds.map((k) => ({ key: k.kind, label: k.kind, pct: k.usd / total, note: `${money(k.usd)} over ${k.requests} · ${money(k.avg)} each · coordination ${money(k.coordination)}` }))} />
      <h3 className="small">Where the money goes inside sessions</h3>
      {p.where.length ? (
        <>
          <Bars rows={p.where.slice(0, 12).map((c) => ({ key: c.cat, label: c.cat, pct: c.pct, note: money(c.usd), title: c.label }))} />
          <p className="small dim">
            A context reading of {money(p.measuredCats)} of the window’s requests. Each model call’s real tokens are shared among the kinds of content its context held, by characters: an estimate of the split, exact in total.
            {p.reread ? ` Re-reads of a range already read: ${Math.round(p.reread.n)}${p.reread.afterCompact ? `, ${Math.round(p.reread.afterCompact)} after a compaction` : ''}.` : ''}
          </p>
        </>
      ) : (
        <p className="small dim">No context readings in this window yet: they come from agents running this version (a machine’s daemon, once updated).</p>
      )}
      {p.buckets.length > 0 && (
        <>
          <h3 className="small">Spend that is no request’s</h3>
          <Bars rows={p.buckets.map((b) => ({ key: b.id, label: b.title, pct: b.usd / total, note: money(b.usd) }))} />
        </>
      )}
      <h3 className="small">Transcripts</h3>
      <p className="small">
        {f.files} file(s), {(f.bytes / GB).toFixed(2)} GB, and {f.gzFiles} compressed ({(f.gzBytes / GB).toFixed(2)} GB). About {(f.growthPerDay / GB).toFixed(2)} GB a day; in 7 days {(f.projected7d.plain / GB).toFixed(1)} GB plain
        {f.gzipRatio ? `, ${(f.projected7d.compressed / GB).toFixed(1)} GB compressed (measured ratio ${f.gzipRatio.toFixed(2)})` : ''}.
        {f.disk ? ` The disk is ${Math.round((f.disk.usedBytes / f.disk.totalBytes) * 100)}% used.` : ''}
      </p>
      <p className="small dim">
        Kept {g.retainDays} days after their request closes (and for as long as it is open). From {g.gzipAtUsedPercent}% of the disk used, idle ones are compressed; from {g.pruneAtUsedPercent}%, those past their retention are deleted, oldest first; at {g.alertAtUsedPercent}% it tells the owner. A deleted transcript keeps its request’s cost record.
      </p>
      <p className="small dim">
        <button className="link-btn small" onClick={() => navigate({ view: 'dispatcher' })}>
          Back to the requests
        </button>
        {' · '}Orchestrators read the same with the spend_report tool.
      </p>
    </div>
  );
}
