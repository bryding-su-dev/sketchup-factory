# The portal's own host as a machine (BEAST)

**TL;DR:** BEAST's sandboxes, editors and workers move from the portal process to a machine daemon on BEAST itself, the
same `machine/daemon.ts` the M3, the M5 and LothDesktop run. The portal becomes orchestrator only. BEAST shows up as
machine `beast` with its sandboxes named `beast/<name>` (bare names keep working). The move re-homes the records only:
folders, branches, Libraries and running editors stay where they are. One tool call does it
(`migrate_host_sandboxes`), and the same tool with `back` undoes it. Backlog step 2 (portal restarts that leave the
daemons' agents running) is built in and off (`machines.keepAgentsOnRestart`).

## What changes

| Before | After |
|---|---|
| `server/sandboxes.ts` (`SandboxManager`) creates, watches and deletes BEAST's worktrees in `F:\ffsb` | The daemon's pool (`machine/sandboxes.ts`, `SandboxPool`) does, as on LothDesktop |
| Workers are `AgentSession`s inside the portal's node process: a portal restart stops them | Workers are `RemoteSession`s; their Claude processes are children of the daemon (a scheduled task), not of the portal |
| Host limits `limits.maxSandboxes` / `maxUnity` / `maxSessions` (5 / 4 / 6) | The machine's `max_sandboxes` / `max_unity` / `max_sandbox_agents` (5 / 4 / 6), taken from the same config at deploy |
| Host editor watch (dialogs, hang, crash, idle stop) in the portal | The daemon's `MacUnityWatch` (Windows branch), the same rule table (`server/watchdog.ts decide`), its own idle stop (`unity.idleStopMinutes`) |
| Workers on `claudeAccounts.workers` | The same setting: the local machine follows `claudeAccounts.workers` unless `machines.useHostClaudeEnv` names it (`server/secrets.ts usesHostClaudeEnv`) |

What stays in the portal on purpose: the orchestrators, standing agents on BEAST (they are scheduled, not
sandbox work), the host guard (`server/hostHealth.ts`: disk levels, the Dev Drive remount, RAM, the reaper and the
clean-up), and restarts/updates of the portal itself.

## Design

**One machine is local.** `add_machine {id: "beast", local: true}` marks the record `local` (`shared/types.ts
Machine.local`; at most one, Windows hosts only). A local machine:

- **Deploys without ssh.** The same PowerShell scripts as a Windows PC (`server/machineDeployWin.ts`) run through
  `powershell.exe` on this computer (`scriptCommand(LOCAL)`); the code bundle is written into the user's home instead
  of `scp` (`server/machineDeploy.ts localBundle`). `machine_daemon` and `remove_machine` use the same local route, and
  the offline redeploy does not wait for ssh (`MachineManager.watchOffline`).
- **Runs as the portal's user, non-elevated,** in its own `FFFactoryDaemon` scheduled task at logon (the same task XML,
  `LeastPrivilege`), so it survives portal restarts and never inherits the portal's process tree. If Windows refuses a
  non-elevated registration, the deploy writes `daemon-task.xml` into the daemon's folder and names the one
  administrator command that registers it; a task registered once keeps working for later deploys.
- **Takes its settings from the portal's config** (`localMachineDefaults`, `server/machines.ts`): main clone =
  `repo.basePath` (`C:\ffsb\_base`), `sandbox_root` = `sandboxRoot` (`F:\ffsb`), limits from `limits.*`, disk guard from
  `hostGuard.warnFreeGB`/`criticalFreeGB`, protected paths = `protectedPaths` + this app (unless `guard.protectFactoryCheckout` is `false`) + its data, Library seed =
  `librarySeed` with `librarySeedCopy` (`F:\ffsb\_seed\Library`, block clone on the Dev Drive), editors below normal
  priority (the live game wins), portal URL `http://127.0.0.1:<port>` (no Funnel round trip), the MCP-for-Unity server
  from `unity.mcpServer`. Anything given to `add_machine` wins.
- **Has no main-clone agents.** Its main clone is the base the sandboxes are worktrees of; a worker there is refused.
- **Cleans nothing itself** (`cleanup_config` 0/0). The host guard's clean-up already covers this computer, and counts
  the daemon's running agents' temp folders as in use.
