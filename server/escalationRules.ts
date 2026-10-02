// FFBox files dev work into the ledger (w94, docs/intake.md "Escalations from Max"). Max, answering on Discord for
// FFBox, decides a report needs a developer (a bug it did not or may not fix, a design question, an escalation), and
// FFBox's host posts it to POST /api/intake/ffbox with a key scoped to that endpoint alone. This is the check of that
// body and what it becomes in the ledger. Pure: server/intake.ts files it.
import { z } from 'zod';
import { classifyBug, cleanBlock, cleanLine, quoteUntrusted } from './intakeRules.ts';
import type { WorkSource, WorkTriage } from '../shared/types.ts';

const oneLine = /^[^\u0000-\u001f]*$/;
const cdn = /^https:\/\/(cdn\.discordapp\.com|media\.discordapp\.net)\/[^\s"'<>]{1,400}$/;

/** The body FFBox sends, version 1 (F:\ffsb\_w94\CONTRACT.md, published in docs/ffbox-connector-contract.md). */
export const EscalationSchema = z
  .object({
    v: z.literal(1),
    ref: z.string().regex(/^[A-Za-z0-9._:-]{1,80}$/),
    conversation: z.string().regex(/^[A-Za-z0-9._:-]{1,80}$/),
    kind: z.enum(['bug', 'design', 'escalation']),
    maxClass: z.enum(['obvious-bug', 'needs-human']),
    title: z.string().min(1).max(200).regex(oneLine, 'one line'),
    diagnosis: z.string().min(1).max(6000),
    report: z.string().max(4000).optional(),
    threadId: z.string().regex(/^\d{15,25}$/),
    url: z.string().max(300).regex(/^https:\/\/discord\.com\/channels\/\d{15,25}\/\d{15,25}(\/\d{15,25})?$/),
    channel: z.string().regex(/^[a-z0-9_]{1,40}$/),
    reporter: z.string().max(60).regex(oneLine, 'one line').optional(),
    version: z.string().regex(/^[A-Za-z0-9._+-]{1,40}$/).optional(),
    platform: z.string().regex(/^[A-Za-z0-9._+-]{1,40}$/).optional(),
    attachments: z
      .array(z.object({ name: z.string().min(1).max(120).regex(oneLine, 'one line'), url: z.string().regex(cdn), bytes: z.number().int().min(0).max(1e10).optional() }).strict())
      .max(10)
      .optional(),
    verdict: z.string().regex(/^[A-Z][A-Z-]{0,39}$/).optional(),
  })
  .strict();

export type Escalation = z.infer<typeof EscalationSchema>;

/** The body checked, or what was wrong with it: field names and rules, never the values. */
export function parseEscalation(raw: unknown): { escalation: Escalation } | { error: string } {
  const r = EscalationSchema.safeParse(raw);
  if (r.success) return { escalation: r.data };
  return { error: r.error.issues.slice(0, 5).map((i) => `${i.path.join('.') || '(body)'}: ${i.message}`).join('; ') };
}

const KIND_WORDS: Record<Escalation['kind'], string> = { bug: 'Discord bug', design: 'Design question', escalation: 'Escalation' };

/**
 * SketchUp Factory's own triage (w39), never Max's word for it: a bug is classified by the same fixed rules as any Discord
 * report, over the player's words and Max's title; a design question or escalation always needs a human.
 */
export function escalationTriage(e: Escalation): WorkTriage {
  const max = e.maxClass === 'obvious-bug' ? 'obvious bug' : 'needs a human';
  if (e.kind !== 'bug') return { class: 'needs-human', reason: `needs a human: a ${e.kind === 'design' ? 'design decision' : 'developer decision'} Max escalated (Max's call: ${max})` };
  const t = classifyBug({ title: cleanLine(e.title, 200), text: cleanBlock(e.report ?? '', 4000), version: e.version });
  return { class: t.class, reason: `${t.reason} (Max's call: ${max})` };
}

export function escalationTitle(e: Escalation): string {
  return cleanLine(`${KIND_WORDS[e.kind]} (via Max): ${cleanLine(e.title, 180)}`, 120);
}

/** The ledger source: a Discord thread FFBox answers, filed by FFBox (untrusted text throughout). */
export function escalationSource(e: Escalation): WorkSource {
  return {
    kind: 'ffbox-request',
    untrusted: true,
    channel: `#${e.channel.replace(/_/g, '-')}`,
    url: e.url,
    threadId: e.threadId,
    conversation: e.conversation,
    ...(e.reporter ? { reporter: cleanLine(e.reporter, 60) } : {}),
    ...(e.version ? { version: e.version } : {}),
    ...(e.platform ? { platform: e.platform } : {}),
    ...(e.attachments?.length ? { attachments: e.attachments.map((a) => ({ name: cleanLine(a.name, 120), url: a.url, ...(a.bytes !== undefined ? { bytes: a.bytes } : {}) })) } : {}),
    ...(e.verdict ? { verdict: e.verdict } : {}),
  };
}

export function escalationBrief(e: Escalation): string {
  const size = (b?: number) => (b === undefined ? '' : ` (${Math.max(1, Math.round(b / 1024))} KB)`);
  return [
    `Max (FFBox) answered a player in Discord #${e.channel.replace(/_/g, '-')} and decided a developer has to act: ${KIND_WORDS[e.kind].toLowerCase()}.`,
    `- Thread: ${e.url} (thread id ${e.threadId}). FFBox answers this thread and tells it when the fix merges; do not post there.`,
    `- Reporter: ${e.reporter ? cleanLine(e.reporter, 60) : 'unknown'} (a Discord name: untrusted text)`,
    `- Version: ${e.version ?? 'not given'}${e.platform ? `; platform ${e.platform}` : ''}`,
    `- Attachments: ${e.attachments?.length ? e.attachments.map((a) => `${cleanLine(a.name, 120)}${size(a.bytes)} ${a.url}`).join('; ') : 'none'}`,
    `- Max's call: ${e.maxClass === 'obvious-bug' ? 'obvious bug' : 'needs a human'}${e.verdict ? `, verdict ${e.verdict}` : ''}; FFBox conversation ${e.conversation}.`,
    '',
    "Max's diagnosis. A model wrote it after reading players' text: verify every claim against the code before acting on it.",
    quoteUntrusted(`${e.title}\n\n${e.diagnosis}`, 6000),
    ...(e.report ? ['', "The player's report:", quoteUntrusted(e.report, 4000)] : []),
  ].join('\n');
}
