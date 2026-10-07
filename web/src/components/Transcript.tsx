import { createContext, memo, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Machine, PendingPermission, Sandbox, SessionInfo, StandingAgent, TranscriptEvent } from '../../../shared/types';
import { parseNotice, type Notice, type NoticeKind } from '../../../shared/notices';
import { api } from '../api';
import { sessionRoute } from '../attention';
import { attempt, clearFocusEvent, focusPermission, sessionIndex, useStore } from '../store';
import { displayName, fmtClock, fmtCost, fmtDivider, fmtDuration, FREE_TEXT, navigate, sameTitle, useNow, type Route } from '../util';
import { LocalImages, Markdown } from './Markdown';
import { fileUrl, ImageStrip, MentionedImages, uploadUrl } from './Images';
import { AttachmentList } from './Attachments';
import { prettyJson, summarizeToolInput, toolDisplayName, toolLabel, toolsSummary } from './toolSummary';
import { Icon, type IconName } from './ui';

type ToolUse = Extract<TranscriptEvent, { kind: 'tool_use' }>;
type ToolResult = Extract<TranscriptEvent, { kind: 'tool_result' }>;
type PermissionEv = Extract<TranscriptEvent, { kind: 'permission' }>;
type UserEv = Extract<TranscriptEvent, { kind: 'user' }>;
type AssistantEv = Extract<TranscriptEvent, { kind: 'assistant' }>;
type ThinkingEv = Extract<TranscriptEvent, { kind: 'thinking' }>;
type ResultEv = Extract<TranscriptEvent, { kind: 'result' }>;

/** One step inside a run of work: a tool call (with its result once it lands), a stray result, or thinking. */
type Step = { kind: 'tool'; use: ToolUse; result?: ToolResult } | { kind: 'orphan'; result: ToolResult } | { kind: 'thinking'; ev: ThinkingEv };

/**
 * What the transcript shows, in order. Tool calls and thinking between two messages fold into one
 * activity line; a finished turn's time and cost go on its last reply instead of a rule of their own;
 * a divider marks a gap of more than a quarter of an hour.
 */
type Item =
  | { type: 'divider'; key: string; label: string }
  | { type: 'user'; key: string; ev: UserEv }
  | { type: 'notice'; key: string; ev: UserEv }
  | { type: 'assistant'; key: string; ev: AssistantEv; end?: ResultEv }
  | { type: 'activity'; key: string; steps: Step[] }
  | { type: 'event'; key: string; ev: TranscriptEvent };

const GAP_MS = 15 * 60_000;

function buildItems(events: TranscriptEvent[], now: number): Item[] {
  const results = new Map<string, ToolResult>();
  const uses = new Set<string>();
  for (const e of events) {
    if (e.kind === 'tool_result') results.set(e.toolUseId, e);
    else if (e.kind === 'tool_use') uses.add(e.toolUseId);
  }
  const items: Item[] = [];
  let group: Step[] | null = null;
  let groupKey = '';
  let lastT: number | undefined;
  /** The reply a finished turn's time and cost belong to: the last one since the last message in. */
  let replyIdx = -1;
  const flush = () => {
    if (group?.length) items.push({ type: 'activity', key: groupKey, steps: group });
    group = null;
  };
  let lastDay = '';
  const divide = (e: TranscriptEvent) => {
    const t = Date.parse(e.t);
    if (lastT === undefined || t - lastT > GAP_MS) {
      const day = new Date(t).toDateString();
      items.push({ type: 'divider', key: `d${e.seq}`, label: day === lastDay ? fmtClock(e.t) : fmtDivider(e.t, now) });
      lastDay = day;
    }
    lastT = t;
  };
  for (const e of events) {
    if (e.kind === 'tool_result' && uses.has(e.toolUseId)) continue;
    if (e.kind === 'tool_use' || e.kind === 'thinking' || e.kind === 'tool_result') {
      if (!group) {
        divide(e);
        group = [];
        groupKey = `a${e.seq}`;
      } else lastT = Date.parse(e.t);
      group.push(e.kind === 'tool_use' ? { kind: 'tool', use: e, result: results.get(e.toolUseId) } : e.kind === 'thinking' ? { kind: 'thinking', ev: e } : { kind: 'orphan', result: e });
      continue;
    }
    flush();
    if (e.kind === 'result') {
      lastT = Date.parse(e.t);
      if (e.ok && replyIdx >= 0) {
        const reply = items[replyIdx];
        if (reply.type === 'assistant') items[replyIdx] = { ...reply, end: e };
      } else if (!e.ok) items.push({ type: 'event', key: `e${e.seq}`, ev: e });
      replyIdx = -1;
      continue;
    }
    divide(e);
    if (e.kind === 'user') {
      items.push({ type: e.from === 'system' ? 'notice' : 'user', key: `u${e.seq}`, ev: e });
      replyIdx = -1;
    } else if (e.kind === 'assistant') {
      items.push({ type: 'assistant', key: `m${e.seq}`, ev: e });
      replyIdx = items.length - 1;
    } else items.push({ type: 'event', key: `e${e.seq}`, ev: e });
  }
  flush();
  return items;
}

