// The wire contract between the server and the web UI. Both sides import this file; keep it
// free of runtime code other than constants so the browser bundle and Node's type stripping
// can both load it.

/** 'blocked': the editor is alive but stuck on a modal dialog, or silent for too long while starting (see unity.blocked). */
/** A working tree's real state, read from git (docs: server/gitStatus.ts). */
export interface GitStatus {
  /** The branch actually checked out now ("detached HEAD" when none). */
  branch: string;
  upstream?: string;
  ahead?: number;
  behind?: number;
  /** Changed tracked files, and untracked ones. */
  dirty: number;
  untracked: number;
  head?: { sha: string; subject: string; date: string };
  /** The open PR from this branch, if any (gh). */
  pr?: { number: number; url: string; title: string; draft: boolean };
  at: string;
}

export type UnityState = 'stopped' | 'starting' | 'running' | 'stopping' | 'crashed' | 'blocked';

/** Why an editor is blocked (docs/unity-dialogs.md). */
export interface UnityRestart {
  at: string;
  /** Why: "hung: the Unity MCP bridge has not answered for 11 min …", "crashed: …", or "asked for". */
  reason: string;
  /** Started by the hang/crash watch (counts toward its limit), not by a tool. */
  auto: boolean;
}

export interface UnityBlocked {
  reason: 'dialog' | 'stalled' | 'elevated' | 'restart-limit';
  /** The dialog, when reason is 'dialog'. */
  title?: string;
  text?: string;
  buttons?: string[];
  /** KNOWN_DIALOGS id, when the dialog is a known one. */
  dialogId?: string;
  /** What it means and what to do. */
  advice?: string;
  since: string;
  /** The state to return to once the dialog is gone or the log moves again. */
  resumeState: 'starting' | 'running';
}

/** A dialog the watchdog closed by pressing its safe button. */
export interface UnityDismissal {
  at: string;
  title: string;
  button: string;
}

export type SandboxStatus = 'creating' | 'ready' | 'error' | 'deleting';

export interface Sandbox {
  id: string;
  name: string;
  /** Git branch checked out in this sandbox's worktree. */
  branch: string;
  /** What the branch was created from (e.g. "origin/develop"). */
  base: string;
  /** Absolute worktree path on the host. */
  path: string;
  /** Free-text purpose, set by whoever created it ("spec 098", "shader work"). */
  purpose: string;
  status: SandboxStatus;
  /** Human-readable progress line while creating/deleting, or the error when status=error. */
  statusDetail?: string;
  createdAt: string;
  unity: {
    state: UnityState;
    pid?: number;
    startedAt?: string;
    logPath?: string;
    detail?: string;
    blocked?: UnityBlocked;
    /** Dialogs the watchdog dismissed for this editor, newest last (capped). */
    dismissed?: UnityDismissal[];
    /** Restarts of this sandbox's editor after a hang or crash (auto) or through the tools, newest last (capped). */
    restarts?: UnityRestart[];
  };
  /** Session ids (worker agents) that belong to this sandbox, newest last. */
  sessionIds: string[];
  /** Refreshed from git on a timer and after agent turns. */
  git?: GitStatus;
}

export type SessionKind = 'orchestrator' | 'worker' | 'standing';

/**
 * What an orchestrator is (docs/orchestrators.md): the portal's one dispatcher, which owns every tool that changes
 * something, or a person's own orchestrator, which talks with that person and files work requests with the dispatcher.
 */
export type OrchestratorRole = 'dispatcher' | 'personal';

/**
 * A person SketchUp Factory knows: a login (data/users.json). `userId` is the login name, which never changes; it is
 * what FFBox maps to the account it bills (docs/ffbox-connector-contract.md, `requestedBy`).
 */
export interface Requester {
  userId: string;
  displayName: string;
}

/** owner: runs this portal (Ben). member: a teammate with a login (Lothsahn). Roles are recorded; enforcing them is a later phase. */
export type UserRole = 'owner' | 'member';

export interface UserInfo extends Requester {
  role: UserRole;
}

export type SessionStatus =
  | 'starting'
  | 'running' // a turn is in flight
  | 'idle' // waiting for the next message
  | 'waiting_permission'
  | 'stopped' // process not running; can be resumed by sending a message
  | 'error';

/** The Agent SDK's reasoning effort (Options.effort). */
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export const EFFORT_LEVELS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'auto';

export interface PendingPermission {
  requestId: string;
  toolName: string;
  input: unknown;
  /** Why it is being asked (blocked path, etc.), when the SDK says. */
  reason?: string;
  createdAt: string;
}

export interface SessionInfo {
  id: string;
  kind: SessionKind;
  sandboxId?: string;
  /** The standing agent that owns this session (kind 'standing'). */
  standingId?: string;
  /** Set when the session runs on a machine (docs/machines.md) rather than on this host. */
  machineId?: string;
  /** With machineId: the machine sandbox it works in (docs/machines.md, "Machine sandboxes"), not the machine's main clone. */
  machineSandbox?: string;
  /** The last label this agent gave its sandbox or machine (set_label), restored when a helper there finishes. */
  label?: string;
  labelAt?: string;
  title: string;
  status: SessionStatus;
  statusDetail?: string;
  model?: string;
  permissionMode: PermissionMode;
  /** Reasoning effort for this session's model; unset = the server default (config worker.effort). */
  effort?: EffortLevel;
  /** The Claude Code session id, used to resume after a restart. */
  sdkSessionId?: string;
  /**
   * The Claude account its current process started on, as an account source key (server/usage.ts
   * accountKeyOf: "token:<sha256 prefix>" or "host:login"). Set by this host's own sessions only; a Mac's
   * follow the config (sessionSource).
   */
  account?: string;
  createdAt: string;
  lastActivityAt: string;
  /** A tool call of its own (not a subagent's) still running: the oldest one, since when (Store.noteActivity). */
  activeTool?: { id: string; name: string; since: string };
  turns: number;
  costUsd: number;
  pendingPermissions: PendingPermission[];
  /** Last assistant text of the most recent finished turn, trimmed; for cards and summaries. */
  lastResult?: string;
  /**
   * The person this agent works for: who started it, or had the orchestrator start it (docs/identity.md). A
   * standing agent's is its current run's; a personal orchestrator's is its person. Absent on the dispatcher and on
   * sessions older than this field.
   */
  requestedBy?: Requester;
  /** Kind 'orchestrator' only: the dispatcher or a person's own. Absent on an orchestrator older than this field. */
  orchestratorRole?: OrchestratorRole;
  /** Who the latest message a person (or the orchestrator for a person) sent this session came from. */
  lastRequestedBy?: Requester;
  /**
   * A person's own orchestrator only: messages other people sent its person (message_person, docs/orchestrators.md)
   * that they have not seen yet. Cleared when they open or write to their chat.
   */
  personMessages?: { from: Requester; at: string }[];
  /**
   * Restart bookkeeping (server/restart.ts), saved at once: since when its current turn has been open. Set by a
   * message, cleared when the turn ends or the session is stopped or interrupted on purpose, and kept when the
   * process dies with the server, so a crash cannot make a mid-turn agent look finished.
   */
  turnOpenSince?: string;
  /** Background tasks (a background command, a watcher) still open: they would have re-invoked it; a restart ends them. */
  backgroundTasks?: number;
  /**
   * The context its next model call reads, in tokens (w535): the last call's input, cached and uncached, plus its
   * output, as the SDK reported it; after a compaction, the size Claude Code measured. This host's sessions only.
   */
  contextTokens?: number;
  /** What its last finished turn cost, in USD (w535): what the automatic compaction's cost trigger reads. */
  lastTurnCostUsd?: number;
  /** Its last compaction (w518, w535), whoever started it. */
  lastCompaction?: CompactionRecord;
  /**
   * Machine sessions: stopped or interrupted on purpose (stop_agent, interrupt_agent, the UI) since its last message.
   * Kept by the portal, never by the daemon: no dropped link or restart resumes it until it is sent a message again.
   */
  stoppedOnPurpose?: boolean;
}

