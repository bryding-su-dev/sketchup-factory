// The WebSocket protocol between the portal (server/providers.ts) and a provider's connector: FFBox's, for
// now (docs/ffbox-connector-contract.md, docs/ffbox-integration.md). The connector dials out to /provider;
// every message is JSON data, one per frame, and neither side can make the other run anything.
// Phase 1 is read-only: the connector reports, the portal records and shows. The phase 3 work messages (submit,
// diagnose, stop, and the connector's accepted/refused) are defined below, with the person each is for
// (`requestedBy`), but the portal does not send them yet.
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { redactSecrets } from './secrets.ts';

/**
 * Bumped when a change needs both sides updated. 2 (2026-09-29, docs/ffbox-connector-contract.md "Protocol 2") adds
 * hello.accepts and welcome.accepts, conversation.threadId, board_check.conversation, and a board that says what to
 * watch and what shipped. The portal speaks every version in SUPPORTED_PROTOCOLS and answers in the hello's; any other
 * is closed 4426, and a newer connector falls back.
 */
export const PROVIDER_PROTOCOL = 2;
export const SUPPORTED_PROTOCOLS: readonly number[] = [1, 2];

/** A connector token: `ffpv1_` and 32 random bytes, base64url. The portal keeps only its SHA-256. */
export const PROVIDER_TOKEN = /^ffpv1_[A-Za-z0-9_-]{43}$/;
export const PROVIDER_TOKEN_ANYWHERE = /ffpv1_[A-Za-z0-9_-]{43}/g;

export function mintProviderToken(): string {
  return `ffpv1_${randomBytes(32).toString('base64url')}`;
}

export const tokenSha256 = (token: string) => createHash('sha256').update(token).digest('hex');

/** Close codes the portal uses. The connector's backoff depends on them (docs/ffbox-connector-contract.md). */
export const CLOSE = {
  /** A newer connection with the same token took over. */
  replaced: 4000,
  /** The first message was not a valid hello, or too many messages were invalid. */
  badMessage: 4400,
  /** The provider was switched off (providers.ffbox.enabled false) while connected. */
  disabled: 4403,
  /** No hello within HELLO_TIMEOUT_MS. */
  noHello: 4408,
  /** The hello's protocol number is not PROVIDER_PROTOCOL. */
  protocol: 4426,
  /** More messages than the rate limit allows. */
  tooFast: 4429,
} as const;

export const LIMITS = {
  /** Largest frame the portal reads. */
  maxMessageBytes: 64 * 1024,
  /** Token bucket for connector messages: the steady rate, and the burst a catch-up may use. */
  messagesPerSecond: 100,
  burst: 1000,
  helloTimeoutMs: 10_000,
  /** Invalid messages tolerated per minute before the portal closes with 4400. */
  invalidPerMinute: 20,
} as const;

// ---------------------------------------------------------------- building blocks

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})$/;
const iso = z.string().max(40).regex(ISO, 'an ISO 8601 time with a zone, e.g. 2026-09-27T10:15:00Z');
const count = z.number().int().min(0).max(1_000_000);
const cursor = z.string().min(1).max(120);
/** A container class name, e.g. "ffagent". */
const className = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/);

const modelName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,63}$/);
/** full: any well-briefed task. simple: small, well-scoped work only (docs/ffbox-integration.md, routing). */
const tier = z.enum(['full', 'simple']);

/** What one kind of requester gets in a class: operators run on their own Claude plan, Discord strangers on FFBox's model. */
export const ProviderClassModelSchema = z.object({
  requester: z.enum(['operator', 'discord']),
  model: modelName,
  tier,
});

export const ProviderClassSchema = z.object({
  name: className,
  /** fenced: FFBox's egress fence, no git credential. open: the internet. */
  network: z.enum(['fenced', 'open']),
  gpu: z.boolean(),
  /** The model SketchUp Factory's own work (operator-requested or automatic) runs on in this class, e.g. "claude-opus-5-5". */
  model: modelName,
  tier,
  /** Optional: the model and tier per kind of requester. When given, it is what the class runs; model and tier stay for older portals. */
  models: z
    .array(ProviderClassModelSchema)
    .max(4)
    .refine((ms) => new Set(ms.map((m) => m.requester)).size === ms.length, 'one entry per requester')
    .optional(),
  /** Unity modes: batchmode, playtest-softgl, mode2-pair, editor-mcp; unknown ones are kept as given. */
  unity: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/)).max(12).default([]),
  free: count,
  max: count,
  /** One line on what the class is for, shown as given. */
  note: z.string().max(200).optional(),
});