const seqsOf = (steps: Step[]) => steps.flatMap((s) => (s.kind === 'tool' ? [s.use.seq, s.result?.seq] : s.kind === 'orphan' ? [s.result.seq] : [s.ev.seq])).filter((x): x is number => x !== undefined);

/** Where each chat was scrolled to, so leaving and coming back keeps the place ('bottom': follow new messages). */
const scrollMemory = new Map<string, number | 'bottom'>();

/** Set on someone else's conversation (docs/orchestrators.md): its permission requests are theirs to answer. */
const ReadOnly = createContext<string | undefined>(undefined);

export const Transcript = memo(function Transcript({
  session,
  size = 'normal',
  empty,
  readOnlyFor,
}: {
  session: SessionInfo;
  size?: 'normal' | 'large';
  empty?: ReactNode;
  /** Someone else's conversation: the name of the person who answers its permission requests. */
  readOnlyFor?: string;
}) {
  const events = useStore((s) => s.transcripts[session.id]);
  const loaded = useStore((s) => !!s.loaded[session.id]);
  const streaming = useStore((s) => s.streaming[session.id]);
  const focusId = useStore((s) => s.focusRequestId);

  const items = useMemo(() => buildItems(events ?? [], Date.now()), [events]);
  // Images in the session's other messages (briefs, notices, a reply still streaming): the files, where it may show them.
  const liveImage = useMemo(() => (p: string) => fileUrl({ session: session.id }, p), [session.id]);

  const pendingById = useMemo(() => {
    const m = new Map<string, PendingPermission>();
    for (const p of session.pendingPermissions) m.set(p.requestId, p);
    return m;
  }, [session.pendingPermissions]);

  // Pending requests with no transcript row yet still need a card.
  const orphanPending = useMemo(() => {
    const seen = new Set((events ?? []).filter((e): e is PermissionEv => e.kind === 'permission').map((e) => e.requestId));
    return session.pendingPermissions.filter((p) => !seen.has(p.requestId));
  }, [events, session.pendingPermissions]);

  const running = session.status === 'running' || session.status === 'starting';
  const last = items.at(-1);
  const liveGroup = running && !streaming && last?.type === 'activity' ? last.key : undefined;
  // When the turn in flight started: the newest message in.
  const turnStart = useMemo(() => [...(events ?? [])].reverse().find((e) => e.kind === 'user')?.t, [events]);

  // ---- scrolling: stick to the bottom, remember the place per chat, offer a way back down ----
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const [jump, setJump] = useState<'none' | 'far' | 'new'>('none');

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    atBottom.current = dist < 80;
    scrollMemory.set(session.id, atBottom.current ? 'bottom' : el.scrollTop);
    setJump((j) => (atBottom.current ? 'none' : j === 'new' ? 'new' : dist > el.clientHeight * 0.6 ? 'far' : 'none'));
  };

  const scrollToBottom = (smooth = false) => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    atBottom.current = true;
    scrollMemory.set(session.id, 'bottom');
    setJump('none');
  };

  // A chat on screen: where it was left, else the bottom.
  useLayoutEffect(() => {
    const saved = scrollMemory.get(session.id);
    const el = scroller.current;
    if (el && typeof saved === 'number' && el.scrollHeight > el.clientHeight) {
      el.scrollTop = saved;
      atBottom.current = false;
    } else {
      atBottom.current = true;
      scrollToBottom();
    }
  }, [session.id]);

  useLayoutEffect(() => {
    if (atBottom.current) scrollToBottom();
    else setJump('new');
  }, [items.length, streaming, orphanPending.length]);

  // Content that grows after layout (markdown, images, opened rows), and the box shrinking (a keyboard, the
  // iPad's shortcut bar, the details panel), keep us pinned to the bottom.
  useEffect(() => {
    const box = scroller.current;
    const el = box?.firstElementChild;
    if (!box || !el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (atBottom.current) box.scrollTo({ top: box.scrollHeight });
    });
    ro.observe(el);
    ro.observe(box);
    return () => ro.disconnect();
  }, []);

  // "Needs you" jump target.
  useEffect(() => {
    if (!focusId || !pendingById.has(focusId)) return;
    const el = scroller.current?.querySelector(`[data-request-id="${CSS.escape(focusId)}"]`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('flash');
      setTimeout(() => el.classList.remove('flash'), 1600);
      focusPermission(null);
    }
  }, [focusId, pendingById, items.length]);

  // A search hit: scroll to that event (or the activity line holding it, which opens itself) and flash it.
  const focus = useStore((s) => s.focusEvent);
  useEffect(() => {
    if (!focus || focus.sessionId !== session.id) return;
    const root = scroller.current;
    const el = (root?.querySelector(`[data-seq="${focus.seq}"], [data-seq2="${focus.seq}"]`) ?? root?.querySelector(`[data-seqs~="${focus.seq}"]`)) as HTMLElement | null | undefined;
    if (!el) return;
    atBottom.current = false;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 1800);
    clearFocusEvent();
  }, [focus, items.length, session.id]);

  const isEmpty = loaded && items.length === 0 && !streaming && orphanPending.length === 0;

  return (
    <ReadOnly.Provider value={readOnlyFor}>
    <LocalImages.Provider value={liveImage}>
    <div className={`transcript transcript-${size}`}>
      <div className="transcript-scroll" ref={scroller} onScroll={onScroll}>
        <div className="transcript-inner">
          {!loaded && !events && (
            <div className="transcript-loading">
              <span className="spinner" /> Loading the conversation…
            </div>
          )}
          {isEmpty && (empty ?? <div className="transcript-empty">No messages yet.</div>)}
          {items.map((it) => (
            <ItemView key={it.key} it={it} sessionId={session.id} pending={pendingById} live={it.key === liveGroup} owner={session.requestedBy?.userId} />
          ))}
          {orphanPending.map((p) => (
            <PermissionCard key={p.requestId} sessionId={session.id} requestId={p.requestId} toolName={p.toolName} input={p.input} reason={p.reason} pending />
          ))}
          {streaming && (
            <div className="msg msg-assistant msg-streaming">
              <Markdown text={streaming} />
            </div>
          )}
          {running && !streaming && !liveGroup && <WorkingIndicator detail={session.statusDetail} since={turnStart} />}
        </div>
      </div>
      {jump !== 'none' && (
        <button className={`jump-pill${jump === 'new' ? ' has-new' : ''}`} onClick={() => scrollToBottom(true)} aria-label="Jump to latest" title="Jump to the latest message">
          {jump === 'new' && <span>New messages</span>}
          <Icon name="arrowDown" size={16} />
        </button>
      )}
    </div>
    </LocalImages.Provider>
    </ReadOnly.Provider>
  );
});

