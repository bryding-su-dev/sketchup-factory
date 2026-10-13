// A person's 👍/✅ or 👎/❌ on their orchestrator's proposal, as their own words for that action (w1039; docs/orchestrators.md,
// "A reaction can be the person's own answer"). Pure text rules, no imports: the server (Orchestrators.reactionTurn) asks
// them whether a click covers the call a gate is about to refuse, and the tests run them without a portal.
//
// A click is scoped to what the message it is on proposes: a sentence of that message must name the request (or whatever the
// call is about) and the action together, and the message must be an offer or a question. Nothing else in the turn is covered.

export const YES_EMOJI = ['👍', '✅'] as const;
export const NO_EMOJI = ['👎', '❌'] as const;

/** What a reaction can stand in for. Each is a gate that needs the person's own words. */
export type GateVerb = 'approve' | 'decline' | 'close_done' | 'close_cancelled' | 'main_clone' | 'deploy' | 'restart' | 'job' | 'approve_delegation';

/** What the call a gate is about to refuse is: the action, the things it names, and facts the proposal must mention. */
export interface GateNeed {
  verb: GateVerb;
  /** Each must be in the sentence that proposes the action: a request id ("w983"), a delegation id. */
  refs?: string[];
  /** Each must be somewhere in the message: the fact a conditional decision waits for ("w1037", a pull request). */
  also?: string[];
}

/** One click that is armed: an answer to a proposal the orchestrator made, good for a while and for what it proposed. */
export interface ReactionGrant {
  /** The message it is on (a transcript seq) and the emoji. */
  seq: number;
  emoji: string;
  yes: boolean;
  /** When the person clicked (ms). */
  at: number;
  /** The orchestrator's message, its own words (clipped to PROPOSAL_CHARS). */
  text: string;
  /** What this grant already did (verb + refs), so one click does each thing once. */
  used: string[];
}

/** How long a click stays armed (ms): the orchestrator may be busy, and a proposal goes stale. A guess. */
export const GRANT_MS = 2 * 3_600_000;
/** How old a proposal may be when the person clicks it (ms). A guess; the gates still check the request's state. */
export const PROPOSAL_MAX_AGE_MS = 48 * 3_600_000;
/** How much of the message is read for what it proposes. */
export const PROPOSAL_CHARS = 6000;

const DONE_WORDS = /\bdone\b|\bhandled\b|\bresolv|\bfinished\b|\bcomplete|\bshipped\b|\bfixed\b/i;
const CANCEL_WORDS = /\bcancel|\bdrop|\bwithdraw|\babandon|\bduplicate|\bwon'?t (do|fix)\b|\bnot needed\b|\bobsolete\b/i;
const CLOSE = /\bclos(e|es|ing)\b/i;

/** Whether a sentence proposes the action: a bare "close" means done unless it says cancel, and cancel unless it says done. */
const VERBS: Record<GateVerb, (sentence: string) => boolean> = {
  approve: (s) => /\bapprov|\baccept|\bgreen-?light|\bgo ahead|\blet (it|them) (run|through|in)\b/i.test(s),
  decline: (s) => /\bdeclin|\breject|\bturn(ing)? (it |them )?down\b|\brefus/i.test(s),
  close_done: (s) => DONE_WORDS.test(s) || (CLOSE.test(s) && !CANCEL_WORDS.test(s)),
  close_cancelled: (s) => CANCEL_WORDS.test(s) || (CLOSE.test(s) && !DONE_WORDS.test(s)),
  main_clone: (s) => /main[\s_-]?clone/i.test(s),
  deploy: (s) => /\bdeploy/i.test(s),
  restart: (s) => /\brestart/i.test(s),
  job: () => true,
  approve_delegation: (s) => /\bapprov|\baccept|\bgo ahead/i.test(s),
};

const OFFER_WORDS = /\b(can|could|shall|should|want|wish|propose|proposal|suggest|recommend|let me|i'?ll|i will|would you|ok to|okay to|go ahead|say (so|if|the word)|ready to|plan to|about to|ok if|okay if|may i|do you)\b/i;

/** Whether the text asks a question or makes an offer or proposal; a status report with a word in it is not one. */
export function proposes(text: string): boolean {
  return text.includes('?') || OFFER_WORDS.test(text);
}

/** The sentences and lines of a text, which is how far a proposal reaches ("close w983" and "w1037" in one sentence). */
export function sentencesOf(text: string): string[] {
  return text
    .split(/\n+|(?<=[.!?])\s+(?=\S)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whether `ref` is named in `text`: "w983" and not "w9830"; a pull request "owner/repo#123" by that or by "#123" alone. */
export function mentions(text: string, ref: string): boolean {
  const r = ref.trim();
  if (!r) return false;
  const forms = [r];
  const pr = /#(\d+)$/.exec(r);
  if (pr) forms.push(`#${pr[1]}`);
  return forms.some((f) => new RegExp(`(?<![\\w])${esc(f)}(?![\\w])`, 'i').test(text));
}

/**
 * Whether a click covers `need`. Returns the sentence of the proposal it answered (the person's words for the record), or
 * undefined. A yes (👍 ✅) covers the action the message proposes: the verb and every ref in one sentence of an offer or a
 * question. A no (👎 ❌) is not a yes to anything; its one use is declining an intake request whose approval the message
 * proposed ("shall I approve w5?" and 👎: declined, the only other way to answer it).
 */
export function grantCovers(g: ReactionGrant, need: GateNeed): string | undefined {
  const key = grantKey(need);
  if (g.used.includes(key)) return undefined;
  if (!proposes(g.text)) return undefined;
  const refs = need.refs ?? [];
  if (need.verb === 'job' && !refs.length) return undefined;
  let verb: (sentence: string) => boolean;
  if (g.yes) verb = VERBS[need.verb];
  else if (need.verb === 'decline') verb = VERBS.approve;
  else return undefined;
  if ((need.also ?? []).some((a) => !mentions(g.text, a))) return undefined;
  const hit = sentencesOf(g.text).find((s) => refs.every((r) => mentions(s, r)) && verb(s));
  return hit ? hit : undefined;
}

export const grantKey = (need: GateNeed) => `${need.verb} ${(need.refs ?? []).join(',').toLowerCase()}`;

/** `👍 on #22038: "...close w983 as handled..."`: what a decision's record says it rests on. */
export function grantWords(g: Pick<ReactionGrant, 'emoji' | 'seq'>, sentence: string): string {
  const own = sentence.replace(/\s+/g, ' ').trim();
  const clipped = own.length > 240 ? `${own.slice(0, 240).trimEnd()}...` : own;
  return `${g.emoji} on #${g.seq}: "...${clipped}..."`;
}

/** The proposal's own words, for grants: the message minus an earlier quote or FF Factory note, clipped. */
export function proposalText(text: string, held: string, mark: string): string {
  let own = text.split(mark)[0];
  if (held) own = own.split(held)[0];
  own = own.trim();
  return own.length > PROPOSAL_CHARS ? own.slice(0, PROPOSAL_CHARS) : own;
}

export const isYes = (emoji: string) => (YES_EMOJI as readonly string[]).includes(emoji);
export const isNo = (emoji: string) => (NO_EMOJI as readonly string[]).includes(emoji);