export const ProviderConversationSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9._:-]{1,80}$/),
  source: z.enum(['discord', 'intake', 'codereview', 'fff', 'shell', 'web', 'other']),
  /** Who opened it: an operator, a player (never a name or id), SketchUp Factory, or FFBox itself. */
  opener: z.enum(['operator', 'player', 'fff', 'system']),
  /** Untrusted text: it can carry what a player wrote. Shown as data, never acted on; the portal keeps 300 characters. */
  title: z.string().max(2000),
  state: z.enum(['queued', 'running', 'idle', 'blocked', 'closed']),
  agentClass: className,
  branch: z.string().regex(/^[A-Za-z0-9._/+-]{1,200}$/).optional(),
  pr: z.object({ number: z.number().int().min(1), state: z.enum(['open', 'merged', 'closed']) }).optional(),
  verdict: z.string().regex(/^[A-Z][A-Z-]{0,39}$/).optional(),
  costUsd: z.number().min(0).max(100_000).optional(),
  /** The board's dedupe key when FFBox knows it, e.g. a desync signature. */
  key: z.string().regex(/^[A-Za-z0-9_:#.+/-]{1,160}$/).optional(),
  /** Where a person reads it on FFBox's own page. */
  url: z.string().max(300).regex(/^https:\/\/[^\s"'<>]+$/).optional(),
  /** Protocol 2: the Discord thread (or reply-chain root message) it lives in; its ledger key is discord:<threadId>. */
  threadId: z.string().regex(/^\d{15,25}$/).optional(),
  createdAt: iso,
  updatedAt: iso,
});

export const ProviderIntakeSchema = z.object({
  reportId: z.string().regex(/^\d{8}T\d{6}Z-(crash|desync)-[0-9a-f]{6,32}$/),
  kind: z.enum(['crash', 'desync']),
  receivedAt: iso,
  gameVersion: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/),
  platform: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/),
  bytes: z.number().int().min(0).max(1e10),
  /** The sender, re-keyed by the connector: counts distinct senders, identifies nobody. */
  sender: z.string().regex(/^[0-9a-f]{8,64}$/).optional(),
  /** ffintake's desync block, pattern-checked by ffintake and again here. */
  desync: z
    .object({
      group: z.string().regex(/^[0-9a-f]{8,64}$/).nullable().optional(),
      correlationId: z.string().regex(/^\d{1,10}-\d{1,12}-\d{1,10}$/).optional(),
      divergedClient: count.optional(),
      role: z.enum(['host', 'client']).optional(),
      localClient: count.optional(),
      sessionEpoch: z.number().int().min(0).max(2 ** 40).optional(),
      verdictHeartbeat: z.number().int().min(0).max(2 ** 40).optional(),
      divergedSurfaces: z.string().regex(/^[A-Za-z0-9]{1,40}(\+[A-Za-z0-9]{1,40}){0,39}$/).optional(),
      happenedAt: iso.optional(),
      why: z.string().regex(/^[a-z_]{1,40}$/).optional(),
    })
    .optional(),
});

// ---------------------------------------------------------------- connector → portal