const ItemView = memo(function ItemView({ it, sessionId, pending, live, owner }: { it: Item; sessionId: string; pending: Map<string, PendingPermission>; live: boolean; owner?: string }) {
  switch (it.type) {
    case 'divider':
      return (
        <div className="tr-divider" role="separator">
          <span>{it.label}</span>
        </div>
      );
    case 'user':
      return it.ev.from === 'orchestrator' ? <Brief ev={it.ev} /> : <UserMessage ev={it.ev} sessionId={sessionId} owner={owner} />;
    case 'notice':
      return <NoticeRow ev={it.ev} />;
    case 'assistant':
      return <AssistantMessage ev={it.ev} end={it.end} sessionId={sessionId} />;
    case 'activity':
      return <ActivityGroup steps={it.steps} sessionId={sessionId} live={live} />;
    case 'event':
      return <EventRow ev={it.ev} sessionId={sessionId} pending={pending} />;
  }
});

function WorkingIndicator({ detail, since }: { detail?: string; since?: string }) {
  const now = useNow(1000);
  const secs = since ? Math.max(0, Math.round((now - Date.parse(since)) / 1000)) : 0;
  return (
    <div className="working" role="status">
      <span className="working-bars" aria-hidden>
        <i />
        <i />
        <i />
      </span>
      <span>{detail || 'Working'}</span>
      {since && secs >= 5 && <span className="working-time">{fmtDuration(secs * 1000)}</span>}
    </div>
  );
}