/**
 * Who started a compaction (w535): a person's `/compact` or the menu (`person`), FF Factory because the context or a
 * turn's cost passed its threshold (`tokens`, `cost`), the orchestrator itself (`self`, compact_conversation), or Claude
 * Code at its own hard limit (`claude`).
 */
export type CompactionTrigger = 'person' | 'tokens' | 'cost' | 'self' | 'claude';

/** One finished compaction of a session's conversation (w535): when, why, and the context before and after. */
export interface CompactionRecord {
  at: string;
  trigger: CompactionTrigger;
  /** The context it compacted, in tokens (Claude Code's compact_boundary pre_tokens). */
  before: number;
  /** The context afterwards, in tokens, when it could be measured. */
  after?: number;
  /** The session's turn count then: automatic compaction waits a few turns before the next. */
  turns: number;
}

/** An image kept with a session's transcript, served at /api/uploads/<sessionId>/<id>. */
export interface ImageRef {
  id: string;
  mediaType: string;
  /** The file an agent's message showed, copied here when the message arrived (server/inlineImages.ts). */
  path?: string;
}

/** An image sent with a message: base64 data, plus its id once stored. */
export interface ImageInput {
  mediaType: string;
  data: string;
  id?: string;
}

/**
 * A file a person attached to a message (docs/attachments.md): a save, a bug-report zip, a log, a desync report.
 * Stored once by its SHA-256 in the portal's data folder, never unpacked or run there; served for download only.
 */
export interface AttachmentRef {
  /** "att_" and 12 lowercase letters or digits (shared/attachments.ts ATTACHMENT_ID): what orchestrators pass on. */
  id: string;
  /** Its file name as uploaded, made safe (attachmentName). */
  name: string;
  size: number;
  sha256: string;
  /** What it is from its name alone (never opened): "Final Factory bug report (zip)", "Unity Player.log", ... */
  kind: string;
  mediaType: string;
}

/** An attachment as one agent got it: where its copy is for that agent, or why it is not there. */
export interface DeliveredAttachment extends AttachmentRef {
  /** The file the agent reads: its Inbox copy (a worker), or the stored file (an orchestrator). */
  path?: string;
  error?: string;
}

/** The attachment limits the page needs (config attachments). */
export interface AttachmentSettings {
  maxBytes: number;
  retentionDays: number;
  maxPerMessage: number;
}

/** Image types Claude accepts. */
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

/** An image file an agent produced, as listed by a sandbox's or machine's Screenshots gallery. */
export interface ImageFile {
  path: string;
  size: number;
  mtime: string;
}

/** One persisted transcript entry. Streaming deltas are NOT persisted (see ServerEvent). */
export type TranscriptEvent =
  /** requestedBy: the person who wrote it (from 'human'), or for whom the orchestrator or the harness sent it. */
  /** attachments: the files that came with it (docs/attachments.md), with where this agent's copy is. */
  | { seq: number; t: string; kind: 'user'; text: string; from: 'human' | 'orchestrator' | 'system'; uuid?: string; images?: ImageRef[]; attachments?: DeliveredAttachment[]; requestedBy?: Requester }
  /** images: the files it shows (shared/imagePaths.ts), kept once copied, so they outlive their folder. */
  | { seq: number; t: string; kind: 'assistant'; text: string; images?: ImageRef[] }
  | { seq: number; t: string; kind: 'thinking'; text: string }
  | { seq: number; t: string; kind: 'tool_use'; toolUseId: string; name: string; input: unknown; parentToolUseId?: string | null }
  | { seq: number; t: string; kind: 'tool_result'; toolUseId: string; isError: boolean; text: string; images?: ImageRef[] }
  | { seq: number; t: string; kind: 'result'; ok: boolean; text: string; costUsd: number; turns: number; durationMs: number; answers?: string[] }
  | { seq: number; t: string; kind: 'system'; text: string }
  | { seq: number; t: string; kind: 'error'; text: string }
  | { seq: number; t: string; kind: 'permission'; requestId: string; toolName: string; input: unknown; decision?: 'allow' | 'deny' };

/** One computer's load: the portal's host (SystemStats) or a machine (its daemon reports it, server/system.ts). */
export interface HostStats {
  hostname: string;
  platform: string;
  cpuModel: string;
  cpuCount: number;
  loadPct: number; // 0-100, whole machine
  memTotalBytes: number;
  memFreeBytes: number;
  /**
   * Memory in use as the OS's own monitor counts it. On macOS free memory is mostly file cache, so this is
   * app + wired + compressed memory (Activity Monitor's "Memory Used"); absent: total minus free.
   */
  memUsedBytes?: number;
  /** macOS memory pressure (kern.memorystatus_vm_pressure_level). */
  memPressure?: 'normal' | 'warn' | 'critical';
  diskTotalBytes?: number;
  diskFreeBytes?: number;
  /**
   * `unified`: Apple Silicon, where the GPU shares RAM: memUsedMiB is what the GPU holds in use and
   * memTotalMiB is all of RAM, so utilPct is the number that says how busy it is.
   */
  gpu?: { name: string; memTotalMiB: number; memUsedMiB: number; utilPct: number; unified?: boolean };
}

export interface SystemStats extends HostStats {
  /** The host's config limits; maxSandboxes is absent from a server older than the fleet view. */
  limits: { maxUnity: number; maxSessions: number; maxSandboxes?: number };
}

/** A machine's load, as its daemon last reported it (protocol 4+); not kept in state.json. */
export interface MachineStats extends HostStats {
  /** When the portal received it. */
  at: string;
}

// ---- machines (docs/machines.md) ----

export type MachineStatus = 'deploying' | 'ready' | 'error';

/** What a machine runs: a Mac (LaunchAgent) or a Windows PC (Task Scheduler), docs/machines.md. */
export type MachinePlatform = 'darwin' | 'win32';

/** "Mac" or "Windows PC", for sentences about a machine (a record from before platforms is a Mac). */
export const platformNoun = (p: MachinePlatform | undefined) => (p === 'win32' ? 'Windows PC' : 'Mac');

/** A machine's daemon folder: its app_dir, else <home>/.ff-factory. */
export const appDirOf = (m: Pick<Machine, 'appDir' | 'home'>) => m.appDir || `${m.home}/.ff-factory`;

