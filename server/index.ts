import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { WebSocketServer, type WebSocket } from 'ws';
import { HOST_ROLES, editorConfigured, loadConfig, machineCleanupSettings, publicIdentityOf, ROOT } from './config.ts';
import { Store, bus } from './store.ts';
import { SandboxManager } from './sandboxes.ts';
import { SessionManager, snapshotOf } from './sessions.ts';
import { Agents } from './agents.ts';
import { MachineManager, machineForPath, parseSandboxRef } from './machines.ts';
import { hostSandboxFrom } from './hostMigration.ts';
import { ProviderManager } from './providers.ts';
import { MaxManager } from './max.ts';
import { IntakeManager } from './intake.ts';
import { parseNightlyReport } from './nightlyRules.ts';
import { parseEscalation } from './escalationRules.ts';
import { groupIntake } from '../shared/intake.ts';
import { Notifier } from './notify.ts';
import { refreshSandboxGit } from './gitStatus.ts';
import { describeBusy } from './wake.ts';
import type { SessionHandle } from './sessions.ts';
import { machineLoadLine, systemStats } from './system.ts';
import { Auth } from './auth.ts';
import { Identity, asRequester, userToken } from './identity.ts';
import { handleMcp } from './mcp.ts';
import { IMAGE_TYPES, SOCKET_PING_MS, type ImageInput, type NotifyPrefs, type SendMessageRequest } from '../shared/types.ts';
import { listImages, MEDIA_TYPE, openVideo, parseRange, readImage, VIDEO_FILE } from './images.ts';
import { keepMessageImages } from './inlineImages.ts';
import { AttachmentError, AttachmentStore, downloadDisposition, machineAttachment, publicRef } from './attachments.ts';
import { HostHealthMonitor } from './hostHealth.ts';
import { dataRecoveries, describeRecovery } from './durable.ts';
import { backupMemory, healMemory, memoryRootOf } from './orchestratorMemory.ts';
import { describeMemoryGit, versionMemory } from './memoryGit.ts';
import { accountSetupLines, hostAccount, hostRole, scrubTranscripts, usesHostClaudeEnv } from './secrets.ts';
import { collectNetwork, loadOutsideWatchState, outsideWatchConfig, saveOutsideWatchState, watcherOf } from './outsideWatch.ts';
import { runHelper } from './privileged.ts';
import { endMaybeGzip } from './compress.ts';
import { serveStatic, webBuild } from './webStatic.ts';
import { appendCleanupLog, biggestConsumers, cleanupRules, hostCleanupEnv, neverDelete, planCleanup, runCleanup, sessionTempDir, staleUnityLibraries } from './cleanup.ts';
import { pruneEditorLogs, slugify } from './sandboxes.ts';
import { reapBrowsers } from './reaper.ts';
import { TASK_NAME, checkElevation } from './elevation.ts';
import { Drainer, clearPendingRestart, describeUncleanStop, mayRecoverUnclean, parseRestartRequest, readAlive, takePendingRestart, takeResumeFile, writeAlive, writePendingRestart, writeResumeFile, type RestartRequest } from './restart.ts';
import { UsageTracker, accountLines, buildAccounts, hostToken, machineToken, sessionSource, tokenKey, tokenLabel } from './usage.ts';
import { appVersion, formatVersion } from './version.ts';
import { VoiceService } from './voice.ts';
import { MAX_DICTATION_SECONDS, MAX_TTS_CHARS, buildVoicePrompt, wavSeconds, type SpeakRequest, type TranscribeRequest, type VocabularySource } from '../shared/voice.ts';
import type { AppState, CreateSandboxRequest, HostStatus, Machine, PermissionDecisionRequest, ServerEvent, SessionInfo, SessionKind, StandingAgentInput, StartSessionRequest, SystemStats } from '../shared/types.ts';

const WEB = path.join(ROOT, 'web', 'dist');

/** The server's version plus the web UI build it serves now (server/webStatic.ts): an open page reloads when that changes. */
const appNow = () => ({ ...appVersion(), web: webBuild(WEB) });

const cfg = loadConfig();
fs.mkdirSync(cfg.dataDir, { recursive: true });

// First of all, before anything is started: never run elevated (server/elevation.ts). Everything this
// server starts inherits its token, and an elevated Unity editor stops on a modal admin dialog.
const elevation = await checkElevation(cfg.dataDir);
if (elevation === 'exit') {
  console.log(`Running elevated: handed off to the Limited ${TASK_NAME} task (scripts/restart.ps1 relaunches the app non-elevated). Exiting.`);
  process.exit(0);
}
const host: HostStatus = { elevated: elevation.elevated, elevatedWhy: elevation.why, editor: editorConfigured(cfg) };
if (host.elevated) {
  console.error(
    `\n!!!!!!!! SketchUp Factory is running WITH ADMINISTRATOR RIGHTS. It will not start Unity editors (they would stop on Unity's administrator dialog), ` +
      `and every agent shell inherits admin rights. ${host.elevatedWhy ?? ''} Fix: run scripts/restart.ps1 (from any shell).\n`,
  );
}

// When the last server was last alive (its heartbeat), read before this one beats: after an unclean stop it
// dates the outage and tells a power cut (the machine booted since) from a server crash.
const lastAlive = readAlive(cfg.dataDir);
writeAlive(cfg.dataDir);
setInterval(() => writeAlive(cfg.dataDir), 30_000);