// ---------------------------------------------------------------- messages

/**
 * A person's message. Its author shows above it when that is news: always in the shared orchestrator chat (no
 * owner), and in an agent's chat when someone other than the person it works for (`owner`) wrote it.
 */
function UserMessage({ ev, sessionId, owner }: { ev: UserEv; sessionId: string; owner?: string }) {
  const author = ev.requestedBy && ev.requestedBy.userId !== owner ? ev.requestedBy : undefined;
  return (
    <div className="msg msg-user" data-seq={ev.seq}>
      <time className="msg-side-time" dateTime={ev.t} title={new Date(ev.t).toLocaleString()}>
        {fmtClock(ev.t)}
      </time>
      <div className="msg-user-body">
        {author && (
          <span className="msg-author" title={author.userId} data-testid="msg-author">
            {author.displayName}
          </span>
        )}
        {ev.images?.length ? <ImageStrip items={ev.images.map((r, i) => ({ src: uploadUrl(sessionId, r), name: `image-${ev.seq}-${i + 1}.${r.mediaType.split('/')[1]}` }))} /> : null}
        {ev.attachments?.length ? <AttachmentList items={ev.attachments} /> : null}
        {ev.text && (
          <div className="bubble">
            <div className="bubble-text">{ev.text}</div>
          </div>
        )}
      </div>
    </div>
  );
}

/** A message the orchestrator sent this agent: its brief or a follow-up. Long ones are folded. */
function Brief({ ev }: { ev: UserEv }) {
  const [open, setOpen] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  const [long, setLong] = useState(false);
  useLayoutEffect(() => {
    const el = body.current;
    if (el) setLong(el.scrollHeight > el.clientHeight + 4);
  }, [ev.text]);
  return (
    <div className={`brief${long ? ' is-long' : ''}${open ? ' open' : ''}`} data-seq={ev.seq}>
      <div className="brief-head">
        <Icon name="chat" size={13} />
        <span>From the orchestrator{ev.requestedBy ? `, for ${ev.requestedBy.displayName}` : ''}</span>
        <time dateTime={ev.t} title={new Date(ev.t).toLocaleString()}>
          {fmtClock(ev.t)}
        </time>
      </div>
      <div className="brief-body" ref={body}>
        <Markdown text={ev.text} />
      </div>
      {ev.attachments?.length ? <AttachmentList items={ev.attachments} /> : null}
      {(long || open) && (
        <button className="link-btn brief-more" onClick={() => setOpen(!open)}>
          {open ? 'Show less' : 'Show all'}
        </button>
      )}
    </div>
  );
}

function AssistantMessage({ ev, end, sessionId }: { ev: AssistantEv; end?: ResultEv; sessionId: string }) {
  // The copies kept with the transcript once the server has them (server/inlineImages.ts); until then, the files.
  const src = useMemo(() => {
    const kept = new Map((ev.images ?? []).flatMap((i) => (i.path ? [[i.path, uploadUrl(sessionId, i)] as const] : [])));
    return (p: string) => kept.get(p) ?? fileUrl({ session: sessionId }, p);
  }, [ev.images, sessionId]);
  return (
    <div className="msg msg-assistant" data-seq={ev.seq} data-turn-end={end ? (end.ok ? 'ok' : 'stopped') : undefined}>
      <LocalImages.Provider value={src}>
        <Markdown text={ev.text} />
      </LocalImages.Provider>
      <MentionedImages text={ev.text} src={src} />
      <div className="msg-meta">
        <time dateTime={ev.t} title={new Date(ev.t).toLocaleString()}>
          {fmtClock(ev.t)}
        </time>
        {end && (
          <span title={`${end.turns} model turn${end.turns === 1 ? '' : 's'}`}>
            {fmtDuration(end.durationMs)} · {fmtCost(end.costUsd)}
          </span>
        )}
      </div>
    </div>
  );
}