export interface Machine {
  /** Short name, e.g. "m5"; also the MCP/label id. Lower-case (MACHINE_ID). */
  id: string;
  /** The id as it was typed when it has capitals, e.g. "LothDesktop" for lothdesktop: shown in its place. */
  name?: string;
  /** ssh host alias this host deploys to. */
  host: string;
  /** The label, like a sandbox's purpose line. */
  purpose: string;
  /** Deployment state; `online` says whether the daemon is connected right now. */
  status: MachineStatus;
  statusDetail?: string;
  online: boolean;
  lastSeen?: string;
  /** Mac or Windows PC; found over ssh at deploy and reported in the daemon's hello. Unset: a Mac (records from before). */
  platform?: MachinePlatform;
  /** The daemon was stopped on purpose (machine_daemon stop): not redeployed while offline until started again. */
  daemonStopped?: boolean;
  /** The machine's main Final Factory clone: where its agents work. */
  repoPath: string;
  home: string;
  /** The daemon's folder (code, logs, agents, daemon.json) when not the default <home>/.ff-factory (add_machine app_dir). */
  appDir?: string;
  /** A folder holding Unity editor versions (<root>/<version>/...), searched before Unity Hub's defaults. */
  unityEditorRoot?: string;
  /** The Unity editor executable itself (Unity.exe, or .../Unity.app/Contents/MacOS/Unity): wins over any lookup. */
  unityPath?: string;
  /** Scratch folder for its agents (TMP, TEMP and TMPDIR of their processes); unset: the system's. */
  tempDir?: string;
  /** The folder its sandboxes (git worktrees of repoPath) live in; unset: the machine has no sandboxes. */
  sandboxRoot?: string;
  /** Sandboxes that may exist there at once (default 3 once sandboxRoot is set). */
  maxSandboxes?: number;
  /** Agents that may run at once in one of its sandboxes (default 2). */
  maxAgentsPerSandbox?: number;
  /** Unity editors of its sandboxes that may run at once (default 2; the main clone's editor is not counted). */
  maxUnity?: number;
  /** Its disk guard: below this many GB free on the sandbox volume, no new sandboxes or sandbox editors (default 50). */
  diskWarnGB?: number;
  /** Below this, idle sandbox editors are stopped and busy sandbox agents asked to checkpoint (default 20). */
  diskCriticalGB?: number;
  /** Its sandboxes, as its daemon last reported them (portal-owned: purpose and sessionIds). */
  sandboxes?: MachineSandbox[];
  /**
   * The portal's own host (docs/beast-machine.md): its daemon runs on this computer, is deployed and controlled
   * without ssh, and takes over the host's sandboxes. Its unset settings follow the portal's config (sandboxRoot,
   * limits, protectedPaths, librarySeed, the workers' Claude account). At most one machine is local.
   */
  local?: boolean;
  /** Live agents that may run at once across all its sandboxes (unset: only max_agents_per_sandbox limits them). */
  maxSandboxAgents?: number;
  /** Folders its agents must never touch and its clean-up never deletes, besides its main clone and daemon folder (e.g. a live game). */
  protectedPaths?: string[];
  /** A warm Library folder new sandboxes are seeded from first (else the main clone's, else a sandbox's). */
  librarySeed?: string;
  /** How the seed is copied on Windows: "clone" (Copy-Item, which block-clones on a ReFS Dev Drive) or "robocopy" (the default). */
  librarySeedCopy?: 'robocopy' | 'clone';
  /** Room a Library copy needs, in GB, on top of disk_warn_gb (default 30). */
  librarySeedGB?: number;
  /** Its sandbox editors run at below-normal priority, so a game the user plays there wins every contest for the CPU. */
  unityBelowNormal?: boolean;
  /** Portal URL the daemon connects to. */
  portalUrl: string;
  maxSessions: number;
  sessionIds: string[];
  /** Reported by the daemon. */
  info?: { hostname: string; os: string; node: string; claude?: string; daemon: string; platform?: MachinePlatform };
  git?: GitStatus;
  /** The daemon's last clean-up pass (server/cleanup.ts). */
  lastCleanup?: CleanupSummary;
  createdAt: string;
}

/**
 * A sandbox on a machine (docs/machines.md, "Machine sandboxes"): a git worktree of the machine's main clone in its
 * sandboxRoot, on its own branch, with its own Library and Unity editor. The daemon owns the folder, git and Unity
 * state; the portal owns purpose and sessionIds.
 */
export interface MachineSandbox {
  /** The folder name, also the Unity project and MCP instance name ("<id>@<hash>"). Addressed as "<machine>/<id>". */
  id: string;
  branch: string;
  base: string;
  path: string;
  purpose: string;
  status: SandboxStatus;
  statusDetail?: string;
  createdAt: string;
  unity: MachineSandboxUnity;
  sessionIds: string[];
  git?: GitStatus;
}

export interface MachineSandboxUnity {
  state: 'stopped' | 'starting' | 'running' | 'crashed';
  pid?: number;
  detail?: string;
  logPath?: string;
}

/** The pool settings the portal sends a daemon (welcome) and a deploy writes into daemon.json. */
export interface SandboxPoolSettings {
  root: string;
  maxSandboxes: number;
  maxAgentsPerSandbox: number;
  maxUnity: number;
  diskWarnGB: number;
  diskCriticalGB: number;
  /** Protocol 6 (docs/beast-machine.md): live agents across all sandboxes; unset: no total. */
  maxAgents?: number;
  /** Protocol 6: the Library new sandboxes are seeded from first. */
  librarySeed?: string;
  librarySeedCopy?: 'robocopy' | 'clone';
  librarySeedGB?: number;
  /** Protocol 6: start sandbox editors at below-normal priority. */
  belowNormal?: boolean;
  /** Protocol 6: folders clean-up never deletes (a live game), besides the clone, the sandboxes and the daemon's folder. */
  protectedPaths?: string[];
}

// ---- providers (docs/ffbox-integration.md): FFBox, reached through the connector it runs ----

/** What one kind of requester gets in a provider class: operators run on their own Claude plan, Discord strangers on FFBox's model. */
export interface ProviderClassModel {
  requester: 'operator' | 'discord';
  model: string;
  tier: 'full' | 'simple';
}

/** A kind of container a provider offers, as its connector last reported it (server/providerProtocol.ts). */
export interface ProviderClass {
  name: string;
  network: 'fenced' | 'open';
  gpu: boolean;
  /** The model SketchUp Factory's own work (operator-requested or automatic) runs on, e.g. "claude-opus-5-5". */
  model: string;
  /** full: any well-briefed task. simple: small, well-scoped work only. */
  tier: 'full' | 'simple';
  /** The model and tier per kind of requester, when the connector reports them; they win over model and tier. */
  models?: ProviderClassModel[];
  unity: string[];
  free: number;
  max: number;
  note?: string;
}

export interface ProviderCapacity {
  classes: ProviderClass[];
  queue: number;
  state: 'running' | 'draining' | 'updating' | 'stopped';
  holds: string[];
  /** When the portal received it. */
  at: string;
}

