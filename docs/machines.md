# Machines: agents on the user's Macs and Windows PCs

A machine is a whole computer the portal can run agents on, beside the sandboxes on the host. By default
agents work in the machine's main game clone, the one the user uses (no worktree unless a task truly needs
one); a machine given a `sandbox_root` also holds its own pool of sandboxes ([Machine sandboxes](#machine-sandboxes)). Machines are Macs (the daemon is a LaunchAgent) or Windows PCs (the
daemon is a scheduled task at the user's logon, [below](#windows-machines)), with ids such as `m5` or
`lothdesktop`. Ids are lower-case letters, digits and dashes; one given with capitals (`LothDesktop`) is
stored lower-case and shown as typed, and either spelling works in every tool.

The rest of this page describes the Macs; [Windows machines](#windows-machines) says what differs.

## Requirements

| | on each Mac |
|---|---|
| Reachable | `ssh <host alias>` from the portal host with an existing key, no password prompt |
| Game clone | a clone of the game repo (the one in config `repo.url`) under the home folder, found by its `origin` URL, or pass its path to `add_machine` |
| Claude Code | installed and logged in for the user (the keychain login works: the daemon runs in the GUI session) |
| node | 22.6 or newer (versions without native TypeScript support run with `--experimental-strip-types`); the newest node on the PATH the user's own zsh sets up, or in common install locations, is used |
| Portal URL | a public URL for the portal, e.g. the Tailscale Funnel URL `https://<host>.<tailnet>.ts.net` (config `publicUrl`, or given to `add_machine`) |
| Sleep | set to never, or agents stop when the Mac sleeps (the daemon holds `caffeinate -i` only while agents run) |

A Windows PC needs the same (reachable over ssh with a key, a clone, Claude Code, node 22.6+) plus git and
OpenSSH Server: its owner's checklist is in [Setting up a Windows PC](#setting-up-a-windows-pc-for-its-owner).

The portal can listen on `127.0.0.1` only. The Macs reach it through its public URL, not a tailnet IP.

Files people attach to messages reach a machine's agents through its daemon, which fetches each one from the portal
with its machine token into `Inbox/` of the agent's working folder before the message goes on (protocol 7,
[attachments.md](attachments.md#machines)).

## Design: a daemon that connects out

Each Mac runs `machine/daemon.ts` as a **LaunchAgent** (`com.fffactory.daemon`, in the user's GUI
session). It opens a WebSocket to `wss://<portal>/machine` with a per-machine token, and runs Agent
SDK sessions locally with the same `AgentSession` code the portal uses, streaming every transcript
event and session update back. The portal keeps the record (state.json, transcripts) exactly as for
sandbox workers, so the UI, the orchestrator's tools and transcripts do not care where an agent runs.

Why not drive sessions over ssh: an ssh session cannot read the login keychain, so Claude Code on
a Mac often looks logged out there, and an ssh connection dies with every sleep or network change. A
LaunchAgent runs in the logged-in session (keychain, the user's `claude` and plugins), starts at
login, restarts if it dies, and reconnects by itself: every ~2 s for the first two minutes after a drop
(a portal restart takes 20-60 s; a refused attempt, such as the proxy's 502 while the portal is down,
ends at once), then backing off to 30 s; a ping every 20 s, and a dead connection is dropped after 45 s
without a pong. If a daemon still has not come back 2 minutes after the portal started or after it
dropped, and its Mac answers ssh, the portal redeploys it by itself (as `add_machine` does), at most
every 30 minutes and never while its agents are running. So after a restart, give daemons a minute
before redeploying by hand.

- **Auth.** A 256-bit token per machine; the portal keeps only its SHA-256 (state.json) and compares
  in constant time. `/machine` is on the public Funnel URL, so a bad token is logged and throttled.
- **Sessions.** The portal creates the session record and tells the daemon what to launch (a
  serialisable launch spec: cwd, model, brief, tools, guard settings, budget). Transcript sequence
  numbers are assigned by the daemon, starting from the portal's last one, so a session resumes
  across daemon restarts. An agent whose machine is offline shows `stopped`; messaging it fails with
  "machine m5 is offline". **Cut off mid-turn:** when a machine's link drops, the portal notes the workers that
  were mid-turn; when the daemon is back without them (it was redeployed with `add_machine` `force`, restarted
  with `machine_daemon restart`, or crashed), each gets a resume message (check git status, re-pin Unity,
  continue), as after a portal restart, and the orchestrator hears which. After a network blip they are still
  running, so nothing is sent; `machine_daemon stop` is on purpose and resumes nobody; after more than 6 hours
  the orchestrator is told instead. A daemon going down stops its agents keeping their mid-turn mark
  (`stop(false)`), which is how the portal knows. Only workers the daemon reported live on the link that dropped
  (its hello or a session report, `seenLive`), mid-turn and active within those 6 hours count (`cutOffMidTurn`):
  the portal's own marks and activity times never suffice on their own, whatever the daemon's version. A report
  without `turnOpenSince` clears the portal's copy (JSON drops cleared fields), a drop clears every mark it has
  noted, and a refused start (`failed`) does not move `lastActivityAt`. An agent stopped or interrupted on purpose
  (`stop_agent`, the UI) is marked `stoppedOnPurpose` (saved, and taken off any cut-off list already noted) and is
  never resumed, by a dropped link or a portal restart, until it is sent a message again.
- **Tools.** Workers get the machine's `set_label` (same as a sandbox's) via a `machine` MCP server
  whose calls go back to the portal. Unity is not managed in v1: agents use whatever editor and MCP
  the Mac already has (the Mac's own user settings load).
- **Guard.** The workers' guard runs in the daemon, plus rules for the user's own clone. The user's
  standing permission (2026-09-25): to update the clone an agent may set aside or discard local
  changes (`git stash`, `restore`/`checkout -- <paths>`, `reset` of files or `--hard`, `clean`, a
  forced or dirty-tree branch switch), but only after copying them to a fresh timestamped folder in
  `ff-local-backups/` beside the clone (e.g. `~/nevergames/ff-local-backups/<time>/`: the patches, the
  changed and untracked files, the stash list), and it reports what it moved. The guard refuses those
  commands until a backup folder from the last 2 hours exists, and its refusal gives the backup recipe
  (`backupRecipe` in `server/guard.ts`). Staging or committing everything (`add -A`/`.`, `commit -a`),
  force pushes and pushes to the game repo's master/main stay refused. The daemon's own folder
  (`~/.ff-factory`, or the machine's `app_dir`; it holds the token) is protected.
- **Claude account.** Portal-run agents on a Mac (workers and standing agents) use this host's
  `claudeEnv`, so with `CLAUDE_CODE_OAUTH_TOKEN` set (`set_app_config`, write-only) they run on the same
  Claude account as the agents here, not on the Mac's own login. The portal puts it in the launch spec,
  sent over the authenticated daemon connection with each start; the daemon passes it to that agent's
  Agent SDK process only (it overrides the Mac's keychain login for that process). It is never written
  to disk on the Mac, the daemon log redacts tokens, and transcripts are redacted (server/secrets.ts).
  The user's own interactive Claude Code sessions on the Mac are unaffected: they keep the Mac's login.
  `list_machines` and the machine brief show the source: "host token …abcd" or "Mac login". Config
  `machines.useHostClaudeEnv` (default `true`) turns it off everywhere (`false`) or per machine
  (`{ "m3": false }`, with `"*"` for the machines not named); `set_app_config machines.useHostClaudeEnv`
  sets it, with `machine: "<id>"` for one machine. A Mac on its own login gets no token, and the daemon
  drops any credential in its own environment for that agent (`LaunchSpec.login`). An agent already
  running keeps its account until its process restarts; after an update the daemons are redeployed
  anyway. An agent working for someone with their own token (config `userClaudeEnv`,
  [identity.md](identity.md)) runs on that token instead, on any Mac. Every account switch, including the
  orchestrator's and this host's workers': [accounts.md](accounts.md).
- **Limits.** Machine agents run on the Mac, so they do not count toward this host's
  `limits.maxSessions`; each machine has its own limit for its main clone and standing agents (`max_agents`,
  default 3), and each of its sandboxes its own (`max_agents_per_sandbox`, below). Like the host's, they count agents
  mid-turn only, and a message that finds them full waits in the portal's queue instead of being refused; the daemon's
  own start check counts the same way, and idle finished workers are stopped by the portal's reaper
  ([orchestrators.md](orchestrators.md#agent-limits-and-idle-workers), w384).
- **Awake.** While any agent process is live the daemon holds `caffeinate -i`.
- **Clean-up.** The daemon cleans its machine's disk by itself (the continuous clean-up,
  [self-recovery.md](self-recovery.md#5-continuous-clean-up)): a pass every hour, every 15 minutes while
  free space is below its soft threshold (80 GB by default), with the rules for its platform. Each agent
  gets its own temp folder (`ffa-<session>` under `temp_dir` or the system's temp), removed when the
  session is removed or two hours after it stopped. The portal sends the settings at connect and when they
  change (`cleanup_config`; config `machines.cleanup.everyMinutes` / `.softFreeGB`, per machine with
  `set_app_config ... machine: "<id>"`); the daemon keeps them in `cleanup.json` in its folder, so it goes on
  while the portal is down. After each pass it reports a summary (`cleanup`), shown by `list_machines` and
  the dashboard's meters; one that cannot get back above the soft threshold also tells the orchestrator,
  with the biggest remaining consumers. Every pass is logged to `cleanup-log.jsonl` in the daemon's folder.
  `machine_cleanup` runs a pass now.
- **Standing agents** can be assigned to a machine: their folder is `agents/<id>` in the daemon's folder
  (`~/.ff-factory/agents/<id>` by default) on that Mac, runs wait (like a full slot) while the machine is offline, and budgets work unchanged.

## Setup and updates, from this host

`add_machine` (orchestrator tool, and a button in the UI) does everything over ssh with this host's
existing keys: finds node (≥ 22.6) and the FF clone, copies the portal's own code
(`git archive` of `server/ shared/ machine/ package*.json`) to `~/.ff-factory/app`, runs
`npm ci --omit=dev`, captures the user's own zsh PATH (login + interactive, so the LaunchAgent sees what their
terminal sees, e.g. `~/bin/gh`), writes `~/.ff-factory/daemon.json` (portal URL, name, token, repo path,
`claude` path) and the LaunchAgent plist, and (re)loads it: `launchctl bootout`, a wait of up to 30 s until the
old daemon has gone (`launchctl print` fails), then `launchctl bootstrap gui/<uid>`, retried up to 5 times
(`macReloadLines`; a bootstrap into a service still loaded fails with "5: Input/output error" and left m3 with no
daemon, 2026-09-29).
Running `add_machine` again for the same id (or Redeploy in the UI) updates the code and issues a fresh
token; it refuses while agents are running there unless forced. The user does nothing on the Macs.
The deploy counts the new daemon as connected from the start of its install step (launchd starts it before the
ssh session returns) or by its hello naming the version installed. A daemon's hello clears any install or
connection error on its machine (a connected machine never shows "error"); a redeploy that fails while a
daemon is still connected leaves the machine ready, with "the last redeploy failed, …" as its detail; a deploy
cut short by a portal restart shows as an error at boot rather than staying "deploying".

**A machine's own folders.** `add_machine` (and the Add machine form) takes four optional absolute paths (and
`sandbox_root`, [below](#machine-sandboxes)),
kept on the machine's record (shown by `list_machines` and on the machine page) and in its `daemon.json`:

| Option | What it sets | Default |
|---|---|---|
| `app_dir` | The daemon's folder: `app/` (the code), `logs/`, `agents/` (standing agents), `daemon.json`, `outside-watch.json`, the public-repo identity | `~/.ff-factory` (`%USERPROFILE%\.ff-factory`) |
| `unity_editor_root` | A folder of Unity versions, searched first: `<root>/<version>/Unity.app` on a Mac, `<root>\<version>\Editor\Unity.exe` on Windows | Unity Hub's folders |
| `unity_path` | The Unity editor executable itself, used whatever the project's version | the lookup |
| `temp_dir` | `TMP`, `TEMP` and `TMPDIR` of its agents' processes (made if missing) | the system's |

On a redeploy an option left out keeps its value and `""` clears it. A path for the other OS is refused
(`checkDirs`). On a Mac with an `app_dir` the deploy writes there and the LaunchAgent runs
`<app_dir>/app/machine/daemon.ts <app_dir>/daemon.json`, logging to `<app_dir>/logs/daemon.log`. The guard
protects the `app_dir` as it protects `~/.ff-factory`. Moving it leaves the old folder's files in place (delete
them by hand); the old LaunchAgent is replaced as on any redeploy.

**Finding Unity** (`editorBinary` in `machine/unity.ts`, both OSes): `unity_path`; else the project's version
(`ProjectSettings/ProjectVersion.txt`) in `unity_editor_root`; then the editors Unity Hub lists in its settings
folder (`editors-v2.json`, or the older `editors.json`: editors the Hub was pointed at, anywhere); then the
install location chosen in the Hub (`secondaryInstallPath.json`); then the Hub's defaults
(`/Applications/Unity/Hub/Editor`, `~/Applications/Unity/Hub/Editor`; `Program Files\Unity\Hub\Editor`). The
Hub's settings folder is `~/Library/Application Support/UnityHub` on a Mac and `%APPDATA%\UnityHub` on Windows,
so a Hub whose install location is, say, `C:\Program Files\Unity\Editor` needs no option.

**Load and usage (protocol 4).** Every 15 s the daemon reports its Mac's CPU, RAM, GPU and disk
(`stats`, measured by `server/system.ts` as the portal measures its own host: RAM from `vm_stat` and
memory pressure, the GPU from `ioreg`), and every config `usagePollMinutes` (default 15; [accounts.md](accounts.md#how-often)) the plan
usage of the Mac's own Claude login (`usage`, the same promptless usage request the portal makes, with
no token in its environment). The portal keeps the load in memory only (not in state.json) and drops
it when the machine goes offline; the sidebar footer and `system_status` show every machine. The usage
becomes one of the accounts in the usage meters, merged by email with the same login elsewhere. A
daemon from before protocol 4 sends neither; the machine shows "no numbers yet" until the usual
redeploy of outdated daemons updates it.

**Versions.** A deploy stamps the daemon with the portal's commit (`machine/VERSION`); its hello reports
it, with the protocol number and the tools it can serve. A daemon from another commit or protocol is
outdated (`MachineManager.outdated`): after an app update that is every Mac. The portal redeploys an
outdated daemon by itself as soon as no agent runs there (checked on its hello and every 30 s, at most
every 10 minutes per machine) and tells the orchestrator. Meanwhile a new agent there is refused with
"<id>'s daemon is outdated (...); redeploying it now. Try again in a few minutes." Agents already
running carry on. After an app update, agents on a Mac are resumed only once its daemon is connected and
current (`whenCurrent`, up to 12 minutes); the orchestrator gets a `[machines]` line saying which ones
resumed. The daemon also leaves out any MCP tool its own code does not know, so a newer portal cannot
crash an older daemon's launch.

## Windows machines

A Windows PC is a machine like a Mac: same daemon, same protocol, same guard, same tools. `add_machine`
finds out over ssh which OS it is talking to (`detectPlatform` in `server/machineDeploy.ts`: `uname -s`
answers on a Mac; on Windows, PowerShell does) and records it (`platform`, also reported in the daemon's
hello). `list_machines`, the sidebar and the machine page show it.

**How the portal talks to it.** Windows OpenSSH Server hands a command to its default shell, cmd.exe or
PowerShell, and the two quote differently. So the command line is only
`powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand <base64>` (the same under
either shell), a small bootstrap that reads the real script from stdin as UTF-8 up to a `#FFEND` line and runs
it (`server/machineDeployWin.ts`). It never waits for EOF on stdin: on some PCs (Windows 11, cmd.exe as the default
shell) that read never returns once a few KB came in, and stdin through sshd stalls altogether after ~200 KB. So
the code bundle goes by `scp` into the user's home, and the upload script unpacks and deletes it. Nothing
depends on which default shell is set.

**What a deploy does** (all in `%USERPROFILE%\.ff-factory`, the same folder as on a Mac, or in the machine's
`app_dir`, e.g. `D:\work\.ff-factory` on a PC with several drives; see "A machine's own folders" above):

1. Probe: the user's SID and home, the newest node (the PATH, then nodejs.org, nvm-windows, Volta, fnm and
   Scoop installs), Claude Code's native `claude.exe` (an npm `claude.cmd` shim cannot be started by the Agent
   SDK, which then uses its own bundled Claude Code), git, System32's `tar.exe`, whether the user is logged on,
   and the game clone: a clone of config `repo.url` under the home folder (3 levels deep, not AppData) or
   near the top of any fixed drive (2 levels, e.g. `D:\FinalFactory` or `D:\dev\FinalFactory`).
2. Copy the portal's code (the same `git archive` of `server/ shared/ machine/ package*.json`, as a .tar.gz)
   into `app.new`, unpacked with System32's tar; `npm ci --omit=dev` with that node's own npm.
3. Stop the old daemon, `app` → `app.old`, `app.new` → `app`, write `daemon.json` (portal URL, id, token,
   repo path, claude path, the folder options) and `run-daemon.ps1`, register the **`FFFactoryDaemon`**
   scheduled task (its action and working folder in the daemon's folder) and start it. The stop looks for a
   daemon running from the daemon's folder, the default one and the previous deploy's `app_dir`, so moving the
   folder does not leave the old daemon running.

**What runs it.** The task starts at logon of that user (trigger and principal by SID), in their interactive
session (the Claude login, the GPU and the desktop Unity needs), not elevated (`LeastPrivilege`), at normal
priority (a task's default 7 would give every agent and Unity below-normal CPU, I/O and memory priority), with
no time limit and no battery or idle conditions. Its action is `powershell.exe -WindowStyle Hidden -File
run-daemon.ps1`, a supervisor like the portal's own `scripts/supervise.ps1`: it starts
`node machine/daemon.ts <daemon.json>` hidden, and again whenever it exits (10 s, doubling up to 5 minutes
while it keeps dying within 5 minutes). Its output is in `logs\daemon.log` and `daemon.err.log` in its folder
(the previous run's in `*.prev`), the supervisor's own lines in `supervisor.log`. Task Scheduler restarts the
supervisor itself if it fails.

**Start, stop, restart.** `machine_daemon` (orchestrator tool, and Restart/Start on the machine page) runs
over ssh: stop disables the task, ends it, kills the supervisor and the daemon with everything they started
(agents and their shells, but never a Unity editor or Unity Hub, which outlive a daemon restart as on a Mac),
and enables the task again, so it starts at the next logon; start runs the task. Stop and restart are refused
while agents run there unless forced, as is a redeploy; a daemon stopped this way is left alone by the
offline redeploy until it is started or redeployed. On a Mac the same tool unloads, loads or kickstarts the
LaunchAgent. `remove_machine` stops the daemon and deletes the task; the files stay.

**Only while someone is logged on.** The daemon lives in the user's session: it starts when they log on
(a locked screen is fine) and stops when they log off. After a reboot (Windows Update) it is back once they
log on again. A deploy while nobody is logged on installs everything and says so: the machine shows
"installed, but nobody is logged on".

**On the machine.** The daemon is the same code as on a Mac, with these differences:

- **Awake**: while any agent runs it holds `SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)`
  from a hidden PowerShell that waits on the daemon's pid (so a crashed daemon cannot keep the PC awake).
  The display may still turn off; set sleep to never anyway (below).
- **Load**: `server/system.ts` as on the BEAST host: CPU, RAM, disk, and the GPU: through `nvidia-smi` when it is
  there, else (an Intel or AMD card) from Windows' own performance counters, `\GPU Engine(*)\Utilization Percentage`
  (the busiest engine, summed over the processes using it, as Task Manager shows it) and `\GPU Adapter
  Memory(*)\Dedicated Usage`, read with Get-Counter (their CIM classes on a Windows whose counter names are
  localized), with the adapter's name and memory from the registry (`WIN_GPU_SCRIPT`, `parseWinGpu`).
- **Unity**: the `unity` tool and the hang/crash watch work as on a Mac (`machine/unity.ts` with platform
  win32): the editor is `Unity.exe` with `-projectPath` of the clone, found as above ("Finding Unity":
  `unity_path`, `unity_editor_root`, the editors the Hub lists, its chosen install location, Program Files); its
  log is
  `%LOCALAPPDATA%\Unity\Editor\Editor.log`. The editor is launched through `Start-Process` so that it is
  nobody's child and outlives a daemon restart. The dialog watch reads and presses Unity's windows with
  `scripts/unity-windows.ps1`, as the host's does ([unity-dialogs.md](unity-dialogs.md#macs)). No App Nap.
- **Guard**: the same rules. Killing `node.exe` or `claude.exe`, and ending, changing or deleting the
  `FFFactoryDaemon` task (`schtasks /End|/Change|/Delete`, `Stop-/Disable-/Unregister-/Set-ScheduledTask`) are
  refused; Unity, Unity Hub and crash handlers are fine to kill. The daemon's folder (`.ff-factory`, or the
  `app_dir`) is protected in every spelling (`C:\Users\x\.ff-factory`, `~/.ff-factory`, `%USERPROFILE%`,
  `$env:USERPROFILE`, Git Bash's `/c/Users/...`; `D:\work\.ff-factory`, `D:/work/...`, `/d/work/...`). The backup-before-discard rule is the same, into `ff-local-backups` beside the clone (e.g.
  `D:\ff-local-backups\<time>\`); the recipe is a Git Bash line that copies the changed and untracked files
  with tar, since Git Bash has no rsync.

### Setting up a Windows PC (for its owner)

Once, on the PC, as the user whose desktop the agents should run in. Commands are for an **administrator**
PowerShell unless it says otherwise.

1. **Tailscale.** Install it from tailscale.com and sign in. The portal host (BEAST) must reach the PC over
   the tailnet: either join Ben's tailnet (Ben sends an invite), or keep your own tailnet and share the
   machine with Ben (admin console → the machine → Share). Nothing is needed the other way: the daemon reaches
   the portal at its public URL.
2. **OpenSSH Server**, started now and at every boot:

   ```powershell
   Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
   Set-Service -Name sshd -StartupType Automatic
   Start-Service sshd
   # Recommended: PowerShell as the ssh shell (cmd.exe, the default, works too).
   New-ItemProperty -Path 'HKLM:\SOFTWARE\OpenSSH' -Name DefaultShell -Value 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -PropertyType String -Force
   ```

   The installer adds a firewall rule for port 22 (`Get-NetFirewallRule -Name OpenSSH-Server-In-TCP`).
3. **BEAST's public key.** Ben sends the one-line public key of the portal host (its `id_ed25519.pub`).
   Where it goes depends on your account, which is the quirk to watch for: **for a member of the
   Administrators group, OpenSSH ignores `~\.ssh\authorized_keys`** and reads only
   `C:\ProgramData\ssh\administrators_authorized_keys`, which must be writable by Administrators and SYSTEM
   only:

   ```powershell
   # An administrator account:
   Add-Content -Path C:\ProgramData\ssh\administrators_authorized_keys -Value '<the key Ben sent>'
   icacls.exe C:\ProgramData\ssh\administrators_authorized_keys /inheritance:r /grant 'Administrators:F' /grant 'SYSTEM:F'
   # A standard account instead (in that user's own, non-admin PowerShell):
   New-Item -ItemType Directory -Force $env:USERPROFILE\.ssh | Out-Null
   Add-Content -Path $env:USERPROFILE\.ssh\authorized_keys -Value '<the key Ben sent>'
   ```

   Your ssh user name is what `whoami` prints after the backslash (with a Microsoft account, the local
   account name, usually your folder under `C:\Users`).
4. **Tools**, then log in to Claude Code and clone the game, in a normal (not administrator) terminal:

   ```powershell
   winget install OpenJS.NodeJS.LTS      # node 22.6 or newer
   winget install Git.Git                # git and Git Bash (Claude Code needs it); includes git-lfs
   irm https://claude.ai/install.ps1 | iex   # Claude Code, the native claude.exe
   # A new terminal, then:
   claude                                 # log in once, then /exit
   git lfs install
   git clone https://github.com/Final-Factory/FinalFactory.git D:\FinalFactory   # or under your home folder
   ```

   Clone from a normal terminal: a clone made from an administrator one is owned by Administrators, and git
   in the (non-elevated) daemon then refuses it as "dubious ownership". For Unity work, install Unity Hub and
   the project's Unity version (ProjectSettings\ProjectVersion.txt) in the Hub's default or chosen folder
   (the daemon reads the Hub's choice). Unity installed elsewhere, or files on another drive: give `add_machine`
   `unity_editor_root` or `unity_path`, `app_dir` and `temp_dir` (above).
5. **Never sleep** while plugged in, and stay logged on (locking the screen is fine):

   ```powershell
   powercfg /change standby-timeout-ac 0
   powercfg /change hibernate-timeout-ac 0
   ```

6. **Tell Ben** the PC's Tailscale name as it appears in his tailnet (the MagicDNS name, or its 100.x
   address), your ssh user name, and a short machine id (letters, digits and dashes; it is stored lower-case
   and shown as you wrote it, e.g. `LothDesktop`).

Then Ben, on the portal host, adds an ssh alias and checks it answers without a password:

```text
# ~/.ssh/config on BEAST
Host lothdesktop
  HostName <the Tailscale name or 100.x address>
  User <the ssh user name>
```

`ssh lothdesktop exit 0` must return at once. Then `add_machine` with `id: LothDesktop` and
`ssh_host: lothdesktop` (or the Add button in the sidebar) does the rest; `list_machines` shows the progress.

## Machine sandboxes

A machine with a `sandbox_root` holds a pool of sandboxes, as the host does: each a **git worktree of the
machine's main clone** (`repo_path`) at `<sandbox_root>/<name>`, on its own branch, with its own `Library` and at
most one Unity editor. The folder name is also the Unity project name, so the editor's MCP instance is
`<name>@<hash>`, which the guard pins its agents to. They are addressed as `<machine>/<name>`, e.g.
`lothdesktop/sb1`. The daemon does the work (`machine/sandboxes.ts`, `SandboxPool`); the portal keeps the labels
and agents and shows what the daemon reports.

**Settings** (`add_machine`, kept on the record and in `daemon.json`, and sent to the daemon in every `welcome`, so a
change applies on the next reconnect; omitted on a redeploy: kept):

| Option | What | Default |
|---|---|---|
| `sandbox_root` | Absolute folder for the sandboxes, e.g. `D:\work\ffsb`; unset: no sandboxes. Moving it is refused while sandboxes exist. | none |
| `max_sandboxes` | Sandboxes that may exist at once | 3 |
| `max_agents_per_sandbox` | Agents that may be mid-turn at once in one sandbox (apart from `max_agents`, the main clone's); idle ones take no slot, and a message past it is queued | 2 |
| `max_unity` | Sandbox editors that may run at once (the main clone's editor is not counted) | 2 |
| `disk_warn_gb` | Below this many GB free on the sandbox volume: no new sandboxes, no new sandbox editors | 50 |
| `disk_critical_gb` | Below this: idle sandbox editors stop, and agents mid-turn in sandboxes are asked to commit, push and end their turn | 20 |

LothDesktop, for example: `sandbox_root: "D:\work\ffsb"`, `max_sandboxes: 3`, `max_agents_per_sandbox: 2` (six
sandbox agents in all), `max_unity: 2`.

**Tools.** The host's sandbox tools take a machine:

- `create_sandbox {name, purpose, machine: "lothdesktop", branch?, base?, start_unity?, seed_library?}`: returns once
  the daemon has recorded it; the fetch, `git worktree add --no-checkout`, checkout and Library copy go on in the
  background (`list_sandboxes` shows the step), and `start_agent` can be called at once: the prompt waits until
  the sandbox is ready. The branch defaults to `sandbox/<name>`; an existing local or remote branch is checked out
  (tracking origin); never master, main or develop.
- `set_sandbox_label {sandbox: "lothdesktop/sb1", purpose}`, `delete_sandbox {sandbox: "lothdesktop/sb1", user_asked}`
  (stops its agents and editor, removes the Library, the worktree and the folder; the branch stays),
  `unity {sandbox: "lothdesktop/sb1", action}` (status, start, stop, restart, log), `start_agent {sandbox:
  "lothdesktop/sb1", prompt, ...}`, `switch_branch {sandbox: "lothdesktop/sb1", branch}` (refused while its editor
  runs: stop it first, or Unity stops on "The open scene(s) have been modified externally"; and while another agent
  in it is mid-turn, named by title. The portal checks, then the daemon again with what it runs (`othersMidTurn` in
  `server/sessions.ts`); neither counts the worker calling it, nor a "running" left by an agent whose process is gone,
  which the portal clears, w422).
- `list_sandboxes` shows this host's sandboxes and then each machine's, grouped, with each group's limits and free
  count, one line per sandbox (a **FREE** flag when it is ready, labelled unused and has no live agent) and only
  its live agents. An offline machine's sandboxes show as last reported.

**Agents in a machine sandbox** get their own brief (the worktree, their editor's instance name) and the `machine`
tools `set_label` (the sandbox's label), `wake_me`, `unity` (their sandbox's editor) and `switch_branch`. Their guard
is the sandbox one, not the main clone's backup rules: their worktree is theirs, the main clone and the daemon's
folder are protected, killing Unity by hand is refused (other sandboxes' editors share the machine), and a raw
`git switch` is refused while their editor runs.

**Warm Library.** A new sandbox's `Library` is copied from the main clone's, or, when that is empty (a clone that never
opened Unity), from a ready sandbox's, preferring one whose editor is stopped: robocopy on Windows, an APFS clone
(`cp -c`) on a Mac. It needs `disk_warn_gb` + 30 GB free first. `seed_library: false` skips it.

**The first start after a Library copy reimports the scripts.** A Library copied from another project path keeps
stale script-to-class mappings: on LothDesktop's first sandboxes URP renderer features loaded as missing, the player
build crashed in the shader step and the FMOD settings were dropped. So after the copy the pool drops a one-time
editor script into the sandbox (`Assets/__FFFactoryReimport/Editor`, `machine/scriptReimport.ts`): at the first
editor start it force-reimports every `.cs`, `.asmdef` and `.asmref` under `Assets`, then deletes its folder. The
folder is in the repo's `info/exclude`, so it never shows in `git status` or a commit. If the project does not
compile the script cannot run; it stays and runs at the next start that compiles.

**Editors.** Each sandbox editor logs to its own `Logs/sandbox-editor.log` in the worktree (`-logFile`; the previous
run's kept as `sandbox-editor-<time>.log`, the newest three), so its hang and crash watch (the same `MacUnityWatch` as
the main clone's) reads its own log, not the shared `Editor.log`. The daemon looks every 30 s: the editor's state
(starting until its MCP bridge is up), the watch (a hung or crashed editor restarted, at most 3 in 30 minutes, and
its agents told), git status every 2 minutes, the disk guard, and the idle stop (an editor with no agent activity
there for 2 hours, and no agent mid-turn, is stopped; `daemon.json` `sandboxIdleStopMinutes`).

**Where things live.** `<app_dir>/sandboxes.json` keeps the pool across daemon restarts (a create or delete cut off
by one shows as an error: delete it again). The portal keeps each sandbox (daemon facts plus purpose and agents) on
the machine record (`sandboxes`). Git operations on the main clone's repository (fetch, worktree add and remove, the
main clone's own branch switch) take one lock in the daemon.

**In the web UI.** The sidebar groups everything by computer: this host, then each machine, each a collapsible group
whose header shows its load and `sandboxes/max_sandboxes · editors/max_unity`, then one row per sandbox (label, branch,
editor, a **FREE** badge) with its live agents under it, then the machine's main clone and its agents. The Overview
page (`#/overview`) shows the same as one card per computer. A machine sandbox has its own page,
`#/machine/<machine>/sandbox/<id>`: its agents as tabs, its editor (start, stop, the log read through the daemon), its
git state and a branch switch (`POST /api/machines/<machine>/sandboxes/<id>/unity`, `GET …/unity-log`,
`POST …/switch-branch`). The machine's own page keeps its main-clone agents.

![The sidebar grouped by computer](images/fleet-sidebar-desktop-chromium.png)
![The Overview board](images/fleet-overview-desktop-chromium.png)

**Unity MCP.** Every agent on a machine, in its main clone or in a sandbox, gets the Unity MCP bridge of its own
editor as `UnityMCP`: the portal marks the launch spec `unityMcp`, and the daemon adds the MCP-for-Unity server
(`machine/unityMcp.ts`). Claude Code registers that server per project folder, so a fresh worktree would otherwise have
none (LothDesktop's sandbox agents fell back to Unity on the command line). The command is `daemon.json`
`unityMcpServer` when set, else the `UnityMCP` entry the machine's own Claude Code has in `~/.claude.json`: the main
clone's, then a user-wide one, then the one most of its projects use. Each agent's server gets its place's own
`UNITY_MCP_STATUS_DIR` (`<app_dir>/unity-mcp/<sandbox>`, or `_main-clone`), which the daemon keeps every 5 s holding
only that editor's status file from `~/.unity-mcp` (and a fallback port file pointing at its port, 0 while it is
down), as the host does for its sandboxes (`server/unityMcp.ts`). So a pinned agent never lands on another sandbox's
editor while its own restarts. A status file counts only if written since that editor started (for an editor already
running at the daemon's first look, any age). The daemon logs the command it found, or that there is none, at start.

**Protocol 5.** The `welcome` carries the pool settings; `sandbox` messages (create, delete, log), a `sandbox` field
on `switch` and `unity`, and the daemon's `sandboxes` snapshots, `sandbox_result` and `sandbox_event` (the disk guard,
an idle editor stopped). A protocol-4 daemon would ignore the `sandbox` field and act on the main clone, so the
portal never sends it one: it says the daemon is being redeployed.

## The portal's own host as a machine

`add_machine {id: "BEAST", local: true}` runs a daemon on the portal's own computer, deployed and controlled without
ssh, which takes over the host's sandboxes (`migrate_host_sandboxes` moves the existing ones in place; `back` undoes
it). Its settings default to the portal's config. Protocol 6 adds the `adopt`/`release` sandbox ops and the pool's
total agent cap, Library seed, below-normal editors and protected paths. Everything about it, with the migration,
rollback and deploy steps: [beast-machine.md](beast-machine.md).

## Not in v1

Machines other than Macs and Windows PCs.