export const HelloSchema = z.object({
  type: z.literal('hello'),
  protocol: z.number().int(),
  provider: z.literal('ffbox'),
  connector: z.object({ version: z.string().regex(/^[A-Za-z0-9._+-]{1,40}$/), commit: z.string().regex(/^[0-9a-f]{7,40}$/).optional() }),
  /** FFBox's own page, for links (LAN-only is fine: people open it, the portal never does). */
  web: z.string().max(300).regex(/^https:\/\/[^\s"'<>]+$/).optional(),
  /**
   * The work messages this connector takes (WORK_MESSAGES: "submit", "diagnose", "stop"). The portal sends a
   * work message only to a connector that lists it, so a phase 1 connector never gets one. Unknown words are kept.
   */
  accepts: z.array(z.string().regex(/^[a-z_]{1,32}$/)).max(20).optional(),
});

export const CapacitySchema = z.object({
  type: z.literal('capacity'),
  classes: z.array(ProviderClassSchema).max(10),
  /** Turns waiting for a container. */
  queue: count,
  state: z.enum(['running', 'draining', 'updating', 'stopped']),
  /** Why work waits, one line each (a subscription hold, quiet hours). */
  holds: z.array(z.string().max(160)).max(10).default([]),
});

export const ConversationMessageSchema = z.object({ type: z.literal('conversation'), cursor, conversation: ProviderConversationSchema });
export const IntakeMessageSchema = z.object({ type: z.literal('intake'), cursor, event: ProviderIntakeSchema });


export type ProviderHello = z.infer<typeof HelloSchema>;
export type ProviderCapacityMessage = z.infer<typeof CapacitySchema>;

// ---------------------------------------------------------------- portal → connector

export type ToConnector =
  /** The answer to a valid hello: where each stream left off, so the connector resends only what is newer. */
  /**
   * protocol: the hello's (1 or 2). accepts (protocol 2): the connector→portal messages this portal takes now beyond the
   * reports, as config allows: board_check, request, accepted, refused, result.
   */
  | { type: 'welcome'; protocol: number; provider: 'ffbox'; cursors: { conversation?: string; intake?: string }; limits: typeof LIMITS; accepts?: string[] }
  /** A message the portal did not take; the connection stays up. */
  | { type: 'error'; code: 'bad_json' | 'bad_message' | 'unknown_type' | 'hello_twice' | 'not_enabled'; message: string; ref?: string }
  /** The answer to board_check (docs/intake.md): what the ledger holds that matches, open or finished. */
  | { type: 'board'; ref: string; verdict: 'clear' | 'in_flight' | 'done'; matches: BoardMatchWire[]; update?: true }
  /** Receipt of a request FFBox filed: the ledger item it became (or the one it repeats). */
  | { type: 'filed'; ref: string; workId?: string; status: string; repeat?: boolean; why?: string }
  /** The work messages (docs/ffbox-connector-contract.md), sent only to a connector that lists them in hello.accepts. */
  | ToConnectorWork;

// ---------------------------------------------------------------- work messages (phase 3, docs/ffbox-connector-contract.md)
//
// Defined and tested now so both sides can build to them; the portal sends none until phase 3. Each carries the
// person it is for, `requestedBy`, and never a credential: FFBox maps `requestedBy.userId` to the Claude account
// it holds for that person, and refuses the work (`refused`, reason `unknown_requester` or `no_account`) when it
// has none. The portal builds them strictly (buildSubmit, buildDiagnose, buildStop): no field it does not know,
// so nothing can ride along.

/** The work messages a connector can take, as it lists them in hello.accepts. */
export const WORK_MESSAGES = ['submit', 'diagnose', 'stop'] as const;
export type WorkMessage = (typeof WORK_MESSAGES)[number];

/** The person a piece of work is for: an SketchUp Factory login. An id and a name, nothing else (no email, no token). */
export const RequesterSchema = z
  .object({
    /** The SketchUp Factory login name: stable, and what FFBox's operators block maps (`fff:<userId>`). */
    userId: z.string().regex(/^[a-zA-Z0-9._-]{2,32}$/),
    /** For people reading FFBox's pages and logs. Never used to pick an account. */
    displayName: z
      .string()
      .min(1)
      .max(40)
      .regex(/^[^\u0000-\u001f<>`{}$\\[\]]+$/, 'one plain line'),
  })
  .strict();

/**
 * person: someone asked for it (a message, a button, the orchestrator acting on their message). automatic: the
 * portal started it by itself (intake triage, phase 4), and `requestedBy` is the configured system payer.
 */
export const TriggerSchema = z.enum(['person', 'automatic']);

/** SketchUp Factory's id for one work request; accepted, refused and (later) result refer to it. */
const requestId = z.string().regex(/^[A-Za-z0-9._:-]{1,80}$/);
const conversationId = z.string().regex(/^[A-Za-z0-9._:-]{1,80}$/);
const gitRef = z.string().regex(/^[A-Za-z0-9._/+-]{1,200}$/);
const boardKey = z.string().regex(/^[A-Za-z0-9_:#.+/-]{1,160}$/);
const reportId = z.string().regex(/^\d{8}T\d{6}Z-(crash|desync)-[0-9a-f]{6,32}$/);

/** portal → connector: start a turn on FFBox (a new conversation, or the next turn of one it started). */
export const SubmitSchema = z
  .object({
    type: z.literal('submit'),
    id: requestId,
    requestedBy: RequesterSchema,
    trigger: TriggerSchema,
    title: z.string().min(1).max(300),
    /** The brief. Secrets are redacted before it is built (redactSecrets). */
    prompt: z.string().min(1).max(48_000),
    /** fenced by default. FFBox may still pick a stricter class; nothing here can force the open one. */
    class: z.enum(['fenced', 'open']).default('fenced'),
    /** Branch to base new work on (default develop), or to continue. */
    base: gitRef.optional(),
    branch: gitRef.optional(),
    /** A conversation this portal started earlier: this is its next turn. */
    conversation: conversationId.optional(),
    /** The task reads text from outside the team (players, the web). Forces the fenced class. */
    untrustedInput: z.boolean(),
    /** The board's dedupe key, when there is one. */
    key: boardKey.optional(),
  })
  .strict()
  .refine((m) => !(m.untrustedInput && m.class === 'open'), { message: 'untrustedInput work runs fenced', path: ['class'] });

/** portal → connector: diagnose filed intake reports, as the /intake button does. */
export const DiagnoseSchema = z
  .object({
    type: z.literal('diagnose'),
    id: requestId,
    requestedBy: RequesterSchema,
    trigger: TriggerSchema,
    reportIds: z.array(reportId).min(1).max(20),
    key: boardKey.optional(),
  })
  .strict();

/** portal → connector: stop a conversation this portal started. */
export const StopSchema = z
  .object({ type: z.literal('stop'), id: requestId, requestedBy: RequesterSchema, conversation: conversationId })
  .strict();

export const ToConnectorWorkSchema = z.discriminatedUnion('type', [SubmitSchema, DiagnoseSchema, StopSchema]);
export type SubmitMessage = z.infer<typeof SubmitSchema>;
export type DiagnoseMessage = z.infer<typeof DiagnoseSchema>;
export type StopMessage = z.infer<typeof StopSchema>;
export type ToConnectorWork = z.infer<typeof ToConnectorWorkSchema>;

/**
 * connector → portal: FFBox took a work request. `billedTo`: the user id whose account FFBox charges, which must
 * be `requestedBy.userId`; the portal flags any other.
 */
export const AcceptedSchema = z.object({
  type: z.literal('accepted'),
  ref: requestId,
  conversation: conversationId,
  billedTo: z.string().regex(/^[a-zA-Z0-9._-]{2,32}$/),
});

/**
 * connector → portal: FFBox would not take a work request. unknown_requester: no operator entry for
 * `requestedBy.userId`; no_account: an operator with no Claude account to bill. Neither falls back to another
 * person's account.
 */
export const RefusedSchema = z.object({
  type: z.literal('refused'),
  ref: requestId,
  reason: z.enum(['unknown_requester', 'no_account', 'class_not_allowed', 'budget_hold', 'draining', 'already_diagnosed', 'bad_request', 'other']),
  /** One line for people; FFBox's own words, shown as data. */
  message: z.string().max(300).optional(),
});

export const WorkReplySchema = z.discriminatedUnion('type', [AcceptedSchema, RefusedSchema]);
export type WorkReply = z.infer<typeof WorkReplySchema>;

type Input<T> = Omit<z.input<T & z.ZodTypeAny>, 'type'>;

/** A submit message, with its title and prompt redacted and every field checked; throws on anything wrong. */
export function buildSubmit(m: Input<typeof SubmitSchema>): SubmitMessage {
  return SubmitSchema.parse({ ...m, type: 'submit', title: redactSecrets(String(m.title ?? '')), prompt: redactSecrets(String(m.prompt ?? '')) });
}

export function buildDiagnose(m: Input<typeof DiagnoseSchema>): DiagnoseMessage {
  return DiagnoseSchema.parse({ ...m, type: 'diagnose' });
}

export function buildStop(m: Input<typeof StopSchema>): StopMessage {
  return StopSchema.parse({ ...m, type: 'stop' });
}

/** Whether a connector's hello said it takes this work message (a phase 1 connector takes none). */
export const acceptsWork = (accepts: readonly string[] | undefined, type: WorkMessage) => !!accepts?.includes(type);

/** What was wrong with a message, in one line (never echoing its content). */
export function describeIssues(e: z.ZodError): string {
  return e.issues
    .slice(0, 5)
    .map((i) => `${i.path.join('.') || '(message)'}: ${i.message}`)
    .join('; ');
}

// ---------------------------------------------------------------- the intake, both ways (docs/intake.md)

/**
 * connector → portal: FFBox files a request into SketchUp Factory's ledger: a fix branch to review and merge, an escalation
 * (a fork that needs the three-machine rig, a GPU), or an operator's request. It lands waiting for a person unless the
 * portal's intake.ffbox auto-approve rule allows it. Title and brief are untrusted text (they can carry what a player
 * wrote); the portal fences them off.
 */
export const RequestSchema = z.object({
  type: z.literal('request'),
  /** FFBox's id for it; the portal answers with "filed". */
  ref: requestId,
  kind: z.enum(['review-branch', 'escalate', 'dev']),
  title: z.string().min(1).max(300),
  brief: z.string().min(1).max(8000),
  /** Who opened the conversation behind it: an operator, a player, or FFBox itself. */
  opener: z.enum(['operator', 'player', 'system']),
  /** The operator it is for, when an operator asked (an SketchUp Factory login; the portal checks it exists). */
  requestedBy: RequesterSchema.optional(),
  conversation: conversationId.optional(),
  branch: gitRef.optional(),
  pr: z.number().int().min(1).optional(),
  verdict: z.string().regex(/^[A-Z][A-Z-]{0,39}$/).optional(),
  key: boardKey.optional(),
  url: z.string().max(300).regex(/^https:\/\/[^\s"'<>]+$/).optional(),
});

/**
 * connector → portal: before FFBox works a report or starts an operator's dev turn, it asks the ledger whether the
 * same work is open or done (docs/intake.md). The portal answers "board", or error not_enabled while
 * intake.ffbox.boardCheck is off.
 */
export const BoardCheckSchema = z.object({
  type: z.literal('board_check'),
  ref: requestId,
  keys: z.array(boardKey).max(20).default([]),
  /** Untrusted: compared by its words, never shown to a model. FFBox sends keys only. */
  title: z.string().max(300).optional(),
  /** Protocol 2: the FFBox conversation asking; the ledger requests filed from it are its own, not a match. */
  conversation: conversationId.optional(),
});

/**
 * One match in a board answer. watch (in flight, when the branch is known): the branch FFBox watches for the merge, the
 * PR once open, the repo and the branch it lands on. version / mergedIn / branch (done): the first release carrying the
 * fix (null while merged but unreleased), "<target>@<sha>", and the branch the work was on.
 */
export interface BoardMatchWire {
  id: string;
  status: string;
  title: string;
  score: number;
  why: string;
  updatedAt: string;
  watch?: { repo: string; branch: string; pr?: number; target: string };
  version?: string | null;
  mergedIn?: string | null;
  branch?: string;
}

/** connector → portal: a turn SketchUp Factory submitted finished (or failed). The summary is untrusted text. */
export const ResultSchema = z.object({
  type: z.literal('result'),
  ref: requestId,
  conversation: conversationId,
  state: z.enum(['done', 'failed']),
  branch: gitRef.optional(),
  pr: z.number().int().min(1).optional(),
  verdict: z.string().regex(/^[A-Z][A-Z-]{0,39}$/).optional(),
  noBranchReason: z.string().max(300).optional(),
  summary: z.string().max(2000).optional(),
  costUsd: z.number().min(0).max(100_000).optional(),
  url: z.string().max(300).regex(/^https:\/\/[^\s"'<>]+$/).optional(),
});

export type ProviderRequestMessage = z.infer<typeof RequestSchema>;
export type BoardCheckMessage = z.infer<typeof BoardCheckSchema>;
export type ResultMessage = z.infer<typeof ResultSchema>;

/** Everything the connector may send. */
export const FromConnectorSchema = z.discriminatedUnion('type', [HelloSchema, CapacitySchema, ConversationMessageSchema, IntakeMessageSchema, AcceptedSchema, RefusedSchema, ResultSchema, RequestSchema, BoardCheckSchema]);
export type FromConnector = z.infer<typeof FromConnectorSchema>;
export const FROM_CONNECTOR_TYPES = ['hello', 'capacity', 'conversation', 'intake', 'accepted', 'refused', 'result', 'request', 'board_check'] as const;