/** One FFBox conversation, as reported. `title` is untrusted text (it can carry what a player wrote). */
export interface ProviderConversation {
  id: string;
  source: 'discord' | 'intake' | 'codereview' | 'fff' | 'shell' | 'web' | 'other';
  opener: 'operator' | 'player' | 'fff' | 'system';
  title: string;
  state: 'queued' | 'running' | 'idle' | 'blocked' | 'closed';
  agentClass: string;
  branch?: string;
  pr?: { number: number; state: 'open' | 'merged' | 'closed' };
  verdict?: string;
  costUsd?: number;
  key?: string;
  url?: string;
  /** Protocol 2: the Discord thread (or reply-chain root message) the conversation lives in. */
  threadId?: string;
  createdAt: string;
  updatedAt: string;
}

/** One report ffintake filed: only the facts ffintake computed or pattern-checked; never the report's own text. */
export interface ProviderIntakeEvent {
  reportId: string;
  kind: 'crash' | 'desync';
  receivedAt: string;
  gameVersion: string;
  platform: string;
  bytes: number;
  sender?: string;
  desync?: {
    group?: string | null;
    correlationId?: string;
    divergedClient?: number;
    role?: 'host' | 'client';
    localClient?: number;
    sessionEpoch?: number;
    verdictHeartbeat?: number;
    divergedSurfaces?: string;
    happenedAt?: string;
    why?: string;
  };
}

/** A provider as the sidebar and system_status see it. The lists are fetched separately (GET /api/providers/<id>/…). */
export interface Provider {
  id: string;
  name: string;
  /** config providers.<id>.enabled (default off). */
  enabled: boolean;
  /** Whether a connector token is configured (its hash; the token itself is never kept). */
  tokenSet: boolean;
  online: boolean;
  connectedSince?: string;
  lastSeen?: string;
  statusDetail?: string;
  connector?: { version: string; commit?: string; protocol: number };
  /** The provider's own page, for links. */
  web?: string;
  /** Work messages the connector said it takes (hello.accepts, e.g. "submit"); none yet in phase 1. */
  accepts?: string[];
  capacity?: ProviderCapacity;
  counts: { conversations: number; active: number; intake: number; intake24h: number };
  lastIntakeAt?: string;
}

/** FFBox's intake reports grouped by their coarse signature (shared/intake.ts, docs/ffbox-integration.md section 6). */
export interface IntakeSignature {
  /** `desync:<major.minor.patch>:<diverged surfaces>`, or `crash:<major.minor.patch>` (crashes get a real signature in phase 6). */
  signature: string;
  kind: 'crash' | 'desync';
  versionLine: string;
  surfaces?: string;
  reports: number;
  /** Distinct desync events (the report's group): every peer of one desync is one event. */
  events: number;
  senders: number;
  /** A host and a client report of one event. */
  pair: boolean;
  /** Clears the trust bar for an automatic investigation: 2+ distinct senders, or a host and client pair. Never for crashes yet. */
  trusted: boolean;
  firstAt: string;
  lastAt: string;
  versions: string[];
  platforms: string[];
  /** Report ids, newest first (at most 20). */
  reportIds: string[];
}

/** The numbers automatic investigations will be bounded by (docs/ffbox-integration.md, step 4). */
export interface IntakeBudget {
  /** Phase 4 (automatic investigations) is not built yet: these are what it would use. */
  live: false;
  perDay: number;
  perHour: number;
  /** Signatures first seen in the last 24 h / hour. */
  newToday: number;
  newLastHour: number;
  /** New today and past the trust bar: what would be started, before the caps. */
  trustedToday: number;
  /** min(trustedToday, perDay). */
  wouldStartToday: number;
  /** More than 5 new signatures in an hour stops automatic starts. */
  stormBreaker: { threshold: number; tripped: boolean };
}

export interface IntakeGroups {
  signatures: IntakeSignature[];
  budget: IntakeBudget;
  /** How many reports were grouped (the portal keeps the newest 2000). */
  reports: number;
}

// ---- Max, the Discord bot our agents post as (docs/max.md) ----

export type MaxAction = 'post' | 'reply' | 'ask' | 'edit' | 'thread_create' | 'close' | 'rename';

/** One thing an SketchUp Factory agent did as Max, reported by the ffdiscord CLI through the events file. Text is ours but still shown as plain text. */
export interface MaxEvent {
  id: string;
  at: string;
  action: MaxAction;
  ok: boolean;
  channelId?: string;
  /** "#dev-chat", or the alias the agent passed, as best known. */
  channel?: string;
  /** Set when the channel is a thread: the thread's name and its parent channel. */
  thread?: { id: string; name?: string; parent?: string };
  messageId?: string;
  url?: string;
  /** The first line of what was posted (or the thread name), cleaned; never the whole message. */
  text?: string;
  /** Why it failed, e.g. "403 Missing Permissions". */
  error?: string;
  sessionId?: string;
  /** The session's title when the event arrived. */
  session?: string;
  /** "worker", "standing: <name>", "orchestrator", or "outside SketchUp Factory". */
  agent?: string;
  /** "host" or a machine id. */
  where: string;
}

export interface MaxInboundItem {
  id: string;
  kind: 'message' | 'thread';
  author?: string;
  /** Untrusted Discord text: cleaned, cut short, shown as plain text only. */
  text: string;
  at: string;
  url?: string;
  unread: boolean;
  /** A forum thread's message count. */
  replies?: number;
}

export interface MaxInboundChannel {
  alias: string;
  channelId?: string;
  name?: string;
  kind?: 'text' | 'forum';
  unread: number;
  lastAt?: string;
  error?: string;
}

export interface MaxSummary {
  /** Where the bot token was looked for (a path or a variable name; never the token). */
  token: { found: boolean; source: string; problem?: string };
  health: { state: 'ok' | 'error' | 'unknown' | 'no_token'; bot?: string; checkedAt?: string; error?: string };
  lastError?: { at: string; message: string; channel?: string; action?: string; session?: string };
  lastPost?: { at: string; channel?: string; session?: string };
  counts: { events: number; posts24h: number; errors24h: number };
  inbound: { enabled: boolean; channels: MaxInboundChannel[]; polledAt?: string; nextPollAt?: string };
  /** The file the CLI appends events to on the host (FF_MAX_EVENTS). */
  eventsFile: string;
}

// ---- standing agents (docs/standing-agents.md) ----

export type StandingTrigger = { kind: 'interval'; minutes: number } | { kind: 'cron'; expr: string } | { kind: 'manual' };

/** Tool groups a standing agent may get on top of read-only file access. */
export type StandingToolGroup = 'shell_read' | 'github_comment' | 'delegate';

export const STANDING_TOOL_GROUPS: { value: StandingToolGroup; label: string; hint: string }[] = [
  { value: 'shell_read', label: 'Read-only shell', hint: 'git and gh for reading repos, plus cat/grep/ls-style utilities' },
  { value: 'github_comment', label: 'GitHub comments', hint: 'gh pr/issue comment and comment-only reviews; never approve, merge or close' },
  { value: 'delegate', label: 'Delegate', hint: 'ask for a worker in an unused sandbox (the user approves)' },
];

