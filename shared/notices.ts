// The harness's own messages to an agent ([worker update], [heartbeat], [unity blocked], …) as the page
// shows them: what kind, a one-line summary, whether it needs the user, and the ids to turn into names
// and links. The formats are the server's (agents.ts, standing.ts, wake.ts, restart.ts). No imports, so
// the browser bundle and `node --test` can both load it.

export type NoticeKind =
  | 'worker-done'
  | 'worker-permission'
  | 'heartbeat'
  | 'unity-blocked'
  | 'delegation-request'
  | 'auto-started'
  | 'auto-finished'
  | 'auto-expired'
  | 'reminder'
  | 'run'
  | 'restarted'
  | 'restart-pending'
  | 'restart-cancelled'
  | 'resumed'
  | 'dispatch'
  | 'work-request'
  | 'work-update'
  | 'ledger'
  | 'person-message'
  | 'other';

export interface Notice {
  kind: NoticeKind;
  /** One line, plain text. Names appear as the harness wrote them; the page may swap in current labels. */
  summary: string;
  /** Something the user has to act on (a permission, a stuck editor, a delegation request). */
  attention: boolean;
  /** The part worth reading when opened: a worker's final message, the busy list, the dialog. */
  body?: string;
  /** Who: the agent (session) and where it runs. */
  agentTitle?: string;
  sessionId?: string;
  sandboxId?: string;
  machineId?: string;
  /** A standing agent's name, and its delegation request. */
  standingName?: string;
  requestId?: string;
  /** The tool a worker waits to use, and what it wants to do with it. */
  tool?: string;
  detail?: string;
  /** A work request in the ledger ("w13"), docs/orchestrators.md. */
  workId?: string;
  /** The person another person's message is from (message_person), by user id and name. */
  fromUserId?: string;
  fromName?: string;
}

/** A harness message starts with its tag: [worker update], [heartbeat], [run r-12], … */
export const NOTICE_TAG = /^\[([a-z_][a-z0-9_ -]*)\]\s*/i;

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

/** `agent "T" (session S) (requested by P) in sandbox X` / `on machine M`: the worker a [worker update] is about. */
const WORKER = /^agent "(.+?)" \(session ([\w-]+)\)(?: \(requested by .*?\))? (?:in sandbox ([\w.-]+(?:\/[\w.-]+)?|\?)|on machine ([\w.-]+))/;

/** What a tool call wants, in a few words: the command, the file, or the first string it was given. */
function describeInput(tool: string, json: string): string | undefined {
  try {
    const o = JSON.parse(json) as Record<string, unknown>;
    const s = (v: unknown) => (typeof v === 'string' ? v : undefined);
    const hit = tool === 'Bash' ? s(o.command) : (s(o.file_path) ?? s(o.command) ?? Object.values(o).map(s).find(Boolean));
    return hit ? clip(oneLine(hit), 140) : undefined;
  } catch {
    return undefined;
  }
}