const store = new Store(cfg.dataDir);
// The orchestrators' memory (Claude Code writes it, so it cannot be written crash-safe): a file a crash damaged gets its
// newest good backup back, and a backup is taken every 10 minutes when something changed (server/orchestratorMemory.ts).
const memoryRoot = memoryRootOf(cfg);
// When the memory root is a git repository of its own, each backup pass also commits what changed and pushes it, to a
// private remote only (server/memoryGit.ts; docs/orchestrators.md, "Memory in a private repository").
let lastMemoryGit = '';
const versionMemoryNow = () => {
  const pub = publicIdentityOf(cfg);
  const identity = pub.name && pub.email ? { name: pub.name, email: pub.email } : { name: 'FF Factory', email: 'ff-factory@users.noreply.github.com' };
  void versionMemory(memoryRoot, { identity })
    .then((r) => {
      const line = describeMemoryGit(r);
      // A push that keeps failing says so once, not every ten minutes.
      if (line && (r.state === 'pushed' || line !== lastMemoryGit)) console[r.state === 'pushed' ? 'log' : 'warn'](line);
      lastMemoryGit = line ?? '';
    })
    .catch((e) => console.warn(`orchestrator memory versioning failed: ${(e as Error).message}`));
};
const guardMemory = (what: 'heal' | 'backup') => {
  try {
    if (what === 'heal') healMemory(memoryRoot);
    else {
      backupMemory(memoryRoot);
      versionMemoryNow();
    }
  } catch (e) {
    console.warn(`orchestrator memory ${what} failed: ${(e as Error).message}`);
  }
};
guardMemory('heal');
guardMemory('backup');
setInterval(() => guardMemory('backup'), 10 * 60_000).unref();
// Transcripts written before redaction existed: no Claude OAuth or Discord token stays on disk (server/secrets.ts).
setTimeout(() => {
  const n = scrubTranscripts(path.join(cfg.dataDir, 'transcripts'));
  if (n) console.log(`secrets: redacted secrets (Claude OAuth or Discord tokens) in ${n} transcript(s)`);
}, 5000);
const sandboxes = new SandboxManager(cfg, store);
const sessions = new SessionManager(cfg, store);
const machines = new MachineManager(cfg, store, sessions);
// Files people attach to messages (docs/attachments.md): stored by SHA-256, never opened; old ones go by retention.
const attachments = new AttachmentStore(cfg.dataDir, () => cfg.attachments);
machines.attachments = attachments;
const pruneAttachments = () => {
  try {
    const r = attachments.prune();
    if (r.records || r.blobs || r.partials) console.log(`attachments: retention removed ${r.records} record(s), ${r.blobs} stored file(s), ${r.partials} unfinished upload(s)`);
  } catch (e) {
    console.warn(`attachments: retention failed: ${(e as Error).message}`);
  }
};
setTimeout(pruneAttachments, 60_000).unref();
setInterval(pruneAttachments, 60 * 60_000).unref();
// FFBox, through the connector it runs (docs/ffbox-integration.md): read-only reports, off by default.
const providers = new ProviderManager(cfg);
// Max, the Discord bot agents post as (docs/max.md): their ffdiscord calls, the token's health, a read-only inbound.
const max = new MaxManager(cfg, {
  session: (id) => store.sessions.get(id),
  standingName: (id) => store.standing.get(id)?.name,
}).start();
machines.maxEvent = (machineId, line) => max.ingestLine(line, machineId);
// A daemon that has not come back 2 minutes after a restart (or a drop) while ssh reaches its Mac is redeployed.
// The machines' own Unity watch: tell the orchestrator and the user, and the machine's agents after a restart.
machines.unityEvent = (machineId, text, restarted, sandbox) => {
  const line = `[unity] machine ${machineId}: ${text}`;
  console.log(line);
  notifier.host(`Unity on ${machineId}${sandbox ? `/${sandbox}` : ''}${restarted ? ' restarted' : ''}`, text);
  const orch = store.orchestratorId;
  if (orch) {
    try {
      sessions.send(orch, line, 'system');
    } catch {
      // no orchestrator right now
    }
  }
  if (!restarted) return;
  const recent = Date.now() - 30 * 60_000;
  for (const s of store.sessions.values()) {
    // Only the agents of that editor's place: the sandbox's, or the main clone's.
    if (s.machineId !== machineId || s.kind === 'standing' || s.machineSandbox !== sandbox || s.stoppedOnPurpose) continue;
    if (!['running', 'starting', 'waiting_permission'].includes(s.status) && Date.parse(s.lastActivityAt) < recent) continue;
    try {
      sessions.send(s.id, `Unity ${sandbox ? `of your sandbox (${sandbox})` : 'on this machine'} was restarted automatically at ${new Date().toLocaleTimeString()} (${text.split(';')[0]}). Re-pin it (mcpforunity://instances, then set_active_instance) once its bridge is up, and continue where you left off.`, 'system');
    } catch {
      // offline or at its limit: it sees the editor state on its next Unity call
    }
  }
};
machines.sandboxEvent = (machineId, text, e) => {
  const line = `[sandboxes] ${machineId}: ${text}`;
  console.log(line);
  if (e.checkpoint) notifier.host(`Disk critical on ${machineId}`, text);
  const orch = store.orchestratorId;
  if (orch) {
    try {
      sessions.send(orch, line, 'system');
    } catch {
      // no orchestrator right now
    }
  }
  if (!e.checkpoint) return;
  // The machine's disk guard: its sandbox agents mid-turn commit, push and stop (as the host's guard asks its own).
  for (const s of store.sessions.values()) {
    if (s.machineId !== machineId || !s.machineSandbox || !['running', 'starting', 'waiting_permission'].includes(s.status)) continue;
    try {
      sessions.send(s.id, '[disk critical] Free disk space on this machine is critically low. Commit and push your work now (a WIP commit is fine) and end your turn; new work waits until space is freed. You will be told when to continue.', 'system');
    } catch {
      // it sees the refusal on its next start
    }
  }
};
machines.report = (text) => {
  console.log(text);
  const orch = store.orchestratorId;
  if (orch) {
    try {
      sessions.send(orch, text, 'system');
    } catch {
      // no orchestrator right now
    }
  }
};
// Each machine's own clean-up (docs/self-recovery.md): its settings, and a notice when it cannot free enough.
// The portal's own host as a machine (docs/beast-machine.md) cleans nothing itself: this host's guard already cleans
// this computer, with its own rules, and counts that daemon's running agents' temp folders as in use.
machines.cleanupFor = (id) => (store.machines.get(id)?.local ? { everyMinutes: 0, softFreeGB: 0 } : machineCleanupSettings(cfg, id));
machines.cleanupNotice = (machineId, text) => {
  notifier.host(`Disk space on ${machineId}`, text);
  machines.report?.(`[machine ${machineId}] Clean-up cannot free enough disk space. ${text}`);
};
// The outside watchdog (docs/self-recovery.md): a Mac watches this host and alerts the user's phone through ntfy.
const outside = loadOutsideWatchState(cfg.dataDir);
const watcher = () => (cfg.outsideWatch?.enabled === false ? undefined : watcherOf(cfg.outsideWatch?.machine, machines.list().map((m) => m.id)));
// Without publicUrl, the address the machines were deployed with (add_machine's portal_url) is the same portal.
const portalUrl = () => cfg.publicUrl ?? machines.list().find((m) => /^https?:\/\//.test(m.portalUrl ?? ''))?.portalUrl;
const watchConfig = () => outsideWatchConfig({ ...cfg.outsideWatch, publicUrl: portalUrl(), name: os.hostname() }, outside);
machines.outsideWatchFor = (id) => (id === watcher() ? (watchConfig() ?? null) : null);
const learnNetwork = () =>
  void collectNetwork()
    .then((n) => {
      if (!n || (n.mac === outside.mac && n.broadcast === outside.broadcast && n.ip === outside.ip)) return;
      Object.assign(outside, n, { collectedAt: new Date().toISOString() });
      saveOutsideWatchState(cfg.dataDir, outside);
      machines.pushOutsideWatch();
    })
    .catch((e) => console.warn('outside watch: could not read the LAN adapter:', (e as Error).message));
learnNetwork();
setInterval(learnNetwork, 6 * 3_600_000);
setInterval(() => {
  void machines.watchOffline().catch((e) => console.warn('machine watchdog:', (e as Error).message));
  machines.checkOutdated();
}, 30_000);
const auth = new Auth(cfg.dataDir, { trustProxy: cfg.trustProxy });
// Who is who (docs/identity.md): the logins in data/users.json, and who automatic work is billed to.
const identity = new Identity(cfg, () => auth.userInfos());
const agents = new Agents(cfg, store, sandboxes, sessions, machines, identity);
agents.attachments = attachments;
if (host.elevated) sandboxes.refuseUnityWhileElevated(host.elevatedWhy ?? 'Run scripts/restart.ps1 to relaunch it non-elevated.');

/** The signed-in person making this request, as work records them (a route only runs for a signed-in user). */
function requesterOf(req: http.IncomingMessage) {
  const u = auth.userInfo(auth.user(req));
  return u ? asRequester(u) : identity.owner();
}

/**
 * Who may drive an orchestrator (docs/orchestrators.md): a person's own only by that person, the dispatcher only by an
 * owner. So one person's chat never gets the other's messages, and nobody spends someone else's Claude account.
 */
function mayDrive(req: http.IncomingMessage, s: SessionInfo) {
  if (s.kind !== 'orchestrator') return;
  const me = requesterOf(req);
  const owner = agents.orchestrators.ownerOf(s);
  if (owner) {
    if (owner.userId.toLowerCase() !== me.userId.toLowerCase()) throw new HttpError(403, `this is ${owner.displayName}'s own orchestrator; write to yours`);
    return;
  }
  if (identity.get(me.userId)?.role !== 'owner') throw new HttpError(403, 'only the owner writes to the dispatcher; ask your own orchestrator, which files work with it');
}
const notifier = new Notifier(cfg.dataDir, store, sessions);
notifier.orchestratorId = () => store.orchestratorId;
// Who hears about a session (docs/orchestrators.md): a person's own orchestrator only them, the dispatcher's turns
// nobody (its questions and errors the owners), a worker's finished turns the people it works for.
notifier.audience = (s, kind) => {
  const owner = agents.orchestrators.ownerOf(s);
  if (owner) return [owner.userId];
  if (agents.orchestrators.isDispatcher(s)) return kind === 'turnEnd' ? [] : identity.list().filter((u) => u.role === 'owner').map((u) => u.userId);
  // A worker's finished turn: the people it works for, and whoever wrote to it last (they may be following it).
  // Intake work nobody asked for in person (docs/intake.md) reaches people through the ledger and the heartbeat instead.
  if (s.kind === 'worker' && kind === 'turnEnd' && agents.orchestrators.intakeOnly(s.id)) return [];
  if (s.kind === 'worker' && kind === 'turnEnd') return [...new Set([...agents.orchestrators.audienceOf(s), ...(s.lastRequestedBy ? [s.lastRequestedBy] : [])].map((r) => r.userId.toLowerCase()))];
  return undefined;
};
agents.orchestrators.onPersonMessage = (from, to, text) => notifier.personMessage(from, to, text);
agents.standing.events.on('run', (a, run) => notifier.standingRun(a, run));
agents.standing.events.on('delegation', (d) => notifier.delegation(d));
agents.standing.events.on('delegationUpdate', (d, what) => notifier.delegationUpdate(d, what));
sandboxes.events.on('blocked', (sb, b) => notifier.unityBlocked(sb, b));

// Automatic editor restarts (docs/unity-lifecycle.md): a [unity] notice, and once the editor is back up, a
// message to the sandbox's agents to re-pin and carry on.
sandboxes.events.on('unityRestart', (sb, r) => {
  const at = new Date().toLocaleTimeString();
  const text = r.gaveUp
    ? `automatic restart ${r.error ? `failed (${r.error})` : `stopped: ${cfg.unity.autoRestart.max} in ${cfg.unity.autoRestart.windowMinutes} min already`}; ${r.why}. Look at it, then restart it with the unity tool.`
    : `restarted at ${at} after ${r.why}`;
  const line = `[unity] ${sb.name} (${sb.id}): ${text}`;
  console.log(line);
  if (!r.gaveUp || r.error) notifier.host(`Unity in ${sb.name} ${r.gaveUp ? 'needs a person' : 'restarted'}`, text); // a give-up is also a 'blocked' notice
  const orch = store.orchestratorId;
  if (orch) {
    try {
      sessions.send(orch, line, 'system');
    } catch {
      // no orchestrator right now
    }
  }
  // A give-up needs a person: the people whose workers are there hear it in their own chats too.
  if (r.gaveUp) return void agents.orchestrators.toPeople(agents.orchestrators.peopleAt({ sandboxId: sb.id }), line);
  const deadline = Date.now() + 30 * 60_000;
  const tell = () => {
    const cur = store.sandboxes.get(sb.id);
    if (!cur || cur.unity.state === 'stopped' || cur.unity.state === 'crashed' || Date.now() > deadline) return;
    if (cur.unity.state !== 'running') return void setTimeout(tell, 15_000);
    const recent = Date.now() - 30 * 60_000;
    for (const s of store.sessions.values()) {
      if (s.sandboxId !== sb.id || s.kind === 'standing') continue;
      if (!['running', 'starting', 'waiting_permission'].includes(s.status) && Date.parse(s.lastActivityAt) < recent) continue;
      try {
        sessions.send(s.id, `Unity was restarted after a hang/crash at ${at} (${r.why}). It is up again: re-pin (mcpforunity://instances, then set_active_instance) and continue.`, 'system');
      } catch {
        // offline or at its limit: it sees the editor state on its next Unity call
      }
    }
  };
  setTimeout(tell, 15_000);
});

/** "beast/sb1" as this host's own daemon's sandbox, or undefined. */
const localRef = (id: string) => {
  const local = machines.local();
  const ref = local ? parseSandboxRef(id) : undefined;
  return ref && ref.machine === local!.id ? ref : undefined;
};
/** This host's own daemon's sandboxes as host records named "<machine>/<id>" (the host guard's view). */
const localSandboxView = () => {
  const local = machines.local();
  return local ? (local.sandboxes ?? []).map((x) => hostSandboxFrom(x, `${local.id}/${x.id}`)) : [];
};
/** The sessions as the host guard sees them: those of this host's own daemon's sandboxes as if they were this host's. */
const localSessionView = (): SessionInfo[] => {
  const local = machines.local();
  return [...store.sessions.values()].map((s) => {
    if (!local || s.machineId !== local.id || !s.machineSandbox) return s;
    const { machineId: _m, machineSandbox, ...rest } = s;
    return { ...rest, sandboxId: `${local.id}/${machineSandbox}` };
  });
};

// The host guard: disk space, the sandbox drive's self-recovery, RAM and idle editors (docs/self-recovery.md).
const cleanupEnv = { ...hostCleanupEnv(), sandboxRoots: [cfg.sandboxRoot] };
/** What clean-up never touches here: the sandbox root, the standing agents, the base clone, this app and its data, and the temp folders of agents running now. */
const hostCleanupGuard = () => ({
  keep: [...cfg.protectedPaths, cfg.sandboxRoot, cfg.standingRoot, cfg.repo.basePath, ROOT, cfg.dataDir, cfg.hostGuard.devDriveVhdx].filter(Boolean),
  // This host's agents, and those this host's own daemon runs (they get their temp folder under the same %TEMP%).
  inUse: [...sessions.sessions.values()].filter((s) => s.live && (!s.info.machineId || store.machines.get(s.info.machineId)?.local)).map((s) => sessionTempDir(os.tmpdir(), s.info.id)),
  home: cleanupEnv.home,
});
const hostHealth = new HostHealthMonitor({
  cfg,
  statfs: async (p) => {
    try {
      const s = await fs.promises.statfs(p);
      return { free: s.bavail * s.bsize, total: s.blocks * s.bsize };
    } catch {
      return undefined;
    }
  },
  exists: (p) => fs.existsSync(p),
  mem: () => ({ free: os.freemem(), total: os.totalmem() }),
  // Plus this host's own daemon's sandboxes as "<machine>/<id>" (docs/beast-machine.md): they are on this host's
  // sandbox drive and disks, so the guard brings their editors and agents back after the drive, and gates them.
  sandboxes: () => [...sandboxes.list(), ...localSandboxView()],
  sessions: () => localSessionView(),
  startEditor: async (id) => void (localRef(id) ? await machines.unity(localRef(id)!.machine, 'start', false, localRef(id)!.sandbox) : await sandboxes.startUnity(id)),
  stopEditor: async (id) => void (localRef(id) ? await machines.unity(localRef(id)!.machine, 'stop', false, localRef(id)!.sandbox) : await sandboxes.stopUnity(id)),
  interrupt: (id) => sessions.get(id).interrupt(),
  tell: (id, text) => void sessions.send(id, text, 'system', undefined, { bypassGate: true }),
  report: (title, body) => {
    console.log(`host guard: ${title}: ${body}`);
    notifier.host(title, body);
    const orch = store.orchestratorId;
    if (orch) {
      try {
        sessions.send(orch, `[host] ${title}. ${body}`, 'system');
      } catch {
        // the orchestrator is not there; the notification still went out
      }
    }
  },
  runHelper: (a) => runHelper(a),
  cleanup: {
    pass: async (low) => {
      const guard = hostCleanupGuard();
      const libraries = cfg.hostGuard.cleanup.libraryDeleteDays > 0 ? { roots: [cleanupEnv.home], deleteDays: cfg.hostGuard.cleanup.libraryDeleteDays } : undefined;
      const r = await runCleanup(await planCleanup({ rules: cleanupRules(cleanupEnv, cfg.hostGuard.cleanup), guard, low, libraries }), guard);
      for (const s of sandboxes.list().filter((x) => x.unity.logPath)) {
        for (const p of pruneEditorLogs(path.dirname(s.unity.logPath!), s.unity.logPath!)) r.removed.push({ path: p, bytes: 0, rule: 'editor-logs' });
      }
      return r;
    },
    consumers: () => biggestConsumers(cleanupEnv, [cfg.hostGuard.devDriveVhdx].filter(Boolean)),
    stale: async () => (await staleUnityLibraries([cleanupEnv.home], cfg.hostGuard.cleanup.libraryReportDays)).filter((l) => !neverDelete(l.path, hostCleanupGuard())),
    log: (e) => appendCleanupLog(cfg.dataDir, e),
    diskPaths: () => [cleanupEnv.home, cleanupEnv.tmp],
  },
  reap: (hours) => reapBrowsers(hours),
  changed: (h) => {
    host.health = h;
    broadcast({ type: 'host', host: { ...host, drain: drainer.status } });
  },
  log: (line) => console.warn(line),
});
sandboxes.startGate = () => hostHealth.blockReason('editor');
machines.localGate = (kind) => hostHealth.blockReason(kind);
sessions.startGate = () => hostHealth.blockReason('agent');
agents.standing.hostGate = () => hostHealth.blockReason('agent');
agents.hostHealth = hostHealth;
agents.providers = providers;
agents.max = max;
// The intake (docs/intake.md): Discord and FFBox into the work ledger. Everything in it is off unless config intake
// switches it on; the hooks below only record what already arrives while it is off.
const intake = new IntakeManager({ cfg, store, identity, orchestrators: agents.orchestrators, discord: max, pushBoard: (ref, answer) => providers.pushBoard(ref, answer) }).start();
max.onEvent = (ev) => intake.onMaxEvent(ev);
providers.onConversation = (c) => intake.onConversation(c);
providers.onRequest = (m) => intake.onRequest(m);
providers.onBoardCheck = (m) => intake.onBoardCheck(m);
providers.portalAccepts = () => intake.portalAccepts();
providers.onWorkReply = (m) => intake.onWorkReply(m);
providers.onResult = (m) => intake.onResult(m);
agents.orchestrators.onIntakeAttention = (w, what) => notifier.intake(w, what, (what === 'design' && w.flag ? w.flag.for : agents.orchestrators.reviewers()).map((r) => r.userId));
if (cfg.hostGuard.pollSeconds > 0) {
  setInterval(() => void hostHealth.tick(), cfg.hostGuard.pollSeconds * 1000);
  setTimeout(() => void hostHealth.tick(), 5000);
}
if (!auth.hasUsers()) console.warn('No users yet. Create one on this machine: node server/user.ts <username>');
sandboxes.reconcile();
const cutOff = agents.boot();

let lastSystem: SystemStats | undefined;

/** The app as `user` (a login name) sees it: their own orchestrator is the home chat (made on first sight). */
function appState(user: string | undefined): AppState {
  const u = auth.userInfo(user);
  const me = u ?? { ...identity.owner(), role: 'owner' as const };
  const mine = agents.orchestrators.personalFor(me);
  return {
    app: appNow(),
    sandboxes: sandboxes.list(),
    sessions: [...store.sessions.values()],
    standingAgents: agents.standing.list(),
    delegations: [...store.delegations.values()],
    machines: machines.list(),
    providers: providers.enabled || providers.summary().tokenSet ? [providers.summary()] : [],
    ffbox: providers.summary(),
    max: max.summary(),
    system: lastSystem,
    host: { ...host, drain: drainer.status },
    usage: usage.usage,
    accounts: accountsNow(),
    machineStats: machines.allStats(),
    orchestratorId: mine.info.id,
    dispatcherId: agents.dispatcherId,
    me,
    work: agents.orchestrators.forPage(),
    intake: intake.summary(),
    config: { defaultModel: cfg.defaultModel, models: cfg.models, defaultBase: cfg.defaultBase, attachments: attachments.settings },
    settings: store.settings,
  };
}

// ------------------------------------------------------------------ http helpers

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function send(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const json = JSON.stringify(body ?? {});
  // Gzipped when big (server/compress.ts): /api/state at thousands of sessions is megabytes.
  void endMaybeGzip(res.req, res, status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers }, json);
}