export type StandingRunTrigger = 'schedule' | 'manual' | 'message';

export type StandingRunOutcome = 'running' | 'ok' | 'error' | 'budget' | 'timeout' | 'stopped' | 'skipped' | 'interrupted';

export interface StandingRun {
  id: string;
  trigger: StandingRunTrigger;
  /** When it came due (schedule) or was asked for. */
  dueAt: string;
  startedAt?: string;
  endedAt?: string;
  outcome: StandingRunOutcome;
  costUsd: number;
  /** The agent's final message, clipped; or why it was skipped/stopped. */
  summary?: string;
  /** Who asked for it: the person for a manual or message run, the system payer (config systemPayer) for a scheduled one. */
  requestedBy?: Requester;
}

/** What the agent is doing now. */
export type StandingState = 'asleep' | 'waiting' | 'running' | 'paused';

export interface StandingAgent {
  id: string;
  name: string;
  charter: string;
  model: string;
  trigger: StandingTrigger;
  /** Absolute working folder on the host (holds NOTES.md). */
  folder: string;
  enabled: boolean;
  budget: { perRunUsd: number; perDayUsd: number; maxMinutes: number };
  tools: StandingToolGroup[];
  /** The one long-lived Claude session this agent resumes every run. */
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  state: StandingState;
  /** Why it is waiting, or the last scheduling problem. */
  stateDetail?: string;
  /** Next scheduled run; undefined for manual-only or paused agents. */
  nextRunAt?: string;
  /** A run that is due but has not started (waiting for a free agent slot). At most one. */
  pending?: { trigger: StandingRunTrigger; dueAt: string; deadline: string; text?: string; requestedBy?: Requester };
  /** Runs on this machine instead of this host (its folder is then on that machine). */
  machineId?: string;
  /** Start this agent's delegation requests without the user's approval, within these limits. */
  autoApprove?: AutoApprove;
  /** Spend on the host's local date `day` (YYYY-MM-DD). */
  spend: { day: string; usd: number };
  /** Newest last, capped. */
  runs: StandingRun[];
}

export interface StandingAgentInput {
  name: string;
  charter: string;
  model?: string;
  trigger: StandingTrigger;
  enabled?: boolean;
  budget?: Partial<StandingAgent['budget']>;
  tools?: StandingToolGroup[];
  /** A machine id to run on, or '' / undefined for this host. */
  machineId?: string;
  autoApprove?: Partial<AutoApprove>;
}

/** Auto-approval of a standing agent's delegation requests (docs/standing-agents.md). */
export interface AutoApprove {
  enabled: boolean;
  maxPerRun: number;
  maxPerDay: number;
  model: string;
  effort: EffortLevel;
  /** Where workers may start: unused sandboxes first, then idle machines; or only one kind. */
  targets: 'sandboxes-then-machines' | 'sandboxes' | 'machines';
  /** A request that finds no free target is retried until this many hours after it was filed. */
  expiryHours: number;
  /** Sandbox or machine ids never used, whatever their label. */
  exclude: string[];
}

export type DelegationStatus = 'pending' | 'approved' | 'rejected' | 'expired';

export interface DelegationRequest {
  id: string;
  agentId: string;
  agentName: string;
  title: string;
  task: string;
  createdAt: string;
  status: DelegationStatus;
  decidedAt?: string;
  /** Set once approved: where the worker runs. */
  sandboxId?: string;
  machineId?: string;
  sessionId?: string;
  note?: string;
  /** Auto-approval: queued waiting for a free target until `expiresAt`, or started without the user. */
  auto?: 'queued' | 'started';
  autoApproved?: boolean;
  expiresAt?: string;
  /** The run it was filed in (the per-run limit). */
  runId?: string;
  model?: string;
  effort?: EffortLevel;
  /** When the delegated worker first finished a turn. */
  finishedAt?: string;
  /** What happened to it, oldest first: "10:02 queued: no free target", "10:05 started in sb2". */
  log?: string[];
  /** Who the run that filed it was for (the system payer for a scheduled run). */
  requestedBy?: Requester;
  /** The person who approved it; absent when auto-approved. Its worker is requested by them. */
  approvedBy?: Requester;
}

/** Facts about the host process itself, for the dashboard banner. */
export interface HostStatus {
  /** The server runs with administrator rights, so it refuses to start Unity editors. */
  elevated: boolean;
  /** This host has a per-sandbox editor configured (config unity.editorPath). False hides the editor controls. Absent from older servers: treated as true. */
  editor?: boolean;
  /** Why it is still elevated and what fixes it. */
  elevatedWhy?: string;
  /** A restart is waiting for busy agents to finish (scripts/restart.ps1 or request_app_update). */
  drain?: DrainStatus;
  /** Disks, the sandbox drive, memory, and what the guard is doing about them (server/hostHealth.ts). */
  health?: HostHealth;
}

export type DiskLevel = 'ok' | 'warn' | 'critical';

export interface HostHealth {
  checkedAt: string;
  /** Each watched volume (the sandbox root's and config hostDiskPaths'), with its guard level. */
  disks: { path: string; freeBytes?: number; totalBytes?: number; level: DiskLevel }[];
  /** The worst disk level. */
  level: DiskLevel;
  /** The sandbox drive: there, gone, being reattached, or given up on (see detail). */
  sandboxRoot: 'ok' | 'missing' | 'remounting' | 'failed';
  detail?: string;
  memFreeBytes: number;
  memTotalBytes: number;
  /** Why new editors and new agent processes are refused right now, if they are. */
  blocked?: string;
  /** The last clean-up pass (server/cleanup.ts). */
  lastCleanup?: CleanupSummary;
  /** Automatic Unity restarts in the last hour, per sandbox (docs/unity-lifecycle.md). */
  unityRestarts?: { sandbox: string; at: string; reason: string }[];
  /** The orphan headless-browser reaper's last pass that found something (server/reaper.ts). */
  lastReap?: { at: string; killed: number; lines: string[] };
}

/** One clean-up pass on a computer (server/cleanup.ts): the host guard's or a machine daemon's. */
export interface CleanupSummary {
  at: string;
  /** hourly: the regular pass; low-space: below the soft threshold; critical: the host guard's critical level; asked: by hand. */
  trigger: 'hourly' | 'low-space' | 'critical' | 'asked';
  removed: number;
  freedBytes?: number;
  /** Entries skipped (in use, refused by the guard, or only partly removed). */
  failed?: number;
  /** Free space after the pass on the fullest volume it watches. */
  freeBytes?: number;
  softFreeGB: number;
  /** Still below the soft threshold after the pass. */
  belowSoft?: boolean;
  /** The biggest entries it removed. */
  top?: { path: string; bytes: number; rule: string }[];
  /** When it could not get above the soft threshold: the biggest remaining consumers. */
  consumers?: { path: string; bytes: number }[];
  /** Unity Libraries of projects not opened for a long time: reported, removed only past a longer age. */
  staleLibraries?: { path: string; days: number }[];
}