export function parseNotice(text: string): Notice {
  const m = NOTICE_TAG.exec(text);
  const tag = m?.[1].toLowerCase();
  const rest = m ? text.slice(m[0].length) : text;

  if (tag === 'worker update') {
    const w = WORKER.exec(rest);
    const who = w ? { agentTitle: w[1], sessionId: w[2], sandboxId: w[3] && w[3] !== '?' ? w[3] : undefined, machineId: w[4] } : {};
    const done = /finished a turn\. Its final message:\s*([\s\S]*?)\s*(?:\n\nTell the user what matters[\s\S]*)?$/.exec(rest);
    if (done) return { kind: 'worker-done', summary: `${w?.[1] ?? 'A worker'} finished a turn`, attention: false, body: done[1].trim() || undefined, ...who };
    const perm = /is waiting for permission to use (\S+) with ([\s\S]*?)\. You cannot approve it/.exec(rest);
    if (perm) {
      return { kind: 'worker-permission', summary: `${w?.[1] ?? 'A worker'} is waiting for your permission to use ${perm[1]}`, attention: true, tool: perm[1], detail: describeInput(perm[1], perm[2]), ...who };
    }
    return { kind: 'other', summary: clip(oneLine(rest), 160), attention: false, body: rest, ...who };
  }

  if (tag === 'heartbeat') {
    const n = /^(\d+) worker\(s\) busy:/.exec(rest);
    const lines = rest.split('\n').filter((l) => l.startsWith('- '));
    return { kind: 'heartbeat', summary: n ? `Heartbeat: ${n[1]} ${n[1] === '1' ? 'worker' : 'workers'} busy` : 'Heartbeat', attention: false, body: lines.length ? lines.join('\n') : undefined };
  }

  if (tag === 'unity blocked') {
    const u = /^The Unity editor of sandbox ([\w.-]+) is stuck on (?:a "(.+?)" dialog|(.+?) \()/.exec(rest);
    const title = u?.[2] ?? u?.[3];
    return {
      kind: 'unity-blocked',
      summary: title ? `Unity is stuck on “${title}”` : 'Unity is stuck',
      attention: true,
      sandboxId: u?.[1],
      body: rest.replace(/\s*Its workers see "blocked"[\s\S]*$/, '').trim(),
    };
  }

  if (tag === 'standing agent') {
    const d = /^"(.+?)" asks for a sandbox worker \(delegation request ([\w-]+)\): "(.+?)"\./.exec(rest);
    if (d) return { kind: 'delegation-request', summary: `${d[1]} asks for a worker: ${d[3]}`, attention: true, standingName: d[1], requestId: d[2] };
    return { kind: 'other', summary: clip(oneLine(rest), 160), attention: false, body: rest };
  }

  if (tag === 'auto-delegation') {
    const started = /^Started worker ([\w-]+) in (?:sandbox ([\w.-]+)|machine ([\w.-]+)) for "(.+?)": "(.+?)"/.exec(rest);
    if (started) {
      return { kind: 'auto-started', summary: `${started[4]} started a worker on its own: ${started[5]}`, attention: false, sessionId: started[1], sandboxId: started[2], machineId: started[3], standingName: started[4] };
    }
    const finished = /^Worker ([\w-]+) \((?:sandbox ([\w.-]+)|machine ([\w.-]+))\) for "(.+?)" finished: ([\s\S]*?)\. One line for the user/.exec(rest);
    if (finished) {
      return { kind: 'auto-finished', summary: `${finished[4]}'s worker finished`, attention: false, sessionId: finished[1], sandboxId: finished[2], machineId: finished[3], standingName: finished[4], body: finished[5] };
    }
    const expired = /^Request ([\w-]+) from "(.+?)" \("(.+?)"\) expired/.exec(rest);
    if (expired) return { kind: 'auto-expired', summary: `${expired[2]}'s request expired: ${expired[3]}`, attention: false, requestId: expired[1], standingName: expired[2] };
    return { kind: 'other', summary: clip(oneLine(rest), 160), attention: false, body: rest };
  }

  if (tag === 'wake_me') {
    const note = /Your note:\s*([\s\S]*)$/.exec(rest)?.[1].trim();
    return { kind: 'reminder', summary: note && note !== '(none)' ? `Reminder: ${clip(oneLine(note), 140)}` : 'Reminder', attention: false };
  }

  if (tag?.startsWith('run ')) {
    const why = /—\s*(.+?)\.(?:\n|$)/.exec(rest)?.[1];
    const says = /\n[^\n]* says:\n([\s\S]*)$/.exec(rest)?.[1].trim();
    return { kind: 'run', summary: `Run started${why ? `: ${why}` : ''}`, attention: false, body: says };
  }

  // The work ledger (docs/orchestrators.md): the dispatcher's decisions in a person's chat, and requests in its own.
  if (tag === 'dispatch') {
    const [head, ...note] = rest.split('\n');
    const d = /^(w\d+) "(.+?)": ([\s\S]*)\.$/.exec(head.trim());
    if (!d) return { kind: 'dispatch', summary: clip(oneLine(rest), 160), attention: false, body: rest };
    const [, workId, title, what] = d;
    const question = what.startsWith('a question');
    const said = note.join('\n').trim();
    // The decision first, so it survives a narrow screen: "Merged into w15: “Belts drop items…”".
    const verdict =
      /^merged into (w\d+)/.exec(what)?.[0].replace(/^m/, 'M') ??
      (/^started /.test(what) ? 'Started' : /^sent to /.test(what) ? 'Given to its worker' : /^linked to /.test(what) ? 'Linked to a running worker' : /^approved /.test(what) ? 'Approved' : what.charAt(0).toUpperCase() + what.slice(1));
    const body = question ? said || undefined : [`${workId}: ${what}.`, said].filter(Boolean).join('\n');
    return { kind: 'dispatch', summary: question ? `The dispatcher asks about “${clip(title, 70)}”` : `${verdict}: “${clip(title, 90)}”`, attention: question, body, workId };
  }
  if (tag === 'work request') {
    const r = /^(w\d+) from (.+?)(?: \((?:low|high|urgent)\))?: "(.+?)"/.exec(rest);
    const more = (text.match(/^\[work (?:request|update)\]/gm)?.length ?? 1) - 1;
    const summary = r ? `${r[2]} asks: “${clip(r[3], 90)}”${more ? ` (and ${more} more)` : ''}` : 'A work request';
    return { kind: 'work-request', summary, attention: false, body: rest.trim(), workId: r?.[1] };
  }
  if (tag === 'work update') {
    const u = /^(w\d+) "(.+?)" \(\w+\) from (.+?): /.exec(rest);
    return { kind: 'work-update', summary: u ? `${u[3]} updated “${clip(u[2], 90)}”` : 'A request was updated', attention: false, body: rest.trim(), workId: u?.[1] };
  }
  if (tag === 'ledger') {
    const waiting = /Requests waiting for you: ([\s\S]*?)\. list_work shows/.exec(rest)?.[1];
    if (waiting) return { kind: 'ledger', summary: `${waiting.split('; ').length} request(s) still waiting`, attention: false, body: rest.trim() };
    const queued = /Queued: ([\s\S]*?)\. Start what fits/.exec(rest)?.[1];
    const n = queued ? queued.split('; ').length : 0;
    return { kind: 'ledger', summary: `Capacity may have freed${n ? `; ${n} queued` : ''}`, attention: false, body: rest.trim() };
  }

  // Another person's message, written by their orchestrator (server/orchestrators.ts personMessage).
  if (tag === 'person message') {
    const p = /^From (.+?)'s orchestrator \(user id ([^)]+)\), written for \1:\n\n([\s\S]*)\n\nThis is \1's message to /.exec(rest);
    if (p) return { kind: 'person-message', summary: `${p[1]}: ${clip(oneLine(p[3]), 150)}`, attention: true, body: p[3].trim(), fromName: p[1], fromUserId: p[2] };
    return { kind: 'person-message', summary: clip(oneLine(rest), 160), attention: true, body: rest.trim() };
  }
  if (tag === 'app restarted') return { kind: 'restarted', summary: 'SketchUp Factory restarted', attention: false, body: rest.trim() };
  if (tag === 'app restart pending') return { kind: 'restart-pending', summary: 'SketchUp Factory is about to restart', attention: false, body: rest.trim() };
  if (tag === 'app restart cancelled') return { kind: 'restart-cancelled', summary: 'The restart was called off', attention: false, body: rest.trim() };
  if (/^The app restarted \(/.test(text)) return { kind: 'resumed', summary: 'The app restarted; this session was resumed', attention: false, body: text.trim() };

  return { kind: 'other', summary: clip(oneLine(rest), 160) || 'Note from the harness', attention: false, body: rest.length > 160 || rest.includes('\n') ? rest : undefined };
}