async function readJson<T>(req: http.IncomingMessage, maxBytes = 2 * 1024 * 1024): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > maxBytes) throw new HttpError(413, 'body too large');
    chunks.push(c);
  }
  if (!chunks.length) return {} as T;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
  } catch {
    throw new HttpError(400, 'invalid JSON');
  }
}

const need = (v: unknown, name: string) => {
  if (typeof v !== 'string' || !v.trim()) throw new HttpError(400, `"${name}" is required`);
  return v;
};

// ------------------------------------------------------------------ routes

type Handler = (req: http.IncomingMessage, params: string[], url: URL) => Promise<unknown>;
const routes: [string, RegExp, Handler][] = [];
const route = (method: string, pattern: string, h: Handler) => routes.push([method, new RegExp(`^${pattern}$`), h]);

route('GET', '/api/state', async (req) => appState(auth.user(req)));
route('GET', '/api/me', async (req) => {
  const u = auth.userInfo(auth.user(req));
  return { username: auth.user(req), ...(u ?? {}) };
});

// ---- providers (docs/ffbox-integration.md): what FFBox's connector reported, newest first
route('GET', '/api/providers/ffbox/conversations', async (_r, _m, url) => providers.conversations(Number(url.searchParams.get('limit')) || 100));
route('GET', '/api/providers/ffbox/intake', async (_r, _m, url) => providers.intake(Number(url.searchParams.get('limit')) || 200));
// Grouped by coarse signature, with the numbers automatic investigations will be capped by (shared/intake.ts).
route('GET', '/api/providers/ffbox/signatures', async () => groupIntake(providers.intake(2000), Date.now()));

// ---- Max (docs/max.md): what agents did as Max, the token's health, and a read-only look at a few channels
route('GET', '/api/max/activity', async (_r, _m, url) => max.activity(Number(url.searchParams.get('limit')) || 100));
route('GET', '/api/max/inbound', async () => max.inbound());
route('POST', '/api/max/inbound/([\\w-]+)/seen', async (_r, [alias]) => {
  try {
    max.markSeen(alias);
  } catch (e) {
    throw new HttpError(404, (e as Error).message);
  }
  return { ok: true };
});
route('POST', '/api/max/refresh', async () => max.refresh());

// ---- the intake (docs/intake.md): Discord and FFBox requests in the ledger; a person approves or declines them
route('GET', '/api/intake', async () => intake.summary());
route('POST', '/api/intake/poll', async () => intake.checkNow());
route('POST', '/api/work/(w[0-9]+)/approve', async (req, [id]) => {
  const w = agents.orchestrators.approveIntake(id, requesterOf(req));
  return { id: w.id, status: w.status, approval: w.approval };
});
route('POST', '/api/work/(w[0-9]+)/decline', async (req, [id]) => {
  const b = await readJson<{ note?: string }>(req);
  const w = agents.orchestrators.declineIntake(id, requesterOf(req), typeof b.note === 'string' ? b.note.slice(0, 300) : undefined);
  return { id: w.id, status: w.status, approval: w.approval };
});
// The usage meters' Refresh: poll every account now, here and on each connected machine (docs/accounts.md).
route('POST', '/api/usage/refresh', async () => ({ started: usage.refreshNow(), machines: machines.requestUsage() }));

route('GET', '/api/sessions/([\\w-]+)/events', async (_r, [id], url) => {
  sessions.get(id);
  // from=<seq>: everything from there on (a search hit older than the usual last 500).
  const from = Number(url.searchParams.get('from'));
  if (from > 0) return store.readTranscriptFrom(id, from);
  return store.readTranscript(id, Number(url.searchParams.get('limit')) || 500);
});

// ---- transcript search (server/search.ts)

route('GET', '/api/search', async (_r, _p, url) => {
  const q = url.searchParams;
  return agents.search({
    query: need(q.get('q'), 'q'),
    sandbox: q.get('sandbox') || undefined,
    machine: q.get('machine') || undefined,
    agent: q.get('agent') || undefined,
    since: q.get('since') || undefined,
    until: q.get('until') || undefined,
    limit: Number(q.get('limit')) || undefined,
  });
});