const EventRow = memo(function EventRow({ ev, sessionId, pending }: { ev: TranscriptEvent; sessionId: string; pending: Map<string, PendingPermission> }) {
  switch (ev.kind) {
    case 'result':
      return (
        <div className="turn-stopped" data-seq={ev.seq}>
          <Icon name="stop" size={12} />
          <span>
            Turn stopped{ev.text && ev.text !== 'done' ? `: ${ev.text.replace(/^stopped:\s*/, '')}` : ''}
          </span>
          <span className="dim">
            {fmtDuration(ev.durationMs)} · {fmtCost(ev.costUsd)}
          </span>
        </div>
      );
    case 'system':
      return (
        <div className="sys-line" data-seq={ev.seq}>
          {ev.text}
        </div>
      );
    case 'error':
      return (
        <div className="err-line" data-seq={ev.seq}>
          <strong>Error</strong> {ev.text}
        </div>
      );
    case 'permission': {
      const isPending = !ev.decision && pending.has(ev.requestId);
      const p = pending.get(ev.requestId);
      return <PermissionCard sessionId={sessionId} requestId={ev.requestId} toolName={ev.toolName} input={ev.input} reason={p?.reason} pending={isPending} decision={ev.decision} />;
    }
    case 'tool_result':
      return (
        <div className={`tool tool-orphan${ev.isError ? ' tool-error' : ''}`} data-seq={ev.seq}>
          <div className="tool-head static">
            <span className="tool-name">result</span>
            <span className="tool-summary">{ev.text.split('\n')[0]}</span>
          </div>
        </div>
      );
    default:
      return null;
  }
});

// ---------------------------------------------------------------- harness notices

const NOTICE_ICON: Record<NoticeKind, IconName> = {
  'worker-done': 'bot',
  'worker-permission': 'bell',
  heartbeat: 'pulse',
  'unity-blocked': 'alert',
  'delegation-request': 'inbox',
  'auto-started': 'bot',
  'auto-finished': 'check',
  'auto-expired': 'clock',
  reminder: 'clock',
  run: 'play',
  restarted: 'refresh',
  'restart-pending': 'refresh',
  'restart-cancelled': 'refresh',
  resumed: 'refresh',
  dispatch: 'inbox',
  'work-request': 'inbox',
  'work-update': 'inbox',
  ledger: 'clock',
  'person-message': 'chat',
  other: 'info',
};

/** What a notice names, as the page knows it now: each one only, so a row re-renders when its own things change. */
interface NoticeRefs {
  s?: SessionInfo;
  sb?: Sandbox;
  m?: Machine;
  standing?: StandingAgent;
  orchestratorId?: string;
}

function useNoticeRefs(n: Notice): NoticeRefs {
  return {
    s: useStore((st) => (n.sessionId && st.app ? sessionIndex(st.app.sessions).get(n.sessionId) : undefined)),
    sb: useStore((st) => (n.sandboxId ? st.app?.sandboxes.find((x) => x.id === n.sandboxId) : undefined)),
    m: useStore((st) => (n.machineId ? st.app?.machines.find((x) => x.id === n.machineId) : undefined)),
    standing: useStore((st) => (n.kind === 'delegation-request' ? st.app?.standingAgents.find((x) => x.name === n.standingName) : undefined)),
    orchestratorId: useStore((st) => st.app?.orchestratorId),
  };
}