- **Is gated by the host guard.** A new agent or editor there waits on the same `blockReason` as the host's
  (`MachineManager.localGate`); the Dev Drive recovery brings its editors and agents back through the daemon.
- **Is attributed to the host's login.** Its sessions keep `host:login`, and its daemon's own usage report is ignored
  (the portal polls that login already).

**Protocol 6** (`server/machineProtocol.ts`): the `adopt` and `release` sandbox ops take an existing worktree into the
pool, or drop it from the pool, without touching it (`SandboxPool.adopt` checks it is a direct child of the root named
after the sandbox and a worktree of the main clone; the branch is read from git). The pool settings gain `maxAgents` (a
total across sandboxes), `librarySeed`/`librarySeedCopy`/`librarySeedGB`, `belowNormal` and `protectedPaths`
(clean-up keeps them; a sandbox may not be named after one, as its Unity instance name would collide).

**Routing.** `Agents.target` resolves a bare name to the local machine's sandbox when the host has none of that name,
so `mp-r2` and `beast/mp-r2` are the same everywhere (tools, the ledger, the dispatcher). `create_sandbox` and the New
sandbox form default to the local machine (`defaultSandboxMachine`). Standing agents' auto-delegation picks free
`beast/<name>` sandboxes too. `list_sandboxes` shows the host group only while the host still has sandboxes of its own.

**The guard** of a BEAST sandbox agent is the machine sandbox guard plus the protected paths (the live game, this app
unless `guard.protectFactoryCheckout` is `false`, and its data). Ending or changing the daemon's scheduled task is refused for every agent (`server/guard.ts`), and the
reaper never touches a daemon (`server/reaper.ts isProtected`).

**The UI.** The host's group in the sidebar and on the Overview lists the daemon's sandboxes as its own; the daemon has
no group of its own. The group's dot turns red with "daemon offline" while it is down, and the Overview card opens the
daemon's machine page (redeploy, restart, its log folder). A sandbox's page is the machine sandbox page
(`#/machine/beast/sandbox/<id>`).

## Migration (in place, no loss)

Nothing on disk moves. What moves, per sandbox (`server/hostMigration.ts`):

- the portal's record: `state.json` `sandboxes[]` → `machines[beast].sandboxes[]` (label, agents, created time, editor
  log path, git state);
- each agent record: `sandboxId` → `machineId: "beast"`, `machineSandbox`; `sdkSessionId`, transcripts, title and cost
  unchanged, so a message resumes the same Claude conversation (same Windows user, same cwd, same `CLAUDE_CONFIG_DIR`);
- delegations naming it: `sandboxId` "x" → "beast/x";
- the daemon's `sandboxes.json` gains the worktree (through `adopt`), and a running editor is found by its command line
  at the daemon's next look and keeps running.

**When:** with no BEAST worker mid-turn. Idle workers' processes are stopped by the tool (their conversation resumes
on the daemon at the next message). Pick a quiet moment; the daemon's first deploy takes a minute or two (npm ci).

**Steps** (the dispatcher, when a person asks):

1. `add_machine {id: "BEAST", local: true, user_asked: true}`. Wait until `list_machines` shows `beast` online (protocol 6).
2. `migrate_host_sandboxes {direction: "to_machine", dry_run: true, user_asked: true}`: lists what moves and anything
   in the way (a worker mid-turn, a sandbox in error, a path mismatch).
3. The same without `dry_run`. It copies `state.json` to `data/state.pre-host-migration-<time>.json` first, and writes
   `data/host-migration.json`.
4. Check: `list_sandboxes` shows `## beast (this host's own daemon…)` with the five sandboxes and their labels; the
   sidebar shows them under BEAST; `unity {sandbox: "mp-r2", action: "status"}` reports the editor.

## Rollback

- **Live** (the new portal runs): `migrate_host_sandboxes {direction: "back", user_asked: true}` releases each sandbox
  from the daemon and restores the host records and handles (again nothing on disk changes; the host's own watch picks
  the running editors up). Then `remove_machine beast` (refused while it still holds sandboxes) unloads the daemon.
- **Offline** (the new portal cannot run): stop the portal (`scripts\stop-server.ps1`) and the daemon (disable and
  end the `FFFactoryDaemon` task, then end the `node` process whose command line names `.ff-factory\app\machine\daemon.ts`:
  what `machine_daemon stop` does), then
  `node scripts/host-migration.ts back --data C:\ff-sandboxes\data --machine beast --daemon-dir C:\Users\rydin\.ff-factory`
  (`--dry-run` first). Then revert the code (below) and start the portal.