route('POST', '/api/sessions/([\\w-]+)/message', async (req, [id]) => {
  // Images come base64 in the JSON (the UI shrinks them first), so this body may be large.
  const { text, images, attachments: attachmentIds } = await readJson<SendMessageRequest>(req, 40 * 1024 * 1024);
  const imgs = checkImages(images);
  // Other files were uploaded first (POST /api/attachments): the message names them by id (docs/attachments.md).
  const files = attachments.resolve(attachmentIds);
  const s = sessions.get(id);
  // A standing agent only works inside a run (budget, no overlap, agent limit): a message starts one.
  if (s.info.kind === 'standing' && s.info.standingId) {
    if (imgs.length) throw new HttpError(400, 'standing agents take text only; describe the image or put it in their folder');
    if (files.length) throw new HttpError(400, 'standing agents take text only; attach the file in an orchestrator or worker chat');
    return { note: agents.standing.runNow(s.info.standingId, 'message', need(text, 'text'), requesterOf(req)) };
  }
  if (!imgs.length && !files.length) need(text, 'text');
  mayDrive(req, s.info);
  if (s.info.kind === 'orchestrator') {
    // A person wrote to their orchestrator: its own wake_me check-in is moot, and its budgets start again.
    agents.waker.cancel(id);
    agents.orchestrators.personWrote(id);
  }
  await agents.sendWithAttachments(id, String(text ?? '').trim(), 'human', { images: imgs, attachments: files, requestedBy: requesterOf(req) });
  return {};
});

// A person opened their own chat: the messages other people sent them there are read (docs/orchestrators.md).
route('POST', '/api/sessions/([\\w-]+)/seen', async (req, [id]) => {
  const s = sessions.get(id);
  mayDrive(req, s.info);
  agents.orchestrators.seen(id);
  return {};
});

/** Validate images sent with a message. */
function checkImages(images: unknown): ImageInput[] {
  if (images === undefined) return [];
  if (!Array.isArray(images) || images.length > 8) throw new HttpError(400, 'images: at most 8 per message');
  return images.map((i) => {
    const mediaType = String((i as ImageInput)?.mediaType ?? '');
    const data = String((i as ImageInput)?.data ?? '');
    if (!IMAGE_TYPES.includes(mediaType)) throw new HttpError(400, `images: ${mediaType || 'unknown type'} is not PNG, JPEG, GIF or WebP`);
    if (!data || data.length > 14_000_000 || !/^[A-Za-z0-9+/=\s]+$/.test(data.slice(0, 200))) throw new HttpError(400, 'images: each must be base64 and under ~10 MB');
    return { mediaType, data: data.replace(/\s/g, '') };
  });
}

// ---- images: kept uploads, files agents mention, the Screenshots galleries

/** A route may return a file instead of JSON. */
/** A file streamed to the client, honouring an HTTP Range request (videos: seeking, and iPad Safari). */
class StreamReply {
  readonly type: string;
  readonly path: string;
  readonly size: number;
  /** A download (an attachment): saved under this Content-Disposition, never shown. */
  readonly disposition?: string;
  constructor(type: string, file: string, size: number, disposition?: string) {
    this.type = type;
    this.path = file;
    this.size = size;
    this.disposition = disposition;
  }
}

/** Served files are never pages: an SVG opened on its own runs nothing and loads nothing, in an origin of its own. */
const FILE_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox";

class FileReply {
  readonly type: string;
  readonly data: Buffer;
  constructor(type: string, data: Buffer) {
    this.type = type;
    this.data = data;
  }
}

// ---- attachments (docs/attachments.md): files people attach to messages, uploaded in chunks that resume

route('POST', '/api/attachments', async (req) => {
  const b = await readJson<{ name?: unknown; size?: unknown }>(req);
  return attachments.begin({ name: b.name, size: b.size, uploadedBy: auth.user(req) });
});
route('GET', '/api/attachments/uploads/([a-f0-9]{32})', async (_r, [uploadId]) => attachments.status(uploadId));
// A chunk is raw bytes (application/octet-stream with the x-ff-upload header, which the CSRF check lets through).
route('PUT', '/api/attachments/uploads/([a-f0-9]{32})', async (req, [uploadId], url) => {
  const length = req.headers['content-length'];
  const r = await attachments.append(uploadId, Number(url.searchParams.get('offset')), req, undefined, length === undefined ? undefined : Number(length));
  return { received: r.received, size: r.size, ...(r.attachment ? { attachment: publicRef(r.attachment) } : {}) };
});
route('DELETE', '/api/attachments/uploads/([a-f0-9]{32})', async (_r, [uploadId]) => {
  attachments.cancel(uploadId);
  return {};
});
route('GET', '/api/attachments/(att_[a-z0-9]{12})', async (_r, [id]) => {
  const [a] = attachments.resolve([id]);
  return { ...publicRef(a), createdAt: a.createdAt, lastUsedAt: a.lastUsedAt, ...(a.uploadedBy ? { uploadedBy: a.uploadedBy } : {}) };
});
// Always a download, as bytes: never shown in the page (an HTML or SVG file must not run here).
route('GET', '/api/attachments/(att_[a-z0-9]{12})/download', async (_r, [id]) => {
  const [a] = attachments.resolve([id]);
  return new StreamReply('application/octet-stream', attachments.pathOf(a), a.size, downloadDisposition(a.name));
});

route('GET', '/api/uploads/([\\w-]+)/([\\w-]+)', async (_r, [sessionId, imageId]) => {
  const f = store.imagePath(sessionId, imageId);
  if (!f) throw new HttpError(404, 'no such image');
  return new FileReply(MEDIA_TYPE[f.split('.').pop()!] ?? 'application/octet-stream', fs.readFileSync(f));
});

/**
 * Where a session, sandbox or machine may show images from. `machine` means: ask that machine's daemon
 * (`session`: for that session, whose own temp folder it adds).
 */
type ImageRoots = { machine?: string; session?: string; roots: string[] };
function imageRoots(url: URL, file?: string): ImageRoots {
  const sessionId = url.searchParams.get('session');
  const sandboxId = url.searchParams.get('sandbox');
  const machineId = url.searchParams.get('machine');
  if (sandboxId) return { roots: [sandboxes.require(sandboxId).path] };
  if (machineId) return { machine: machines.require(machineId).id, roots: [] };
  if (!sessionId) throw new HttpError(400, 'give session, sandbox or machine');
  return sessionImageRoots(sessionId, file);
}

/**
 * A session's folders: its sandbox or standing agent folder and its own temp folder. The orchestrator oversees
 * everything: the base clone, every sandbox and standing agent folder, and (for a path under a machine's clone or
 * home) that machine's own folders, which its daemon checks.
 */
function sessionImageRoots(sessionId: string, file?: string): ImageRoots {
  const s = sessions.get(sessionId).info;
  if (s.machineId) return { machine: s.machineId, session: s.id, roots: [] };
  const temp = sessionTempDir(os.tmpdir(), s.id);
  if (s.sandboxId) return { roots: [sandboxes.require(s.sandboxId).path, temp] };
  if (s.standingId) return { roots: [agents.standing.require(s.standingId).folder, temp] };
  if (s.kind === 'orchestrator') {
    const onMachine = file ? machineForPath(file, machines.list()) : undefined;
    if (onMachine) return { machine: onMachine.id, roots: [] };
    return { roots: [cfg.repo.basePath, cfg.sandboxRoot, cfg.standingRoot] };
  }
  throw new HttpError(404, 'no folder for this session');
}

const readImageIn = (where: ImageRoots, file: string) => (where.machine ? machines.readImage(where.machine, file, where.session) : Promise.resolve(readImage(file, where.roots)));

route('GET', '/api/image', async (_r, _p, url) => {
  const file = need(url.searchParams.get('path'), 'path');
  const where = imageRoots(url, file);
  try {
    if (VIDEO_FILE.test(file)) {
      if (where.machine) throw new Error('videos on a machine cannot be shown yet');
      const v = openVideo(file, where.roots);
      return new StreamReply(v.mediaType, v.path, v.size);
    }
    const img = await readImageIn(where, file);
    return new FileReply(img.mediaType, img.data);
  } catch (e) {
    throw new HttpError(404, (e as Error).message);
  }
});

route('GET', '/api/screenshots', async (_r, _p, url) => {
  const where = imageRoots(url);
  if (where.machine) return machines.listImages(where.machine, cfg.screenshotDirs);
  return listImages(where.roots[0], cfg.screenshotDirs, 120, { videos: true });
});

route('POST', '/api/sessions/([\\w-]+)/title', async (req, [id]) => {
  const { title } = await readJson<{ title?: string }>(req);
  const s = sessions.get(id);
  if (s.info.kind === 'standing') throw new HttpError(400, "a standing agent's conversation carries the agent's name; rename the agent instead");
  if (s.info.kind === 'orchestrator') throw new HttpError(400, "an orchestrator's name is its person's (or Dispatcher)");
  return { title: sessions.setTitle(id, need(title, 'title')) };
});

route('POST', '/api/sessions/([\\w-]+)/interrupt', async (req, [id]) => {
  const s = sessions.get(id);
  mayDrive(req, s.info);
  await s.interrupt();
  return {};
});

route('POST', '/api/sessions/([\\w-]+)/permission', async (req, [id]) => {
  const b = await readJson<PermissionDecisionRequest>(req);
  const s = sessions.get(id);
  mayDrive(req, s.info);
  if (!s.decide(need(b.requestId, 'requestId'), !!b.allow, b.message)) throw new HttpError(404, 'no such pending request');
  return {};
});

route('POST', '/api/sessions/([\\w-]+)/mode', async (req, [id]) => {
  const { mode } = await readJson<{ mode: string }>(req);
  if (!['default', 'acceptEdits', 'bypassPermissions', 'plan', 'auto'].includes(mode)) throw new HttpError(400, 'bad mode');
  const s = sessions.get(id);
  mayDrive(req, s.info);
  await s.setMode(mode as never);
  return {};
});

route('POST', '/api/sessions', async (req) => {
  const b = await readJson<StartSessionRequest>(req);
  const s = agents.startWorker({
    sandbox: b.sandboxId || undefined,
    machine: b.machineId || undefined,
    prompt: need(b.prompt, 'prompt'),
    title: b.title,
    model: b.model,
    permissionMode: b.permissionMode,
    effort: b.effort,
    from: 'human',
    requestedBy: requesterOf(req),
  });
  // Started from the dashboard: in the ledger too, so it shows all work in flight (docs/intake.md, "One place").
  if (s.info.status !== 'error') {
    const by = requesterOf(req);
    const where = s.info.machineSandbox ? `in ${s.info.machineId}/${s.info.machineSandbox}` : s.info.machineId ? `on ${s.info.machineId}` : `in ${s.info.sandboxId}`;
    agents.orchestrators.recordStart(s.info, b.prompt, by, `started by ${by.displayName} from the dashboard: worker ${s.info.id} ${where}`, true);
  }
  return s.info;
});