export interface DrainStatus {
  reason: string;
  update: boolean;
  startedAt: string;
  deadline: string;
  /** Sessions still mid-turn. */
  waitingFor: string[];
}

// ---- notifications ----

export type NotifyKind = 'permission' | 'person' | 'turnEnd' | 'error' | 'standing' | 'delegation' | 'unity' | 'host';
export type NotifyPrefs = Record<NotifyKind, boolean>;

export const NOTIFY_KINDS: { value: NotifyKind; label: string; hint: string }[] = [
  { value: 'permission', label: 'Needs permission', hint: 'an agent is waiting for you to allow a tool' },
  { value: 'person', label: 'Messages from people', hint: 'someone sent you a message through their orchestrator' },
  { value: 'turnEnd', label: 'Turn finished', hint: 'the orchestrator or a worker finished a turn' },
  { value: 'error', label: 'Errors', hint: 'a session stopped with an error' },
  { value: 'standing', label: 'Standing agent problems', hint: 'a run failed, hit its budget or ran out of time' },
  { value: 'delegation', label: 'Delegation requests', hint: 'a standing agent asks for a worker' },
  { value: 'unity', label: 'Unity editor stuck', hint: 'an editor is blocked on a dialog or has gone silent while starting' },
  { value: 'host', label: 'Host health', hint: 'disk space low, the sandbox drive gone or back, automatic recovery steps' },
];

/** One plan usage meter (server/usage.ts). */
export interface UsageMeter {
  label: string;
  /** Share of the window used, 0-100. */
  percent: number;
  resetsAt?: string;
  /** The server's grading ('normal', 'warning', 'critical'), when it gives one. */
  severity?: string;
}

/** the user's Claude plan usage limits, from the claude.ai usage endpoint via the Agent SDK. */
export interface PlanUsage {
  available: boolean;
  /** When these numbers were fetched. */
  asOf: string;
  /** 'max', 'pro', ... */
  plan?: string;
  weekly?: UsageMeter;
  /** The 5-hour session window. */
  session?: UsageMeter;
  /** Per-model weekly windows (e.g. "Weekly Fable"). */
  models: UsageMeter[];
  /** Why the plan numbers are unavailable. */
  why?: string;
  /** The last refresh failed; the numbers are from asOf. */
  error?: string;
  /** Where the numbers came from when not the usage endpoint, e.g. "rate-limit headers" (weekly and session only). */
  source?: string;
  /** Only when unavailable: SketchUp Factory's own agent spend over the last 7 days (spend, not the plan limit). */
  spendWeekUsd?: number;
}

/**
 * One Claude account the portal's agents or the user's machines run on, with its plan usage. Identified
 * safely: the last 4 characters of a token, or a login's email; never the credential itself.
 */
export interface AccountUsage {
  /** Stable key: "token:<sha256 prefix>", "email:<address>", or "login:<where>" while a login's email is unknown. */
  id: string;
  kind: 'token' | 'login';
  /** "host token …9AAA", or the login's email. */
  label: string;
  email?: string;
  /**
   * The credentials that are this account: "token:<sha256 prefix>", "host:login" (this host's own claude.ai
   * login) or "login:<machine id>" (a Mac's own login). Several when one login is signed in on several computers.
   */
  sources: string[];
  /** Where it is used, for people: "BEAST login", "m3 login", "the agents' token on BEAST, m5". */
  where: string[];
  /** The portal's agents that run on it now, by session id. */
  sessionIds: string[];
  usage?: PlanUsage;
}

/** One transcript search result: where, when, and the text around the match. */
export interface SearchHit {
  sessionId: string;
  seq: number;
  t: string;
  kind: TranscriptEvent['kind'];
  snippet: string;
  title: string;
  sessionKind?: SessionKind;
  sandboxId?: string;
  machineId?: string;
  standingId?: string;
}

/** Server-wide settings the user changes from the UI (or the orchestrator's tools). */
export interface AppSettings {
  /** The one heartbeat from before each person had their own orchestrator: moved into `heartbeat` (the owner's) at startup. */
  heartbeatMinutes: number | null;
  /** Each person's heartbeat, by user id: while their workers are mid-turn, their orchestrator is woken every N minutes. */
  heartbeat?: Record<string, number>;
}

// ---- the work ledger (docs/orchestrators.md) ----

/** Where a work request stands. The first four are open. */
export type WorkStatus = 'new' | 'question' | 'queued' | 'active' | 'merged' | 'done' | 'rejected' | 'cancelled';
export const WORK_OPEN: readonly WorkStatus[] = ['new', 'question', 'queued', 'active'];

export type WorkPriority = 'low' | 'normal' | 'high' | 'urgent';
export const WORK_PRIORITIES: readonly WorkPriority[] = ['low', 'normal', 'high', 'urgent'];

/** Work in flight or recently done that a new request may repeat, as the server found it when the request was filed. */
export interface WorkOverlap {
  /** A work item ("w12"), a session id, a delegation id or a commit. */
  ref: string;
  kind: 'work' | 'session' | 'delegation' | 'commit';
  title: string;
  /** 0 to 1; 0.8 and over is strong: the dispatcher then gives a reason to start work anyway. */
  score: number;
  /** "same spec 098", "same PR #412", "similar title". */
  why: string;
}

/** A request for work that a person's orchestrator filed with the dispatcher, and what became of it. */
export interface WorkItem {
  id: string;
  title: string;
  brief: string;
  constraints?: string;
  priority: WorkPriority;
  /** Ids the requester named: a spec, a PR, a session, a sandbox, a delegation, another work item. */
  relatedIds?: string[];
  /** Its people's update_work notes, oldest first (w496: every worker started for it gets them with the brief). */
  notes?: { at: string; by: string; text: string }[];
  /** What overlaps are matched on: "spec:098", "pr:412", "branch:098-belts", "session:ab12cd34". */
  keys: string[];
  /** Who filed it: its workers run on their account. */
  requestedBy: Requester;
  /** Everyone it is for, the filer first, then the people whose requests were merged into it. They hear its news. */
  requesters: Requester[];
  /** Filed in a turn the person started (their own message), which the destructive tools require. */
  humanAsked: boolean;
  status: WorkStatus;
  createdAt: string;
  updatedAt: string;
  /** When merged: the item it continues as. */
  mergedInto?: string;
  /** The workers started, messaged or linked for it. */
  sessionIds: string[];
  /** Files its person attached (request_work attachments): every worker started for it gets a copy. */
  attachments?: AttachmentRef[];
  /** What it may repeat, found when it was filed; strongest first. */
  overlaps: WorkOverlap[];
  /** The latest outcome: a worker's last word, or the note it was closed with. */
  outcome?: string;
  /** Questions the dispatcher asked about it (at most 3). */
  asks: number;
  /** What happened, oldest first: "10:02 filed by Lothsahn", "10:03 merged into w11: same fix". */
  log: string[];
  /**
   * Recorded, not filed: a worker that started outside the ledger (the dispatcher's direct start, the dashboard, /mcp,
   * a delegation) and is listed so the ledger shows all work. It does not count against its person's filing limits.
   */
  recorded?: boolean;
  /** Where it came from when not a person's orchestrator: Discord or FFBox, through the intake (docs/intake.md). */
  source?: WorkSource;
  /** The intake's classification, with its reason: an obvious bug may be worked without a person; anything else needs one. */
  triage?: WorkTriage;
  /**
   * Intake requests wait for a person (or an auto-approve rule) before the dispatcher hears of them; start_agent
   * refuses them until then. Absent on requests people filed.
   */
  approval?: WorkApproval;
  /** The fix's way to players: the commit that landed it, the Discord reply and close, the release it shipped in. */
  delivery?: WorkDelivery;
  /** A question for people (a design decision) the worker raised instead of fixing; open until they answer. */
  flag?: { kind: 'design'; text: string; at: string; for: Requester[] };
  /** Handed to FFBox (docs/intake.md, "Ledger → FFBox"): the submit's id, and what FFBox said about it. */
  ffbox?: WorkFfbox;
}