- **Code**: roll back the portal only after the sandboxes are back on the host. An older portal knows machine sandboxes
  but not `local`: it would try to redeploy `beast` over ssh and refuse new agents on its protocol-6 daemon.
  `git -C C:\ff-sandboxes reset --hard <previous commit>` then `scripts\restart.ps1`, or
  `Unregister-ScheduledTask FFFactoryDaemon` if `remove_machine` could not run.
- The pre-migration `state.json` copy is the last resort: restoring it loses only records made after the migration
  (their transcripts stay in `data/transcripts`).

The host's own sandbox code (`server/sandboxes.ts`) stays until the daemon has run BEAST's sandboxes for a while: the
rollback needs it. Deleting it (and the host-only branches in `agents.ts`/`index.ts`) is the follow-up.

## Deploy steps (Ben decides when)

1. Wait for a moment with no BEAST worker mid-turn; tell the people with workers there.
2. `scripts\restart.ps1 -Update` on BEAST (or `request_app_update`): the usual drain, update and restart. The other
   daemons are outdated after it and redeploy themselves once idle.
3. Migration steps 1-4 above.
4. Watch for an hour: `list_machines` (beast online, current), a worker started in a `beast/<name>` sandbox, an editor
   start/stop, the daemon log in `C:\Users\rydin\.ff-factory\logs\daemon.log`.
5. Later, once trusted: backlog step 2 (`set_app_config machines.keepAgentsOnRestart true` is not in the allowlist on
   purpose; edit `config.json` and restart).

## Backlog step 2 (prepared, off)

`machines.keepAgentsOnRestart: true` (config.json): a portal restart or update no longer asks daemon-hosted workers to
wrap up (`Drainer` snapshot) and no longer stops them (`stopServer` → `sessions.stopAll` skips `RemoteSession`s). A
daemon from another commit that speaks the portal's protocol still takes new agents (`MachineManager.incompatible`)
and is redeployed once idle; after the restart, workers still running are reported as "Still running there (not
interrupted)" and the rest are resumed as today. The daemons already queue events while the portal is down (up to 20 000)
and replay them on reconnect. Before turning it on: confirm on BEAST that a portal restart leaves `FFFactoryDaemon`'s
agents running and the reconnect replays their transcripts.

## BEAST-specific things left in place

- The host guard, the Dev Drive remount helpers and the portal's own clean-up rules stay host-side (they are about the
  computer, not the sandboxes).
- Standing agents on BEAST still run in the portal (`F:\ffsb\_agents`).
- The game repo's nightly scripts address BEAST by ssh and path, unaffected by this change (no folder moves):
  `scripts/nightly/lab.m3.json` (client B `root: F:/ffsb/nightly-e2e/Builds/nightly`, a folder outside the pool),
  `nightly.sh` and `beast_watchdog.sh` (`F:/ffsb/_nightly-e2e/reports`), `install_schedule.sh` (the watchdog task over
  ssh), and `player_slots.py` / `setup_player_slot_firewall.ps1` (BEAST picks `F:\ff-players` because `F:\ffsb` exists).
- Agents on machines have no `wait_for_unity` tool (they poll `unity status`), as on LothDesktop.

## Known limits

- The migration re-checks each sandbox's agents just before and after its adopt: one a wake or a message started in
  the meantime keeps that sandbox on the host (the daemon gives it back), and a failed adopt or release is undone the
  same way. The report says so; run the migration again once those agents are idle.
- Between the daemon's deploy and the migration, the host's pool and the daemon both run git in the base clone, each
  with its own lock. Git's lock files make a clash fail rather than corrupt, but do the migration right after the deploy
  and create no sandbox in between.
- While the Dev Drive is gone, the daemon's editor watch finds its sandbox editors crashed and gives up after its
  restart budget; once the host guard has reattached the drive it starts those editors again through the daemon. A
  remount self-test (`host_recovery selftest`) with a migrated sandbox's editor running is worth doing once.
- The offline script refuses while a daemon runs on the computer (with `keepAgentsOnRestart` it outlives the portal).