route('DELETE', '/api/sessions/([\\w-]+)', async (_r, [id]) => {
  const s = sessions.get(id);
  if (s.info.kind === 'orchestrator') throw new HttpError(400, 'reset the orchestrator instead');
  if (s.info.kind === 'standing') throw new HttpError(400, "this is a standing agent's conversation; delete the agent instead");
  const sb = s.info.sandboxId ? store.sandboxes.get(s.info.sandboxId) : undefined;
  sessions.remove(id);
  if (sb) {
    sb.sessionIds = sb.sessionIds.filter((x) => x !== id);
    store.putSandbox(sb);
  }
  return {};
});

/** A fresh conversation: your own orchestrator's (the default), or the dispatcher's (an owner only). */
route('POST', '/api/orchestrator/reset', async (req) => {
  const { which } = await readJson<{ which?: 'mine' | 'dispatcher' }>(req);
  const me = requesterOf(req);
  let id: string;
  if (which === 'dispatcher') {
    if (identity.get(me.userId)?.role !== 'owner') throw new HttpError(403, 'only the owner resets the dispatcher');
    id = agents.newDispatcher().info.id;
  } else id = agents.orchestrators.resetPersonal(me).info.id;
  // Each page has its own home chat, so each gets its own state.
  for (const [c, user] of clients) if (c.readyState === c.OPEN) c.send(JSON.stringify({ type: 'state', state: appState(user) } satisfies ServerEvent));
  return { id };
});

route('POST', '/api/sandboxes', async (req) => {
  const b = await readJson<CreateSandboxRequest>(req);
  need(b.name, 'name');
  // Once this host's own daemon holds its sandboxes, a new one is made there (docs/beast-machine.md).
  const on = agents.defaultSandboxMachine();
  if (on) {
    const note = await machines.createSandbox(on, b);
    return { machine: on, id: slugify(b.name), note };
  }
  return sandboxes.create(b);
});

route('DELETE', '/api/sandboxes/([\\w-]+)', async (_r, [id]) => {
  const sb = sandboxes.require(id);
  for (const sid of sb.sessionIds) if (sessions.sessions.has(sid)) sessions.remove(sid);
  void sandboxes.remove(id).catch((e) => console.error(`delete ${id}:`, e));
  return {};
});

route('POST', '/api/sandboxes/([\\w-]+)/unity', async (req, [id]) => {
  const { action } = await readJson<{ action: string }>(req);
  if (action === 'start') return sandboxes.startUnity(id);
  if (action === 'stop') return sandboxes.stopUnity(id);
  throw new HttpError(400, 'action must be start or stop');
});

route('GET', '/api/sandboxes/([\\w-]+)/unity-log', async (_r, [id], url) => ({
  lines: sandboxes.unityLog(id, Math.min(5000, Number(url.searchParams.get('lines')) || 200)),
}));

// ---- standing agents (docs/standing-agents.md)

route('POST', '/api/standing', async (req) => agents.standing.create(await readJson<StandingAgentInput>(req)));

route('POST', '/api/standing/([\\w-]+)', async (req, [id]) => agents.standing.update(id, await readJson<Partial<StandingAgentInput>>(req)));

route('DELETE', '/api/standing/([\\w-]+)', async (_r, [id]) => {
  agents.standing.remove(id);
  return {};
});

route('POST', '/api/standing/([\\w-]+)/(run|stop|pause|resume)', async (req, [id, action]) => {
  const st = agents.standing;
  if (action === 'run') return { note: st.runNow(id, 'manual', undefined, requesterOf(req)) };
  if (action === 'stop') return { note: st.stop(id) };
  return action === 'pause' ? st.pause(id) : st.resume(id);
});

route('POST', '/api/delegations/([\\w-]+)/(approve|reject)', async (req, [id, action]) => {
  if (action === 'approve') return agents.standing.approveDelegation(id, { approvedBy: requesterOf(req) });
  const { note } = await readJson<{ note?: string }>(req);
  return agents.standing.rejectDelegation(id, note);
});

// ---- notifications (server/notify.ts)

route('GET', '/api/push', async (req) => ({ publicKey: notifier.publicKey, subscriptions: notifier.list(auth.user(req)!) }));

route('POST', '/api/push/subscribe', async (req) => {
  const b = await readJson<{ subscription?: { endpoint?: string; keys?: { p256dh?: string; auth?: string } }; prefs?: Partial<NotifyPrefs> }>(req);
  return { prefs: notifier.subscribe(auth.user(req)!, b.subscription ?? {}, b.prefs, deviceName(String(req.headers['user-agent'] ?? ''))) };
});

route('POST', '/api/push/prefs', async (req) => {
  const b = await readJson<{ endpoint?: string; prefs?: Partial<NotifyPrefs> }>(req);
  return { prefs: notifier.setPrefs(need(b.endpoint, 'endpoint'), b.prefs ?? {}) };
});

route('POST', '/api/push/unsubscribe', async (req) => {
  const b = await readJson<{ endpoint?: string }>(req);
  notifier.unsubscribe(need(b.endpoint, 'endpoint'));
  return {};
});

route('POST', '/api/push/test', async (req) => {
  const b = await readJson<{ endpoint?: string }>(req);
  return { delivered: await notifier.test(auth.user(req)!, b.endpoint) };
});

/** "iPhone", "Android", "Mac", "Windows" + browser: enough to tell devices apart in the list. */
function deviceName(ua: string) {
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : 'Linux';
  const br = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'browser';
  return `${br} on ${os}`;
}

// ---- settings (heartbeat) and wake-ups (server/wake.ts)

/** heartbeatMinutes: the signed-in person's own heartbeat (docs/orchestrators.md). */
route('POST', '/api/settings', async (req) => {
  const b = await readJson<{ heartbeatMinutes?: number | null }>(req);
  const m = b.heartbeatMinutes;
  if (m !== undefined && m !== null && (!Number.isInteger(m) || m < 5 || m > 240)) throw new HttpError(400, 'heartbeatMinutes: 5 to 240, or null for off');
  if (m !== undefined) agents.setHeartbeat(requesterOf(req).userId, m);
  return store.settings;
});

// Each person's heartbeat wakes their own orchestrator, with their own busy workers.
setInterval(() => {
  const describe = (s: SessionInfo) => describeBusy(s, { sandbox: s.sandboxId ? store.sandboxes.get(s.sandboxId) : undefined, machine: s.machineId });
  for (const [userId, minutes] of Object.entries(store.settings.heartbeat ?? {})) {
    const chat = agents.orchestrators.personalOf(userId);
    if (!chat) continue;
    agents.waker.heartbeat(chat.info.id, minutes, describe, (s) => agents.orchestrators.audienceOf(s).some((r) => r.userId.toLowerCase() === userId.toLowerCase()), () => agents.orchestrators.intakeLine(userId));
  }
}, 60_000);

// ---- switch_branch (server/switchBranch.ts)

route('POST', '/api/(sandboxes|machines)/([\\w-]+)/switch-branch', async (req, [kind, id]) => {
  const b = await readJson<{ branch?: string; createFrom?: string }>(req);
  const target = kind === 'sandboxes' ? { sandbox: id } : { machine: id };
  return { note: await agents.switchBranch({ ...target, branch: need(b.branch, 'branch').trim(), createFrom: b.createFrom?.trim() || undefined }) };
});

// ---- a machine sandbox's page (docs/machines.md, "Machine sandboxes"): its editor, its log, its branch

route('POST', '/api/machines/([\\w-]+)/sandboxes/([\\w-]+)/unity', async (req, [id, sb]) => {
  const { action } = await readJson<{ action?: string }>(req);
  if (action !== 'start' && action !== 'stop') throw new HttpError(400, 'action must be start or stop');
  return { note: await machines.unity(id, action, false, sb) };
});

route('GET', '/api/machines/([\\w-]+)/sandboxes/([\\w-]+)/unity-log', async (_r, [id, sb], url) => ({
  lines: (await machines.sandboxLog(id, sb, Math.min(5000, Number(url.searchParams.get('lines')) || 200))).split('\n'),
}));

route('POST', '/api/machines/([\\w-]+)/sandboxes/([\\w-]+)/switch-branch', async (req, [id, sb]) => {
  const b = await readJson<{ branch?: string; createFrom?: string }>(req);
  return { note: await agents.switchBranch({ machine: id, sandbox: sb, branch: need(b.branch, 'branch').trim(), createFrom: b.createFrom?.trim() || undefined }) };
});

// ---- machines (docs/machines.md)

route('POST', '/api/machines', async (req) => {
  const b = await readJson<{ id?: string; host?: string; portalUrl?: string; repoPath?: string; maxSessions?: number; appDir?: string; unityEditorRoot?: string; unityPath?: string; tempDir?: string } & Pick<Machine, 'sandboxRoot' | 'maxSandboxes' | 'maxAgentsPerSandbox' | 'maxUnity' | 'diskWarnGB' | 'diskCriticalGB'>>(req);
  return machines.deployMachine({
    id: need(b.id, 'id'),
    host: b.host,
    portalUrl: b.portalUrl,
    repoPath: b.repoPath || undefined,
    maxSessions: b.maxSessions,
    appDir: b.appDir,
    unityEditorRoot: b.unityEditorRoot,
    unityPath: b.unityPath,
    tempDir: b.tempDir,
    sandboxRoot: b.sandboxRoot,
    maxSandboxes: b.maxSandboxes,
    maxAgentsPerSandbox: b.maxAgentsPerSandbox,
    maxUnity: b.maxUnity,
    diskWarnGB: b.diskWarnGB,
    diskCriticalGB: b.diskCriticalGB,
  });
});

route('POST', '/api/machines/([\\w-]+)/redeploy', async (req, [id]) => {
  const b = await readJson<{ force?: boolean }>(req);
  return machines.deployMachine({ id, force: !!b.force });
});

route('POST', '/api/machines/([\\w-]+)/daemon', async (req, [id]) => {
  const b = await readJson<{ action?: string; force?: boolean }>(req);
  if (b.action !== 'start' && b.action !== 'stop' && b.action !== 'restart') throw new HttpError(400, 'action must be start, stop or restart');
  return { note: await machines.controlDaemon(id, b.action, !!b.force) };
});

route('POST', '/api/machines/([\\w-]+)/label', async (req, [id]) => {
  const { purpose } = await readJson<{ purpose?: string }>(req);
  return machines.setPurpose(id, need(purpose, 'purpose'));
});

route('DELETE', '/api/machines/([\\w-]+)', async (_r, [id]) => ({ note: await machines.removeMachine(id) }));