/** A notice's line with today's names (a session's title, a sandbox's label), and where it points. */
function describeNotice(n: Notice, { s, sb, m, standing, orchestratorId }: NoticeRefs): { text: string; route?: Route; where?: string } {
  const agent = s?.title ?? n.agentTitle;
  const placeName = sb ? displayName(sb) : m ? displayName(m) : n.sandboxId ?? n.machineId;
  const where = placeName && !(agent && sameTitle(agent, placeName)) ? placeName : undefined;
  const route: Route | undefined = s && orchestratorId !== undefined ? sessionRoute(s, { orchestratorId }) : sb ? { view: 'sandbox', sandboxId: sb.id } : m ? { view: 'machine', machineId: m.id } : undefined;
  switch (n.kind) {
    case 'worker-done':
      return { text: `${agent ?? 'A worker'} finished a turn`, route, where };
    case 'worker-permission':
      return { text: `${agent ?? 'A worker'} wants to use ${n.tool}${n.detail ? `: ${n.detail}` : ''}`, route, where };
    case 'unity-blocked':
      return { text: `${n.summary}${placeName ? ` in ${placeName}` : ''}`, route: sb ? { view: 'sandbox', sandboxId: sb.id } : undefined };
    case 'delegation-request':
      return { text: n.summary, route: standing ? { view: 'agent', agentId: standing.id, tab: 'delegations' } : undefined };
    case 'auto-started':
    case 'auto-finished':
      return { text: n.summary, route, where: placeName };
    case 'dispatch':
    case 'work-request':
    case 'work-update':
      // The request on the dispatcher's page (docs/orchestrators.md).
      return { text: n.summary, route: n.workId ? { view: 'dispatcher', tab: n.workId } : { view: 'dispatcher' } };
    case 'person-message':
      // The sender's own chat (read only here), where their side of it is.
      return { text: n.summary, route: n.fromUserId ? { view: 'chat', userId: n.fromUserId } : undefined };
    default:
      return { text: n.summary, route };
  }
}

/** A message from the harness, not from the user: one quiet line with an icon; amber when it needs the user. */
function NoticeRow({ ev }: { ev: UserEv }) {
  const n = useMemo(() => parseNotice(ev.text), [ev.text]);
  const d = describeNotice(n, useNoticeRefs(n));
  // A message from another person is to be read, not skimmed: it starts open.
  const [open, setOpen] = useState(n.kind === 'person-message');
  return (
    <div className={`notice${n.attention ? ' notice-attn' : ''}${open ? ' open' : ''}`} data-seq={ev.seq}>
      <div className="notice-row">
        <button className="notice-head" onClick={() => setOpen(!open)} aria-expanded={open} title={open ? 'Hide the full text' : 'Show the full text'}>
          <Icon name={NOTICE_ICON[n.kind]} size={14} />
          <span className="notice-text">
            {d.text}
            {d.where && <span className="notice-where"> · {d.where}</span>}
          </span>
          <time dateTime={ev.t} title={new Date(ev.t).toLocaleString()}>
            {fmtClock(ev.t)}
          </time>
        </button>
        {d.route && (
          <button className="notice-open" onClick={() => navigate(d.route!)} title="Open it">
            Open <Icon name="chevron" size={11} />
          </button>
        )}
      </div>
      {open && <div className="notice-body">{n.kind === 'worker-done' || n.kind === 'auto-finished' ? <Markdown text={n.body ?? ev.text} /> : <div className="pre-wrap">{n.body ?? ev.text}</div>}</div>}
    </div>
  );
}

// ---------------------------------------------------------------- tool calls and thinking

const RESULT_PREVIEW = 1600;

function resultImages(sessionId: string, result: ToolResult) {
  return (result.images ?? []).map((r, i) => ({ src: uploadUrl(sessionId, r), name: `result-${result.seq}-${i + 1}.${r.mediaType.split('/')[1]}` }));
}

