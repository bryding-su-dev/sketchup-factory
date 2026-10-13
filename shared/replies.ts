// Replies and emoji reactions in a person's orchestrator chat (w866; docs/orchestrators.md, "Replies and reactions").
// Both reach the orchestrator as text that quotes the message they are on, so the quote survives the send queue, a restart's
// resume and the transcript. The page reads the same text back (splitReply, parseReaction) to draw the quote and the
// reaction chips. No imports, so the browser bundle and `node --test` can both load it.

/**
 * Where FF Factory's quote starts in a person's reply: what follows is the quoted message (data), never the person's words.
 * The page and the orchestrator's prompt both read only what comes before it as the person's own words.
 */
export const REPLY_MARK = '[FF Factory, not your person: the message they are replying to]';

/** The longest excerpt of the quoted message a reply or a reaction carries, in characters. */
export const EXCERPT_CHARS = 1200;

/** A message of the chat, as a reply or a reaction quotes it. */
export interface Quoted {
  /** Its transcript sequence number. */
  seq: number;
  /** Who said it: "the orchestrator", a person's name, or "a [worker update]" for a relayed line. */
  from: string;
  /** When, ISO. */
  at: string;
  /** Its text, clipped to EXCERPT_CHARS. */
  excerpt: string;
}

/** Emoji the page offers on a message; the server takes any single emoji. */
export const REACTION_PALETTE = ['👍', '👎', '✅', '❌', '❓', '👀', '🎉'] as const;

/** One line for what the common emoji mean, for the orchestrator and for docs. Anything else it reads from context. */
export const REACTION_MEANINGS = '👍 or ✅ = yes, go ahead, got it; 👎 or ❌ = no, don\'t; ❓ = I don\'t follow, explain; 👀 = seen, I\'ll look; 🎉 or ❤️ = nice, nothing to do';

const utc = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

/** The excerpt of a message's text: its own words only (an earlier quote or FF Factory note in it is left out), clipped. */
export function excerptOf(text: string, held = ''): string {
  let own = text.split(REPLY_MARK)[0];
  if (held) own = own.split(held)[0];
  own = own.trim();
  return own.length > EXCERPT_CHARS ? `${own.slice(0, EXCERPT_CHARS).trimEnd()}… (${own.length - EXCERPT_CHARS} more characters)` : own;
}

/** `#42 · the orchestrator · 2026-10-10 08:31 UTC` and the excerpt, each line quoted with "> ". */
export function quoteBlock(q: Quoted): string {
  const lines = (q.excerpt || '(no text)').split('\n').map((l) => `> ${l}`);
  return `#${q.seq} · ${q.from} · ${utc(q.at)}\n${lines.join('\n')}`;
}

/** A person's reply: their words, then FF Factory's mark and the quoted message. */
export function replyText(words: string, q: Quoted): string {
  return `${words.trim()}${words.trim() ? '\n\n' : ''}${REPLY_MARK}\n${quoteBlock(q)}`;
}

const QUOTE_HEAD = /^#(\d+) · (.+) · (\d{4}-\d\d-\d\d) (\d\d:\d\d) UTC$/;

/** Read a quote block back: the lines up to `until` (the next note of FF Factory's) or the end. */
function readQuote(block: string): Quoted | undefined {
  const lines = block.split('\n');
  const m = QUOTE_HEAD.exec(lines[0] ?? '');
  if (!m) return undefined;
  const excerpt = lines
    .slice(1)
    .filter((l) => l.startsWith('> ') || l === '>')
    .map((l) => l.slice(2))
    .join('\n');
  return { seq: Number(m[1]), from: m[2], at: `${m[3]}T${m[4]}:00.000Z`, excerpt: excerpt === '(no text)' ? '' : excerpt };
}

/**
 * A message's text apart from the reply quote it carries: the person's own words, and the quoted message when there is one.
 * `held`, when given, is where a later note of the harness's starts, which ends the quote.
 */