// ---- voice input (server/voice.ts, docs/voice.md)

const voice = new VoiceService(cfg, () => buildVoicePrompt(vocabulary()));
voice.autoInstall();

let specCache: { at: number; names: string[] } | undefined;
/** Names Whisper should know, from the current state: sandboxes, machines, agents, recent specs. */
function vocabulary(): VocabularySource {
  if (!specCache || Date.now() - specCache.at > 10 * 60_000) {
    let names: string[] = [];
    try {
      names = fs.readdirSync(path.join(cfg.repo.basePath, 'specs'));
    } catch {
      /* no base clone yet */
    }
    specCache = { at: Date.now(), names };
  }
  const recent = [...store.sessions.values()]
    .filter((s) => s.kind !== 'orchestrator' && s.kind !== 'standing')
    .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))
    .slice(0, 12);
  return {
    sandboxes: sandboxes.list(),
    machines: machines.list().map((m) => m.id),
    agentNames: [...agents.standing.list().map((a) => a.name), ...recent.map((s) => s.title)],
    specs: specCache.names,
    extra: cfg.voice.vocabulary,
  };
}

route('GET', '/api/voice', async () => voice.status());
// Recording started: load the model now, so it is ready when the clip arrives. Voice mode also
// warms text-to-speech ({ tts: true }): a reply will be read.
route('POST', '/api/voice/warm', async (req) => {
  const { tts } = await readJson<{ tts?: boolean }>(req);
  return voice.warm({ tts: !!tts });
});
route('POST', '/api/voice/install', async () => {
  void voice.install();
  return voice.status();
});
route('POST', '/api/voice/transcribe', async (req) => {
  // 16 kHz 16-bit mono is 32 KB/s; base64 adds a third.
  const { audio } = await readJson<TranscribeRequest>(req, Math.ceil(((MAX_DICTATION_SECONDS + 10) * 32_000 * 4) / 3) + 1024);
  const wav = Buffer.from(need(audio, 'audio'), 'base64');
  const seconds = wavSeconds(wav);
  if (seconds === undefined) throw new HttpError(400, 'audio: expected a 16-bit PCM WAV');
  if (seconds > MAX_DICTATION_SECONDS + 5) throw new HttpError(413, `audio: at most ${MAX_DICTATION_SECONDS} s`);
  try {
    return await voice.transcribe(wav);
  } catch (e) {
    throw new HttpError(503, (e as Error).message);
  }
});
// Voice mode reads replies aloud: text -> WAV, a sentence or a few at a time.
route('POST', '/api/voice/tts', async (req) => {
  const { text, voice: v, speed } = await readJson<SpeakRequest>(req);
  const t = need(text, 'text').trim();
  if (t.length > MAX_TTS_CHARS) throw new HttpError(413, `text: at most ${MAX_TTS_CHARS} characters`);
  if (v !== undefined && !/^[a-z]{2}_[a-z]+$/.test(v)) throw new HttpError(400, 'voice: a Kokoro voice name like af_heart');
  const sp = speed === undefined ? 1 : Number(speed);
  if (!(sp >= 0.5 && sp <= 2)) throw new HttpError(400, 'speed: 0.5 to 2');
  try {
    const r = await voice.speak(t, v, sp);
    return new FileReply('audio/wav', r.wav);
  } catch (e) {
    throw new HttpError(503, (e as Error).message);
  }
});

// ------------------------------------------------------------------ server

/** Parse a request path without ever throwing (a raw "//" or "//x:99999" request line makes WHATWG URL throw). */
function parseUrl(raw: string | undefined): URL | undefined {
  try {
    return new URL(raw ?? '/', 'http://x');
  } catch {
    return undefined;
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = parseUrl(req.url);
    if (!url) return send(res, 400, { error: 'bad request' });
    if (url.pathname === '/mcp') {
      // Machine clients authenticate with an API key, not a browser session; no cookies, so no CSRF.
      const who = auth.bearer(req);
      if (!who.ok) return send(res, who.status, { error: who.status === 429 ? 'too many failures' : 'API key required' });
      if (who.scope) return send(res, 403, { error: `this key is for ${who.scope} reports only` });
      // A key bound to a login acts for that person; an unbound one (made before keys had users) for the owner.
      const keyUser = auth.userInfo(who.user);
      return await handleMcp(agents, who.name, keyUser ? asRequester(keyUser) : identity.owner(), req, res, req.method === 'POST' ? await readJson(req) : undefined);
    }
    if (url.pathname.startsWith('/api/') && req.method !== 'GET') {
      // CSRF: a cross-site form cannot send application/json, and SameSite=Strict keeps the cookie home. An attachment
      // chunk is raw bytes instead, with a custom header that no cross-site form or simple request can carry.
      const chunk = req.method === 'PUT' && url.pathname.startsWith('/api/attachments/uploads/');
      if (chunk) {
        if (req.headers['x-ff-upload'] !== '1' || !String(req.headers['content-type'] ?? '').startsWith('application/octet-stream')) {
          return send(res, 415, { error: 'an attachment chunk is application/octet-stream with x-ff-upload: 1' });
        }
      } else if (req.method !== 'DELETE' && !String(req.headers['content-type'] ?? '').startsWith('application/json')) {
        return send(res, 415, { error: 'JSON only' });
      }
    }
    // A machine's daemon fetching an attachment it was handed (docs/attachments.md): its own token, no browser session.
    const machineFile = req.method === 'GET' ? /^\/machine\/attachments\/(att_[a-z0-9]{12})$/.exec(url.pathname) : null;
    if (machineFile) {
      const machineId = machines.authenticate(req.headers.authorization);
      const r = machineAttachment(attachments, machineId && store.machines.has(machineId) ? machineId : undefined, machineFile[1]);
      if ('error' in r) return send(res, r.status, { error: r.error });
      return sendStream(req, res, new StreamReply('application/octet-stream', r.file, r.record.size, downloadDisposition(r.record.name)));
    }
    // The nightly e2e lab's report (docs/intake.md, "Nightly e2e regressions"): a key minted --scope nightly, nothing else.
    if (url.pathname === '/api/intake/nightly' && req.method === 'POST') {
      const who = auth.bearer(req);
      if (!who.ok) return send(res, who.status, { error: who.status === 429 ? 'too many failures' : 'API key required' });
      if (who.scope !== 'nightly') return send(res, 403, { error: 'a nightly-scoped key is required (node server/apikey.ts <name> --scope nightly)' });
      const parsed = parseNightlyReport(await readJson(req, 256 * 1024));
      if ('error' in parsed) return send(res, 400, { error: parsed.error });
      const results = intake.onNightly(parsed.report);
      if (!results) return send(res, 200, { enabled: false, note: 'the nightly intake is off (config intake.nightly.enabled)' });
      return send(res, 200, { enabled: true, results });
    }
    // Max's escalations from FFBox (docs/intake.md, "Escalations from Max"): a key minted --scope ffbox, nothing else.
    if (url.pathname === '/api/intake/ffbox' && req.method === 'POST') {
      const who = auth.bearer(req);
      if (!who.ok) return send(res, who.status, { error: who.status === 429 ? 'too many failures' : 'API key required' });
      if (who.scope !== 'ffbox') return send(res, 403, { error: 'an ffbox-scoped key is required (node server/apikey.ts <name> --scope ffbox)' });
      const parsed = parseEscalation(await readJson(req, 32 * 1024));
      if ('error' in parsed) return send(res, 400, { error: parsed.error });
      return send(res, 200, intake.onEscalation(parsed.escalation));
    }
    // Liveness and version, for scripts, monitors and the E2E harness. No login needed: the
    // version of an open-source app is public anyway.
    if (url.pathname === '/api/health' && req.method === 'GET') return send(res, 200, { ok: true, ...appNow() });
    if (url.pathname === '/api/login' && req.method === 'POST') {
      const { username, password } = await readJson<{ username?: string; password?: string }>(req);
      if (typeof username !== 'string' || typeof password !== 'string') return send(res, 400, { error: 'username and password required' });
      const r = await auth.login(req, username.trim(), password);
      return r.ok ? send(res, 200, { username: username.trim() }, { 'set-cookie': r.cookie }) : send(res, r.status, { error: r.error });
    }
    if (url.pathname === '/api/logout' && req.method === 'POST') {
      return send(res, 200, {}, { 'set-cookie': auth.logout(req) });
    }
    if (url.pathname.startsWith('/api/')) {
      if (!auth.user(req)) return send(res, 401, { error: 'login required' });
      for (const [method, re, h] of routes) {
        const m = req.method === method ? re.exec(url.pathname) : null;
        if (!m) continue;
        const out = await h(req, m.slice(1), url);
        if (out instanceof StreamReply) return sendStream(req, res, out);
        if (out instanceof FileReply) {
          res.writeHead(200, { 'content-type': out.type, 'cache-control': 'private, max-age=300', 'x-content-type-options': 'nosniff', 'content-security-policy': FILE_CSP });
          return res.end(out.data);
        }
        return send(res, 200, out);
      }
      return send(res, 404, { error: 'no such endpoint' });
    }
    await serveStatic(WEB, req, url, res);
  } catch (e) {
    const status = e instanceof HttpError || e instanceof AttachmentError ? e.status : /^no (sandbox|session|standing agent|delegation|machine)/.test((e as Error).message) ? 404 : 400;
    // An upload that must resume elsewhere says where (docs/attachments.md).
    send(res, status, { error: (e as Error).message, ...(e instanceof AttachmentError && e.received !== undefined ? { received: e.received } : {}) });
  }
});

// Big messages (the full state a page gets when it connects, megabytes at thousands of sessions) go compressed;
// the stream of small events does not pay for zlib. No context takeover: no zlib memory kept per page between messages.
const wss = new WebSocketServer({ noServer: true, perMessageDeflate: { threshold: 16 * 1024, serverNoContextTakeover: true, clientNoContextTakeover: true } });
/** Every page's socket, with the login it signed in as (notices meant for one person go to their pages only). */
const clients = new Map<WebSocket, string>();