/** A run of tool calls and thinking as one line: "Used 3 tools · list sandboxes, …"; opens to the calls. */
const ActivityGroup = memo(function ActivityGroup({ steps, sessionId, live }: { steps: Step[]; sessionId: string; live: boolean }) {
  const [open, setOpen] = useState(false);
  const seqs = seqsOf(steps);
  const focus = useStore((s) => s.focusEvent);
  useEffect(() => {
    if (focus?.sessionId === sessionId && seqs.includes(focus.seq)) setOpen(true);
  }, [focus]);
  const calls = steps.filter((s): s is Extract<Step, { kind: 'tool' }> => s.kind === 'tool');
  const tools = steps.filter((s) => s.kind !== 'thinking').length;
  const thoughts = steps.length - tools;
  const failed = steps.filter((s) => (s.kind === 'tool' ? s.result?.isError : s.kind === 'orphan' ? s.result.isError : false)).length;
  const inFlight = live ? calls.findLast((s) => !s.result) : undefined;
  const images = steps.flatMap((s) => (s.kind === 'tool' && s.result ? resultImages(sessionId, s.result) : s.kind === 'orphan' ? resultImages(sessionId, s.result) : []));
  const one = calls.length === 1 && tools === 1 ? calls[0] : undefined;
  const label = inFlight
    ? `Running ${toolLabel(inFlight.use.name)}…`
    : tools
      ? `${thoughts ? 'Thought, used' : 'Used'} ${tools} tool${tools === 1 ? '' : 's'}`
      : 'Thought';
  const names = one ? `${toolLabel(one.use.name)}${summarizeToolInput(one.use.name, one.use.input) ? `: ${summarizeToolInput(one.use.name, one.use.input)}` : ''}` : toolsSummary(calls.map((s) => s.use.name));
  return (
    <div className={`activity${open ? ' open' : ''}${live ? ' live' : ''}`} data-seqs={` ${seqs.join(' ')} `}>
      <button className="activity-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Icon name="chevron" size={12} />
        {inFlight ? <span className="spinner spinner-sm" /> : <Icon name={tools ? 'tools' : 'bulb'} size={13} />}
        <span className="activity-label">{label}</span>
        {tools > 0 && names && <span className="activity-names">{names}</span>}
        {failed > 0 && <span className="activity-failed">{failed} failed</span>}
      </button>
      {!open && images.length > 0 && <ImageStrip items={images} />}
      {open && (
        <div className="activity-body">
          {steps.map((s) =>
            s.kind === 'tool' ? (
              <ToolRow key={s.use.seq} use={s.use} result={s.result} sessionId={sessionId} />
            ) : s.kind === 'orphan' ? (
              <EventRow key={s.result.seq} ev={s.result} sessionId={sessionId} pending={EMPTY} />
            ) : (
              <Thinking key={s.ev.seq} ev={s.ev} />
            ),
          )}
        </div>
      )}
    </div>
  );
});

const EMPTY = new Map<string, PendingPermission>();

function Thinking({ ev }: { ev: ThinkingEv }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`thinking${open ? ' open' : ''}`} data-seq={ev.seq}>
      <button className="thinking-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Icon name="chevron" size={11} /> <span className="thinking-label">Thinking</span>
        {!open && <span className="thinking-peek">{ev.text.replace(/\s+/g, ' ').slice(0, 160)}</span>}
      </button>
      {open && <div className="thinking-body">{ev.text}</div>}
    </div>
  );
}

const ToolRow = memo(function ToolRow({ use, result, sessionId }: { use: ToolUse; result?: ToolResult; sessionId: string }) {
  const [open, setOpen] = useState(false);
  const [full, setFull] = useState(false);
  const { server, tool } = toolDisplayName(use.name);
  const summary = summarizeToolInput(use.name, use.input);
  const state = !result ? 'pending' : result.isError ? 'error' : 'ok';
  const resultText = result?.text ?? '';
  const truncated = resultText.length > RESULT_PREVIEW && !full;

  return (
    <div className={`tool tool-${state}${use.parentToolUseId ? ' tool-nested' : ''}${open ? ' open' : ''}`} data-seq={use.seq} data-seq2={result?.seq}>
      <button className="tool-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="tool-state" />
        <span className="tool-name" title={server ? `${server} · ${tool}` : tool}>
          {toolLabel(use.name)}
        </span>
        <span className="tool-summary">{summary}</span>
        <Icon name="chevron" size={11} />
      </button>
      {result?.images?.length ? <ImageStrip size="small" items={resultImages(sessionId, result)} /> : null}
      {open && (
        <div className="tool-body">
          <ToolInput name={use.name} input={use.input} />
          {result && (
            <div className="tool-result">
              <div className="tool-sub">{result.isError ? 'Error' : 'Result'}</div>
              <pre className="code">{truncated ? resultText.slice(0, RESULT_PREVIEW) + '\n…' : resultText || '(empty)'}</pre>
              {resultText.length > RESULT_PREVIEW && (
                <button className="btn btn-ghost btn-xs" onClick={() => setFull(!full)}>
                  {full ? 'Collapse' : `Show all (${resultText.length.toLocaleString()} characters)`}
                </button>
              )}
            </div>
          )}
          {!result && <div className="tool-sub dim">Waiting for the result…</div>}
        </div>
      )}
    </div>
  );
});