export function splitReply(text: string, held = ''): { words: string; quote?: Quoted } {
  const at = text.indexOf(REPLY_MARK);
  if (at < 0) return { words: text };
  const after = text.slice(at + REPLY_MARK.length).replace(/^\n/, '');
  const end = held ? after.indexOf(held) : -1;
  const block = (end < 0 ? after : after.slice(0, end)).replace(/\s+$/, '');
  const rest = end < 0 ? '' : after.slice(end);
  return { words: text.slice(0, at).trim() + (rest ? `\n\n${rest}` : ''), quote: readQuote(block) };
}

/** Whether `s` is one emoji (a pictograph with its modifiers, a flag, a keycap or a joined family), nothing else. */
export function isEmoji(s: string): boolean {
  if (!s || s.length > 32 || !/\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20E3/u.test(s)) return false;
  const seg = new Intl.Segmenter('en', { granularity: 'grapheme' });
  return [...seg.segment(s)].length === 1;
}

/**
 * What the orchestrator reads when its person reacts to a message: the emoji, the message it is on, and how to take it.
 * Sent as a harness message (`from: 'system'`): the click opens no turn of the person's. `armed` (w1039): the click answers
 * the orchestrator's own recent message with 👍 ✅ 👎 ❌, so FF Factory takes it as the person's own words for the action
 * that message proposes, for the gates that need them (Orchestrators.reactionTurn).
 */
export function reactionText(person: string, emoji: string, q: Quoted, armed = false): string {
  const head = `[reaction] ${person} reacted ${emoji} to a message in this chat:
${quoteBlock(q)}

Take it as ${person}'s short answer to that message: ${REACTION_MEANINGS}; any other emoji, by its usual meaning in that context.`;
  if (!armed) {
    return `${head} It is a click, not ${person}'s own words, so what needs their own words (approving or declining a request, deleting, settings, deploys, a release) still needs them to say it: ask in one line. Reply briefly, or just act on it.`;
  }
  const yes = emoji === '👍' || emoji === '✅';
  return `${head} This is your own message and ${person} answered it with ${yes ? 'a yes' : 'a no'}. FF Factory counts that click as ${person}'s OWN WORDS for the action that message proposes, and for nothing else in this turn: ${
    yes
      ? "the request and the action its sentence names together (approve, decline, close, a `when` decision, main_clone, a portal deploy or restart, a delegation approval) go through now with the usual tool call, and the decision's record shows the click and the sentence it answered (leave `words` out of a `when` call; FF Factory fills it in). Anything the message did not propose, or proposed unclearly, or proposed several of: do only what is clear and ask in one line about the rest."
      : "do not do what the message proposed. The one thing a no covers is declining an intake request whose approval the message proposed (update_work decline); otherwise take it as a no and say so in a line."
  } What the click cannot do, it is refused as before.`;
}

/** The record that a reaction was taken back; it is shown in the chat and not sent to the orchestrator. */
export function reactionRemovedText(emoji: string, seq: number): string {
  return `[reaction removed] ${emoji} #${seq}`;
}

export interface ReactionMark {
  /** The message it is on (a transcript seq). */
  to: number;
  emoji: string;
  on: boolean;
}

const REACTION_ON = /^\[reaction\] .+? reacted (\S+) to a message in this chat:\n#(\d+) · /u;
const REACTION_OFF = /^\[reaction removed\] (\S+) #(\d+)$/u;

/** A reaction put on a message, or taken off one, as the transcript records it; undefined for any other text. */
export function parseReaction(text: string): ReactionMark | undefined {
  const on = REACTION_ON.exec(text);
  if (on) return { to: Number(on[2]), emoji: on[1], on: true };
  const off = REACTION_OFF.exec(text);
  return off ? { to: Number(off[2]), emoji: off[1], on: false } : undefined;
}

/** The reactions on each message after replaying the chat in order: seq → emoji → count (one person's chat: 1 or 0). */
export function reactionsByMessage(texts: Iterable<{ text: string }>): Map<number, string[]> {
  const out = new Map<number, string[]>();
  for (const { text } of texts) {
    const r = parseReaction(text);
    if (!r) continue;
    const have = out.get(r.to) ?? [];
    const next = r.on ? (have.includes(r.emoji) ? have : [...have, r.emoji]) : have.filter((e) => e !== r.emoji);
    if (next.length) out.set(r.to, next);
    else out.delete(r.to);
  }
  return out;
}