server.on('upgrade', (req, socket, head) => {
  // Cross-site WebSocket hijacking: the page's own origin only. Compared as strings; parsing an
  // attacker-supplied Origin ("null", garbage) must never be able to throw.
  if (parseUrl(req.url)?.pathname === '/provider') {
    // FFBox's connector (docs/ffbox-connector-contract.md): its own token, no browser session.
    const fwd = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
    const peer = req.socket.remoteAddress ?? '';
    providers.upgrade(req, socket, head, cfg.trustProxy && /^(::1|127\.|::ffff:127\.)/.test(peer) && fwd ? fwd : peer);
    return;
  }
  if (parseUrl(req.url)?.pathname === '/machine') {
    // A machine daemon (docs/machines.md): its own token, no browser session.
    const fwd = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
    const peer = req.socket.remoteAddress ?? '';
    machines.upgrade(req, socket, head, cfg.trustProxy && /^(::1|127\.|::ffff:127\.)/.test(peer) && fwd ? fwd : peer);
    return;
  }
  const origin = req.headers.origin;
  const host = req.headers.host ?? '';
  const sameOrigin = !origin || origin === `https://${host}` || origin === `http://${host}`;
  if (parseUrl(req.url)?.pathname !== '/ws' || !auth.user(req) || !sameOrigin) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    return socket.destroy();
  }
  const user = auth.user(req)!;
  wss.handleUpgrade(req, socket, head, (ws) => {
    clients.set(ws, user);
    alive.add(ws);
    ws.on('pong', () => alive.add(ws));
    ws.on('close', () => clients.delete(ws));
    // A malformed frame (e.g. unmasked) emits 'error'; unhandled, that would kill the process.
    ws.on('error', (e) => {
      console.warn('websocket error:', e.message);
      clients.delete(ws);
    });
    ws.send(JSON.stringify({ type: 'state', state: appState(user) } satisfies ServerEvent));
  });
});

function sendStream(req: http.IncomingMessage, res: http.ServerResponse, f: StreamReply) {
  const headers = { 'content-type': f.type, 'accept-ranges': 'bytes', 'cache-control': 'private, max-age=300', 'x-content-type-options': 'nosniff', 'content-security-policy': FILE_CSP, ...(f.disposition ? { 'content-disposition': f.disposition } : {}) };
  const range = parseRange(req.headers.range, f.size);
  if (range === 'unsatisfiable') {
    res.writeHead(416, { ...headers, 'content-range': `bytes */${f.size}` });
    return res.end();
  }
  const { start, end } = range ?? { start: 0, end: f.size - 1 };
  res.writeHead(range ? 206 : 200, { ...headers, 'content-length': String(end - start + 1), ...(range ? { 'content-range': `bytes ${start}-${end}/${f.size}` } : {}) });
  if (f.size === 0) return res.end();
  const stream = fs.createReadStream(f.path, { start, end });
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

// Sockets die silently (a laptop asleep, a phone suspending the tab, a NAT or proxy dropping an idle
// connection): no close ever arrives, so neither side would notice. Every SOCKET_PING_MS the server
// drops the sockets that did not answer the last protocol ping, and sends each page a 'ping' event it
// can see (browsers hide protocol pings), so a page that hears nothing knows to reconnect and refetch.
const alive = new WeakSet<WebSocket>();
setInterval(() => {
  for (const c of clients.keys()) {
    if (!alive.has(c)) {
      clients.delete(c);
      c.terminate();
      continue;
    }
    alive.delete(c);
    c.ping();
  }
  broadcast({ type: 'ping' });
}, SOCKET_PING_MS);

function broadcast(e: ServerEvent) {
  const data = JSON.stringify(e);
  // A notice for some people only reaches their pages (docs/orchestrators.md: no interruptions).
  const only = e.type === 'notify' && e.users ? new Set(e.users.map((u) => u.toLowerCase())) : undefined;
  for (const [c, user] of clients) if (c.readyState === c.OPEN && (!only || only.has(user.toLowerCase()))) c.send(data);
}
bus.on('event', broadcast);
// A removed session's own temp folder goes with it (docs/self-recovery.md "Per-agent hygiene").
bus.on('event', (e: ServerEvent) => {
  if (e.type === 'session_removed') void fs.promises.rm(sessionTempDir(os.tmpdir(), e.id), { recursive: true, force: true, maxRetries: 2 }).catch(() => undefined);
});
// The images an agent's message shows are copied into the transcript's store as it arrives (server/inlineImages.ts).
bus.on('event', (e: ServerEvent) => {
  if (e.type !== 'transcript' || e.event.kind !== 'assistant' || e.event.images) return;
  const { sessionId, event } = e;
  void keepMessageImages(store, sessionId, event, (file) => readImageIn(sessionImageRoots(sessionId, file), file)).catch(() => undefined);
});

setInterval(() => sandboxes.poll(), 3000);

// ---- git status per sandbox (server/gitStatus.ts): a light timer, plus right after an agent turn there.

const refreshGit = (id: string) => refreshSandboxGit(store, id);
setInterval(() => {
  for (const id of store.sandboxes.keys()) void refreshGit(id);
}, 60_000);
setTimeout(() => {
  for (const id of store.sandboxes.keys()) void refreshGit(id);
}, 2000);
sessions.events.on('turnEnd', (s: SessionHandle) => {
  if (s.info.sandboxId) setTimeout(() => void refreshGit(s.info.sandboxId!), 1500);
  if (s.info.machineId) machines.refreshGit(s.info.machineId);
});
bus.on('event', (e) => {
  // A sandbox that just finished provisioning.
  if (e.type === 'sandbox' && e.sandbox.status === 'ready' && !e.sandbox.git) void refreshGit(e.sandbox.id);
});
setInterval(() => {
  try {
    agents.standing.tick();
  } catch (e) {
    console.error('standing agents tick:', e);
  }
}, 10_000);
async function refreshSystem() {
  try {
    lastSystem = await systemStats(cfg);
    broadcast({ type: 'system', system: lastSystem });
  } catch (e) {
    console.error('system stats:', e);
  }
}
void refreshSystem();
setInterval(refreshSystem, 5000);

wss.on('error', (e) => console.warn('websocket server error:', e.message));
server.on('clientError', (_e, socket) => socket.destroy());
// Failing to listen (port taken) is fatal, not something to "keep running" through: exit, and let
// the supervisor retry, instead of idling as a server that serves nothing.
server.on('error', (e) => {
  console.error('server error, exiting:', e);
  process.exit(1);
});

// Last line of defence: one bad request or a transient file lock must not take down every running
// agent. Log it loudly and keep serving.
process.on('uncaughtException', (e) => console.error('UNCAUGHT (kept running):', e));
process.on('unhandledRejection', (e) => console.error('UNHANDLED REJECTION (kept running):', e));

server.listen(cfg.port, cfg.host, () => {
  console.log(`SketchUp Factory ${formatVersion(appVersion())} on http://${cfg.host}:${cfg.port} — sandboxes in ${cfg.sandboxRoot}, base clone ${cfg.repo.basePath}`);
});

/** This app's git HEAD, to tell the orchestrator what an update or restart changed. */
function appHead(): string | undefined {
  try {
    return execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 }).trim() || undefined;
  } catch {
    return undefined;
  }
}

let stopping = false;
/**
 * Stop the server cleanly: record which sessions to resume (data/resume.json), stop the agent
 * processes, save state, exit. For request_app_update also leave data/update.request, so the
 * supervisor updates before starting the next server.
 */
function stopServer(req: RestartRequest, drained: ReadonlySet<string> = new Set()) {
  if (stopping) return;
  stopping = true;
  console.log(`stopping (${req.reason}): stopping agent processes (Unity editors are left running)`);
  try {
    const f = agents.resumeFile(req, drained, appHead());
    writeResumeFile(cfg.dataDir, f);
    console.log(`recorded ${f.sessions.length} session(s) to resume: ${f.sessions.map((e) => `${e.id} (${e.why})`).join(', ') || 'none'}`);
  } catch (e) {
    console.error('could not write data/resume.json:', e);
  }
  if (req.update && !req.hold) fs.writeFileSync(path.join(cfg.dataDir, 'update.request'), new Date().toISOString());
  // The supervisor has it now (or it was not an update): nothing left to retry after a crash.
  clearPendingRestart(cfg.dataDir);
  // Backlog step 2 (config machines.keepAgentsOnRestart, docs/beast-machine.md): the daemons' agents carry on.
  sessions.stopAll((s) => !(keepDaemonAgents() && s.info.machineId));
  voice.unload('server stopping');
  providers.close();
  max.close();
  intake.close();
  store.flush();
  process.exit(0);
}