function ToolInput({ name, input }: { name: string; input: unknown }) {
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  if (name === 'Bash' && typeof o.command === 'string') {
    return (
      <>
        {typeof o.description === 'string' && <div className="tool-sub">{o.description}</div>}
        <pre className="code code-cmd">{o.command}</pre>
      </>
    );
  }
  if (name === 'Edit' && typeof o.old_string === 'string' && typeof o.new_string === 'string') {
    return (
      <>
        <div className="tool-sub mono">{String(o.file_path ?? '')}</div>
        <pre className="code diff">
          {o.old_string.split('\n').map((l, i) => (
            <div key={'o' + i} className="diff-del">
              - {l}
            </div>
          ))}
          {o.new_string.split('\n').map((l, i) => (
            <div key={'n' + i} className="diff-add">
              + {l}
            </div>
          ))}
        </pre>
      </>
    );
  }
  return <pre className="code">{prettyJson(input)}</pre>;
}

// ---------------------------------------------------------------- permission requests

function PermissionCard({
  sessionId,
  requestId,
  toolName,
  input,
  reason,
  pending,
  decision,
}: {
  sessionId: string;
  requestId: string;
  toolName: string;
  input: unknown;
  reason?: string;
  pending: boolean;
  decision?: 'allow' | 'deny';
}) {
  const [busy, setBusy] = useState(false);
  const [denyOpen, setDenyOpen] = useState(false);
  const [note, setNote] = useState('');
  const [showInput, setShowInput] = useState(false);
  const summary = summarizeToolInput(toolName, input);

  const decide = async (allow: boolean, message?: string) => {
    setBusy(true);
    await attempt(api.permission(sessionId, requestId, allow, message));
    setBusy(false);
  };

  const cls = pending ? 'pending' : decision === 'allow' ? 'allowed' : decision === 'deny' ? 'denied' : 'resolved';
  const answeredBy = useContext(ReadOnly);

  if (!pending || answeredBy) {
    return (
      <div className={`perm perm-${cls}`} data-request-id={requestId}>
        <div className="perm-head">
          <Icon name={decision === 'deny' ? 'x' : decision === 'allow' ? 'check' : 'bell'} size={13} />
          <span className="perm-title">{decision === 'allow' ? 'Allowed' : decision === 'deny' ? 'Denied' : pending && answeredBy ? `Waiting for ${answeredBy}` : 'Permission request'}</span>
          <span className="perm-tool">{toolLabel(toolName)}</span>
          {summary && <span className="perm-summary-inline">{summary}</span>}
        </div>
      </div>
    );
  }

  return (
    <div className={`perm perm-${cls}`} data-request-id={requestId}>
      <div className="perm-head">
        <Icon name="bell" size={14} />
        <span className="perm-title">Wants to use {toolLabel(toolName)}</span>
      </div>
      {summary && <div className="perm-summary">{summary}</div>}
      {reason && <div className="perm-reason">{reason}</div>}
      <button className="link-btn" onClick={() => setShowInput(!showInput)}>
        {showInput ? 'Hide the details' : 'Show the details'}
      </button>
      {showInput && <ToolInput name={toolName} input={input} />}
      {!denyOpen && (
        <div className="perm-actions">
          <button className="btn btn-primary" disabled={busy} onClick={() => decide(true)}>
            <Icon name="check" size={14} /> Allow
          </button>
          <button className="btn btn-outline" disabled={busy} onClick={() => decide(false)}>
            <Icon name="x" size={14} /> Deny
          </button>
          <button className="link-btn" disabled={busy} onClick={() => setDenyOpen(true)}>
            Deny and say why…
          </button>
        </div>
      )}
      {denyOpen && (
        <form
          className="perm-deny"
          onSubmit={(e) => {
            e.preventDefault();
            void decide(false, note.trim() || undefined);
          }}
        >
          <input autoFocus {...FREE_TEXT} className="input" placeholder="Tell the agent what to do instead" value={note} onChange={(e) => setNote(e.target.value)} />
          <button className="btn btn-danger" disabled={busy} type="submit">
            Deny
          </button>
          <button className="btn btn-ghost" type="button" onClick={() => setDenyOpen(false)}>
            Cancel
          </button>
        </form>
      )}
    </div>
  );
}