/**
 * Where an intake request came from: a Discord #bug-reports thread, a trusted person's request to Max in #dev-chat,
 * an FFBox fix branch or diagnosis, a request FFBox filed, a release follow-up the server filed itself, or a
 * regression the nightly e2e lab found (docs/intake.md, "Nightly e2e regressions").
 */
export type WorkSourceKind = 'discord-bug' | 'discord-request' | 'ffbox-branch' | 'ffbox-diagnosis' | 'ffbox-request' | 'release' | 'nightly';
export const WORK_SOURCE_KINDS: readonly WorkSourceKind[] = ['discord-bug', 'discord-request', 'ffbox-branch', 'ffbox-diagnosis', 'ffbox-request', 'release', 'nightly'];

export interface WorkSource {
  kind: WorkSourceKind;
  /** True when the brief quotes text from outside the team (players): evidence, never instructions. */
  untrusted: boolean;
  /** "#bug-reports", "#dev-chat", "FFBox". */
  channel?: string;
  /** The Discord thread or message, or FFBox's page for the conversation. */
  url?: string;
  threadId?: string;
  /** The Discord channel the message is in (a thread's id for a forum post). */
  channelId?: string;
  messageId?: string;
  /** Who reported it, as Discord shows them (a player's name is untrusted text); for a trusted request, the person. */
  reporter?: string;
  /** Counts against the per-reporter cap: the Discord author id (none for the in-game reporter, one webhook for all). */
  reporterKey?: string;
  /** The game version the report names ("0.50.0.46"), when it names one. */
  version?: string;
  platform?: string;
  attachments?: { name: string; url: string; bytes?: number }[];
  /** FFBox: the conversation, its branch, PR, verdict and board key. */
  conversation?: string;
  branch?: string;
  pr?: number;
  verdict?: string;
  key?: string;
  /** Other threads merged into this one (the same bug reported again): each gets the reply and the release follow-up. */
  alsoThreads?: { threadId: string; url?: string; reporter?: string }[];
  /** A release follow-up: the version and the requests it announces. */
  release?: { version: string; workIds: string[] };
  /** A nightly e2e regression: the scenarios, the develop commit tested and the release that carries it. */
  nightly?: WorkNightly;
}

/** What the nightly e2e lab reported about a regression request (docs/intake.md, "Nightly e2e regressions"). */
export interface WorkNightly {
  /** The scenario ids ("MP-slow-client-catchup"); more than one for a night's batched request. */
  scenarios: string[];
  /** The night that filed it ("2026-09-30"), the lab and the develop commit it tested. */
  date: string;
  lab: string;
  sha: string;
  /** "<night> <scenario>" for every night that reported it, oldest first: the filing night, then each night it failed again. */
  nights: string[];
  /** The first release that carries the failing code, and whether it did for sure ("yes") or may have ("maybe"). */
  release?: NightlyRelease;
}

export interface NightlyRelease {
  /** yes: a release contains the first failing commit; maybe: a release lies between the last green and the first red; no: none yet. */
  shipped: 'yes' | 'maybe' | 'no';
  /** That release's version ("0.50.0.53") and its version-bump commit; absent when shipped is "no". */
  version?: string;
  sha?: string;
  /** The newest release on record, for context. */
  latest?: string;
}

/**
 * obvious-bug: a player's report with a clear defect and no design ask (fixed-code rules, conservative); needs-human:
 * anything else from players or FFBox, which nobody works until a reviewer approves or answers; person: a reviewer or
 * operator asked for it themselves; follow-up: the server's own release follow-up; regression: a scripted oracle of
 * the team's own nightly e2e lab failed (no players' text).
 */
export type WorkTriageClass = 'obvious-bug' | 'needs-human' | 'person' | 'follow-up' | 'regression';

export interface WorkTriage {
  class: WorkTriageClass;
  /** Why, in one line: the signals the rules saw ("a crash on 0.50.0.46, no design ask") or what was missing. */
  reason: string;
}

export interface WorkApproval {
  state: 'pending' | 'approved' | 'declined';
  /** 'auto': an auto-approve rule in config intake; else the person who clicked. */
  by?: Requester | 'auto';
  at?: string;
  /** Why it was not auto-approved (auto-approve off, today's auto cap reached, a strong overlap). */
  why?: string;
}

export interface WorkDelivery {
  /** FIX-LANDED <sha>: the commit the worker said carries the fix (checked against the base branch). */
  fixCommit?: string;
  fixAt?: string;
  /** Seen on the base branch (git merge-base --is-ancestor). */
  landedAt?: string;
  /** Max replied in, and closed, the thread (from the ffdiscord events file). */
  repliedAt?: string;
  closedAt?: string;
  /** The first release (bundleVersion bump on the base branch) that contains the fix. */
  releasedIn?: string;
  releasedAt?: string;
  /** The release follow-up request that tells the reporter ("live in 0.50.0.X"). */
  announcedBy?: string;
}

export interface WorkFfbox {
  requestId: string;
  state: 'sent' | 'accepted' | 'refused' | 'done';
  class: 'fenced' | 'open';
  sentAt: string;
  conversation?: string;
  billedTo?: string;
  reason?: string;
  branch?: string;
  pr?: number;
  verdict?: string;
}

/** One thing the intake saw and what it did with it (the Intake tab's log). */
export interface IntakeEntry {
  at: string;
  source: WorkSourceKind;
  /** filed: a new request; repeat: added to the request it repeats; skipped: a cap or a rule; ignored: not intake. */
  action: 'filed' | 'repeat' | 'skipped' | 'ignored';
  /** Cleaned and cut short; a player's text is shown as plain text only. */
  title: string;
  workId?: string;
  why?: string;
  url?: string;
}