// The user's Claude plan usage (server/usage.ts): polled at startup, then every config usagePollMinutes (default 15).
// Every account in use: this host's login and token here, each Mac's own login reported by its daemon.
const usage = new UsageTracker(cfg, () => {
  if (usage.usage) broadcast({ type: 'usage', usage: usage.usage });
  broadcast({ type: 'accounts', accounts: accountsNow() });
});
/** People's own Claude tokens (config userClaudeEnv, docs/identity.md), labelled with their names. */
function personTokens() {
  return identity
    .list()
    .map((u) => ({ u, token: userToken(cfg, u.userId) }))
    .filter((x): x is { u: (typeof x)['u']; token: string } => !!x.token)
    .map(({ u, token }) => ({ token, displayName: u.displayName, label: `${u.displayName}'s token …${token.slice(-4)}` }));
}
usage.personTokens = personTokens;
function accountsNow() {
  const token = hostToken(cfg);
  const toMachine = (id: string) => machineToken(cfg, usesHostClaudeEnv(cfg, store.machines.get(id) ?? id));
  const hostLogin = (kind: SessionKind) => hostAccount(cfg, hostRole(kind)) === 'login';
  return buildAccounts(usage.entries, {
    hostName: os.hostname(),
    token: token ? { key: tokenKey(token), label: tokenLabel(token) } : undefined,
    hostLoginRoles: HOST_ROLES.filter((r) => hostAccount(cfg, r) === 'login'),
    people: personTokens().map((p) => ({ key: tokenKey(p.token), label: p.label, displayName: p.displayName })),
    machines: machines.list().map((m) => {
      const t = toMachine(m.id);
      return { id: m.id, usesToken: !!t && !!token && tokenKey(t) === tokenKey(token) };
    }),
    sessions: [...store.sessions.values()].map((s) => ({ id: s.id, source: sessionSource(s, token, toMachine, (id) => userToken(cfg, id), hostLogin), live: s.status !== 'stopped' && s.status !== 'error' })),
  });
}
// Which agents are on which account, and how many run now (the order), change with sessions and machines.
let accountShape = '';
let accountTimer: NodeJS.Timeout | undefined;
bus.on('event', (e: ServerEvent) => {
  if (!['session', 'session_removed', 'machine', 'machine_removed'].includes(e.type)) return;
  if (e.type === 'machine_removed') usage.forget(e.id);
  accountTimer ??= setTimeout(() => {
    accountTimer = undefined;
    const live = (s: { status: string }) => (s.status === 'stopped' || s.status === 'error' ? '' : '+');
    const shape = `${[...store.sessions.values()].map((s) => s.id + live(s) + (s.account ?? '')).join()}|${machines.list().map((m) => m.id).join()}|${hostToken(cfg)?.slice(-4) ?? ''}|${JSON.stringify([cfg.claudeAccounts, cfg.machines?.useHostClaudeEnv])}`;
    if (shape === accountShape) return;
    accountShape = shape;
    broadcast({ type: 'accounts', accounts: accountsNow() });
  }, 1000);
});
machines.onUsage = (id, account, u) => usage.report(id, account, u);
for (const s of sessions.sessions.values()) usage.recordCost(s.info.id, s.info.costUsd); // baselines
sessions.events.on('result', (s: { info: { id: string; costUsd: number } }) => usage.recordCost(s.info.id, s.info.costUsd));
/** Whose account each orchestrator runs on (docs/orchestrators.md), for system_status: a person without a token of their own is on the owner's. */
function orchestratorAccountsLine() {
  const people = identity.list();
  const own = people.filter((u) => userToken(cfg, u.userId)).map((u) => u.displayName);
  const none = people.filter((u) => !userToken(cfg, u.userId)).map((u) => u.displayName);
  const payer = identity.systemPayer();
  return (
    `Orchestrators: each person's own runs on their own token${own.length ? ` (${own.join(', ')})` : ''}` +
    `${none.length ? `; ${none.join(', ')} ${none.length === 1 ? 'has' : 'have'} none here, so theirs runs on the orchestrator's account above` : ''}` +
    `; the dispatcher runs for the system payer, ${payer.displayName}, on ${userToken(cfg, payer.userId) ? 'their own token' : "the orchestrator's account above"}.`
  );
}
agents.usageLines = () => {
  // Numbers under one interval old are used as they are; older, a poll starts (docs/accounts.md, "How often").
  usage.ensureFresh();
  return [
    ...accountSetupLines(cfg, os.hostname(), hostToken(cfg), machines.list(), personTokens().map((p) => p.displayName)),
    orchestratorAccountsLine(),
    ...accountLines(accountsNow(), store.sessions, new Date()),
  ];
};
// usagePollMinutes changed (set_app_config): this host's next poll moves, and the daemons hear the new interval.
agents.usagePollChanged = () => {
  usage.reschedule();
  machines.pushUsageConfig();
};
agents.machineStatusLines = () => machines.list().map((m) => machineLoadLine(m, machines.statsOf(m.id), machines.isOnline(m.id)));
agents.extraStatusLines = () => {
  const ffbox = providers.statusLine();
  return [...(ffbox ? [ffbox] : []), max.statusLine(), ...outsideWatchLines()];
};
const outsideWatchLines = () => {
  const w = watcher();
  const c = watchConfig();
  if (!w || !c) return [`Outside watchdog: off (${cfg.outsideWatch?.enabled === false ? 'outsideWatch.enabled is false' : !c ? 'no publicUrl to watch' : 'no machine to watch from'})`];
  return [
    `Outside watchdog: ${w} checks ${c.healthUrl} and pings ${c.host} every 60 s${machines.isOnline(w) ? '' : ` (${w} is offline now)`}; alerts go to ntfy topic "${c.ntfyTopic}" (subscribe in the ntfy app); Wake-on-LAN ${c.mac ? `to ${c.mac}${c.broadcast ? ` via ${c.broadcast}` : ''}` : 'not possible yet (MAC unknown)'}`,
  ];
};
usage.start();

/** Backlog step 2: a restart leaves the agents machine daemons run alone (config machines.keepAgentsOnRestart). */
const keepDaemonAgents = () => cfg.machines?.keepAgentsOnRestart === true;
const drainer = new Drainer({
  dataDir: cfg.dataDir,
  // With keepAgentsOnRestart the daemons' agents are not asked to wrap up: the restart does not stop them.
  snapshot: () => [...sessions.sessions.values()].filter((s) => !(keepDaemonAgents() && s.info.machineId)).map(snapshotOf),
  tell: (id, text) => void sessions.send(id, text, 'system'),
  stop: (req, drained) => stopServer(req, drained),
  changed: () => broadcast({ type: 'host', host: { ...host, drain: drainer.status } }),
  log: (line) => console.log(line),
});
agents.requestRestart = (req) => {
  // An update survives a power cut or a crash during the drain: the next server retries it (below).
  if (!drainer.status) writePendingRestart(cfg.dataDir, req);
  const note = drainer.request(req);
  broadcast({ type: 'host', host: { ...host, drain: drainer.status } });
  return note;
};

const plainStop = (reason: string): RestartRequest => ({ drain: false, drainMinutes: 0, reason, update: false, hold: false });
process.on('SIGINT', () => stopServer(plainStop('interrupted (SIGINT)')));
process.on('SIGTERM', () => stopServer(plainStop('terminated (SIGTERM)')));
// Windows has no SIGTERM for a detached process; the scripts ask for a stop with this file. Empty: stop
// now. JSON: drain first (scripts/restart.ps1; see server/restart.ts parseRestartRequest).
const restartFlag = path.join(cfg.dataDir, 'restart.request');
fs.rmSync(restartFlag, { force: true });
fs.rmSync(path.join(cfg.dataDir, 'drain.done'), { force: true });
setInterval(() => {
  if (!fs.existsSync(restartFlag)) return;
  let text = '';
  try {
    text = fs.readFileSync(restartFlag, 'utf8');
  } catch {
    // being written; next tick
    return;
  }
  fs.rmSync(restartFlag, { force: true });
  const req = parseRestartRequest(text);
  if (req === 'now') drainer.stopNow(plainStop('restart'));
  else agents.requestRestart!(req);
}, 1000);

// Local scripts that outlive a restart (scripts/republish-public.ps1) report to the orchestrator by dropping a
// text file in data/orchestrator-inbox; each is sent once as a system message, then renamed *.sent.
const inbox = path.join(cfg.dataDir, 'orchestrator-inbox');
setInterval(() => {
  const id = store.orchestratorId;
  if (!id || !fs.existsSync(inbox)) return;
  for (const name of fs.readdirSync(inbox).filter((n) => n.endsWith('.txt')).sort()) {
    const file = path.join(inbox, name);
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').trim();
      fs.renameSync(file, file.replace(/\.txt$/, '.sent'));
    } catch {
      continue; // being written; next tick
    }
    if (text) {
      try {
        sessions.send(id, text.slice(0, 8000), 'system');
      } catch (e) {
        console.warn(`orchestrator inbox: could not deliver ${name}: ${(e as Error).message}`);
      }
    }
  }
}, 5000);

/** The managers, for the E2E harness (e2e/server.ts) to set up states no browser can reach (a blocked editor). */
export const internals = { cfg, store, sandboxes, sessions, agents, providers, max };

// Data files a crash damaged and that were restored from an earlier version (server/durable.ts). The owner hears at
// once (a push and their own orchestrator); the restart summary carries the same lines to the dispatcher.
let recoveriesTold = 0;
function takeRecoveryLines(): string[] {
  const fresh = dataRecoveries.slice(recoveriesTold);
  recoveriesTold = dataRecoveries.length;
  return fresh.map(describeRecovery);
}
function tellOwnerRecovered(text: string) {
  notifier.host('Data restored after a crash', text);
  if (!cfg.orchestrator.notifyOnWorkerEvents) return;
  try {
    agents.orchestrators.toPeople([identity.owner()], `[data restored] ${text}`);
  } catch (e) {
    console.warn(`could not tell the owner about the data recovery: ${(e as Error).message}`);
  }
}
// A file read on demand (users.json, api-keys.json, machine-tokens.json) can be healed later: the dispatcher hears too.
setInterval(() => {
  const lines = takeRecoveryLines();
  if (!lines.length) return;
  const text = `DATA RESTORED: ${lines.join(' ')}`;
  tellOwnerRecovered(text);
  const orch = store.orchestratorId;
  if (orch) {
    try {
      sessions.send(orch, `[data restored] ${text}`, 'system');
    } catch {
      // no orchestrator right now; the push went out
    }
  }
}, 60_000).unref();

// Resume what the last server recorded (or report what a crash cut off), once the managers are up.
// After a stop that was not clean (no resume file: a power cut, a crash, a kill), make one from what the last
// server left (the sessions it had mid-turn, the editors that were up) and resume those too; an update that
// was pending then is retried first (docs/restart.md).
setTimeout(() => {
  try {
    const notes = host.elevated ? [`WARNING: the server is running elevated, so it will not start Unity editors: ${host.elevatedWhy ?? ''}`] : [];
    const recovered = takeRecoveryLines();
    if (recovered.length) {
      const text = `DATA RESTORED AFTER A CRASH (the last server was last alive ${lastAlive ? new Date(lastAlive.at).toISOString() : 'at an unknown time'}): ${recovered.join(' ')}`;
      notes.push(text);
      tellOwnerRecovered(text);
    }
    const clean = takeResumeFile(cfg.dataDir);
    const pending = takePendingRestart(cfg.dataDir);
    if (clean) {
      agents.resumeAfterRestart(clean, cutOff, { head: appHead(), version: appVersion().version }, notes);
      return;
    }
    const cause = describeUncleanStop({ lastAliveAt: lastAlive?.at, bootAt: Date.now() - os.uptime() * 1000, host: os.hostname() });
    if (!mayRecoverUnclean(cfg.dataDir)) {
      // A second unclean stop within 30 minutes: maybe a crash loop. Report only, as before.
      notes.push(`Cause: ${cause}. This is the second unclean stop within 30 minutes, so nothing was resumed or restarted automatically (crash-loop guard)${pending ? `, and the pending update (${pending.reason}) was not retried` : ''}.`);
      agents.resumeAfterRestart(undefined, cutOff, { head: appHead(), version: appVersion().version }, notes);
      return;
    }
    const f = agents.uncleanResumeFile(cutOff, cause, sandboxes.lostEditors, lastAlive?.at, appHead());
    console.warn(`unclean stop: ${cause}; ${f.sessions.length} session(s) and ${f.editors?.length ?? 0} editor(s) to bring back${pending ? `; retrying the pending update (${pending.reason})` : ''}`);
    if (pending && !host.elevated) {
      // Hand it to the supervisor as a clean update would, with everything to bring back in the resume file.
      writeResumeFile(cfg.dataDir, { ...f, reason: pending.reason, update: true });
      fs.writeFileSync(path.join(cfg.dataDir, 'update.request'), new Date().toISOString());
      store.flush();
      process.exit(0);
    }
    agents.resumeAfterRestart(f, cutOff, { head: appHead(), version: appVersion().version }, notes);
  } catch (e) {
    console.error('resume after restart:', e);
  }
}, 2000);