/** The intake's settings as the server runs them, and today's numbers (docs/intake.md). Everything defaults to off. */
export interface IntakeSummary {
  discord: {
    enabled: boolean;
    bugChannels: string[];
    requestChannels: string[];
    /** Channels FFBox owns, which the intake never files from (docs/intake.md). */
    ffboxOwned?: string[];
    /** The SketchUp Factory logins trusted Discord ids map to (never the ids themselves). */
    trustedPeople: string[];
    dailyCap: number;
    perReporterPerDay: number;
    autoApprove: { enabled: boolean; maxPerDay: number; bugs: boolean; requests: boolean };
    polledAt?: string;
    error?: string;
  };
  ffbox: {
    enabled: boolean;
    branches: boolean;
    diagnoses: boolean;
    requests: boolean;
    escalations: boolean;
    boardCheck: boolean;
    sendWork: boolean;
    dailyCap: number;
    autoApprove: { enabled: boolean; maxPerDay: number };
  };
  release: { enabled: boolean; delayMinutes: number; lastVersion?: string; checkedAt?: string };
  /** The nightly e2e lab's regressions (config intake.nightly); optional for a page from before it existed. */
  nightly?: {
    enabled: boolean;
    autoApprove: { enabled: boolean; maxPerDay: number };
    dailyCap: number;
    flakyNights: number;
    batchOver: number;
    /** The last report the lab posted, and what it came to. */
    last?: { at: string; date: string; lab: string; sha: string; filed: number; attached: number; skipped: number };
  };
  /** Who approves what needs a human and answers design questions (config intake.reviewers; default the owner). */
  reviewers: string[];
  /** Their user ids: only they see Approve and Decline. */
  reviewerIds: string[];
  today: { filed: number; skipped: number; autoApproved: number; pending: number };
  recent: IntakeEntry[];
}

/** This app's version (root package.json) and the short git SHA of the running checkout. */
export interface AppVersion {
  version: string;
  sha?: string;
  /** The web UI build the server serves now (server/webStatic.ts); a page that loaded another reloads. Absent from older servers. */
  web?: string;
}

export interface AppState {
  /** The running server's version; absent from a server older than 0.1.0. */
  app?: AppVersion;
  sandboxes: Sandbox[];
  sessions: SessionInfo[];
  standingAgents: StandingAgent[];
  delegations: DelegationRequest[];
  machines: Machine[];
  /** Providers (FFBox); absent from a server older than this field. */
  providers?: Provider[];
  /** FFBox's summary even while it is off (the External strip and its setup page); absent from older servers. */
  ffbox?: Provider;
  /** Max, the Discord bot our agents post as (docs/max.md); absent from a server older than this field. */
  max?: MaxSummary;
  system?: SystemStats;
  host: HostStatus;
  usage?: PlanUsage;
  /** Every Claude account in use, with its plan usage; absent from a server older than this field. */
  accounts?: AccountUsage[];
  /** Each online machine's load, by machine id; absent from a server older than this field. */
  machineStats?: Record<string, MachineStats>;
  /** The signed-in person's own orchestrator: the chat the home page shows (docs/orchestrators.md). */
  orchestratorId: string;
  /** The dispatcher; absent from a server older than this field. */
  dispatcherId?: string;
  /** Who this page is signed in as; absent from a server older than this field. */
  me?: UserInfo;
  /** The work ledger: every open item, and the ones closed in the last 3 days (at most 100). */
  work?: WorkItem[];
  /** Discord and FFBox intake into the ledger (docs/intake.md); absent from a server older than this field. */
  intake?: IntakeSummary;
  config: { defaultModel: string; models: string[]; defaultBase: string; attachments: AttachmentSettings };
  settings: AppSettings;
}

/** An orchestrator's timer as its person sees it (server/timers.ts TimerView; docs/orchestrators.md "Timers"). */
export interface TimerInfo {
  id: string;
  owner: string;
  title: string;
  note: string;
  scheduleText: string;
  state: 'active' | 'paused' | 'ended';
  createdAt: string;
  createdBy: string;
  nextFireAt?: string;
  lastFiredAt?: string;
  lastDeliveredAt?: string;
  fires: number;
  /** Fires waiting to be delivered (after the current turn, or for the budget). */
  pending?: number;
  skipped?: number;
  until?: string;
  maxFires?: number;
  endedAt?: string;
  endReason?: 'fired' | 'until' | 'max_fires' | 'cancelled';
}

/** GET /api/timers/<orchestrator id>. */
export interface TimersAnswer {
  timers: TimerInfo[];
  deliveredToday: number;
  limits: { activePerOwner: number; deliveriesPerDay: number; minEveryMinutes: number };
}

/** Pushed over the WebSocket at /ws. */
export type ServerEvent =
  | { type: 'state'; state: AppState }
  | { type: 'sandbox'; sandbox: Sandbox }
  | { type: 'sandbox_removed'; id: string }
  | { type: 'session'; session: SessionInfo }
  | { type: 'session_removed'; id: string }
  | { type: 'standing'; agent: StandingAgent }
  | { type: 'standing_removed'; id: string }
  | { type: 'delegation'; request: DelegationRequest }
  | { type: 'machine'; machine: Machine }
  /**
   * Something worth a notification; pages without a push subscription may show it themselves. `users`: the people
   * it is for (user ids); only their pages get it. Absent: everyone.
   */
  | { type: 'notify'; notice: { kind: NotifyKind; title: string; body: string; url: string; tag: string }; users?: string[] }
  | { type: 'work'; item: WorkItem }
  | { type: 'intake'; intake: IntakeSummary }
  | { type: 'machine_removed'; id: string }
  | { type: 'provider'; provider: Provider }
  | { type: 'max'; max: MaxSummary }
  | { type: 'settings'; settings: AppSettings }
  | { type: 'transcript'; sessionId: string; event: TranscriptEvent }
  /** Live assistant text while a turn streams; the UI shows it until the 'assistant' event lands. */
  | { type: 'delta'; sessionId: string; text: string }
  | { type: 'system'; system: SystemStats }
  | { type: 'host'; host: HostStatus }
  | { type: 'usage'; usage: PlanUsage }
  | { type: 'accounts'; accounts: AccountUsage[] }
  /** null: the machine went offline and its numbers are gone. */
  | { type: 'machine_stats'; id: string; stats: MachineStats | null }
  /** Keep-alive, every SOCKET_PING_MS: a page that hears nothing for longer treats its socket as dead. */
  | { type: 'ping' };

/** How often the server pings every browser socket (server/index.ts); the page's staleness limit is a few of these. */
export const SOCKET_PING_MS = 15_000;

// ---- REST request bodies ----

export interface CreateSandboxRequest {
  name: string;
  /** Branch to create or check out. Defaults to "sandbox/<name>". */
  branch?: string;
  /** Base ref for a new branch. Defaults to config.defaultBase. */
  base?: string;
  purpose?: string;
  /** Copy the warm Library seed into the worktree (needed for a fast Unity start). Default true. */
  seedLibrary?: boolean;
  startUnity?: boolean;
}

export interface StartSessionRequest {
  effort?: EffortLevel;
  /** Exactly one of sandboxId and machineId. */
  sandboxId?: string;
  machineId?: string;
  prompt: string;
  title?: string;
  model?: string;
  permissionMode?: PermissionMode;
}

export interface SendMessageRequest {
  text: string;
  images?: ImageInput[];
  /** Ids of files uploaded first (POST /api/attachments, docs/attachments.md). */
  attachments?: string[];
}

export interface PermissionDecisionRequest {
  requestId: string;
  allow: boolean;
  message?: string;
}
