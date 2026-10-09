# Restarting and updating the app

One command, from any shell, admin or not, at the desktop or over SSH:

```
scripts\restart.cmd                  # double-click works too
scripts\restart.ps1 -Update          # pull, npm ci (root and web), rebuild the web UI, then restart
scripts\restart.ps1 -NoDrain         # restart at once
scripts\restart.ps1 -DrainMinutes 3
```

`scripts\update.ps1` is `restart.ps1 -Update`. Without the user at the desktop, the orchestrator's
`request_app_update` tool takes the same path (drain, update, restart, resume).

On a **macOS host** (`config.example.mac.json`):

```
scripts/mac/restart.sh                   # drain, restart, resume
scripts/mac/restart.sh --update          # pull, npm ci, npm run build, health-check, restart; rolls back on failure
scripts/mac/restart.sh --no-drain
scripts/mac/restart.sh --drain-minutes 3
```

`request_app_update` works on both: it picks the supervisor by platform (`supervisorFor`, `server/restart.ts`) and
refuses with the manual steps when none is running. [macOS](#macos-the-node-supervisor) below says what differs.

## What happens

1. **Drain.** The script writes a JSON `data\restart.request`. The server sends every busy worker a
   `[app restart pending]` message: commit and push your work (a WIP commit is fine) and end your
   turn. It waits until no worker is mid-turn, or until `-DrainMinutes` (default 10) passes. With
   nobody busy it goes straight on. The orchestrator and standing agents are not waited for. The
   dashboard shows a "Restart pending" banner meanwhile. The supervisor keeps running during the
   drain; if the script is interrupted, the server gives up after 5 more minutes, tells the drained
   workers to carry on, and nothing is lost.
2. **Stop.** The script stops the supervisor, then asks the server to stop. The server writes
   `data\resume.json` (below), stops the agent processes, saves state and exits. Unity editors keep
   running.
3. **Update** (with `-Update`). The script leaves `data\update.request`. The next supervisor runs
   `update-steps.ps1` before starting node, and writes the outcome to `data\update.result.json`.
   It fast-forwards. If the upstream has a new, unrelated history (republished) or was rewritten
   (e.g. commit identities cleaned), it moves to it only when nothing would be lost: no modified
   tracked files and, for a rewrite, no local commit without an equivalent upstream and this tree in
   the upstream's history. The old HEAD stays on a `pre-republish-*` / `pre-rewrite-*` branch.
   Otherwise the update stops with the reason. Note that it runs the `update-steps.ps1` already on
   disk: a change to it takes effect from the update after the one that brings it.
4. **Start**, always through the Limited `ffsb-server` task (`schtasks /run /tn ffsb-server`),
   never from the calling shell, so the app cannot inherit admin rights. If the task is missing or
   does not start a supervisor within 60 s, the script starts the supervisor directly. From an
   elevated shell that app runs elevated: it refuses to start Unity and shows a banner.
5. **Resume.** The new server reads `data\resume.json` (renamed to `resume.done.json` first, so it
   is used once) and sends each listed worker:
   > The app restarted (update at …). Your process was stopped; the worktree, the Unity editor and
   > your history are intact. Check git status for half-written edits, re-pin your Unity instance,
   > and continue where you left off.

   plus any messages it had not answered yet. It then sends the orchestrator one `[app restarted]`
   paragraph: the version before and after ("Version 0.1.0 → 0.2.0."), who was resumed, who could
   not be (and why), the update result, and whether the code changed.

The script logs to `data\supervisor.log` and waits for the new server (3 min, or 20 with
`-Update`). It is safe to run twice: a second run while one is in progress exits at once, and a run
with nothing running just starts the app.

**Agents on machines** (a Mac, a Windows PC, this host's own daemon) are drained and stopped like this host's today.
Config `machines.keepAgentsOnRestart: true` (backlog step 2, off until the host's own daemon has proven itself) leaves
them running instead: no drain message, no stop, and after the restart the ones still running are reported as such
([beast-machine.md](beast-machine.md#backlog-step-2-prepared-off)).

## Who is resumed

`collectResume` in `server/restart.ts` (tests in `restart.test.ts`):

- **Workers** that were mid-turn (running, starting, or waiting for a permission answer), had
  messages no finished turn had answered, were asked by the drain to pause, or had background tasks
  (a background command, a watcher meant to wake them) that the restart ends. The last are told so,
  to run again or re-arm what still matters.
- **Idle workers stay idle.** One waiting on a `wake_me` keeps it (below) and is named in the `[app restarted]`
  report, "Between turns, waiting on their wake_me", with its machine or sandbox and when it fires
  (`waitingOnWakeLine`). Before w311 the report left such a worker out entirely, so a worker between turns of a long
  measurement (f6b32781 on lothdesktop/pr-fix, 2026-10-03: turn ended 21:46:53, restart 22:04:30, wake fired on time
  22:07:36) looked stopped and forgotten.
- **Workers stopped or interrupted on purpose** (by a person or the orchestrator, since their last
  message) are never resumed, even with messages they had not answered or a drain request.

"Mid-turn" is not only the live status. Each session also keeps `turnOpenSince` and
`backgroundTasks` in `state.json`, saved at once: set when a message opens a turn (or a background
task starts), cleared when the turn ends or the session is stopped or interrupted on purpose. A
process that ends by itself keeps them for a minute (`restartMarks.graceMs`): agent processes can
end a moment before the server does (a console close or a process-tree stop reaches them first), and
their status then reads "stopped" or "error". If the server is still up after that minute, the
process ended on its own and nothing is left to resume. The restart clears the marks once it has
resumed a session or decided not to.
- **Standing agents** are left to their scheduler; an interrupted run is recorded as interrupted
  and the schedule continues.
- **The orchestrator** is not resumed as such; the summary message wakes it, and says so if it was
  mid-turn itself.

The drain's own message is left out of the "unanswered" list. A resumed worker still reports its
turns to the orchestrator if its interrupted turn came from the orchestrator.

Without a clean stop (a power cut, a crash, or a kill after the 60 s grace) there is no resume file,
so the new server makes one from what the last server left (`Agents.uncleanResumeFile`):
- **The cause.** The server writes a heartbeat (`alive.json`) every 30 s. If the machine booted after
  the last beat, it went down ("BEAST went down unexpectedly (lost power, was hard-reset or crashed)
  after <time>, and booted again at <time>"). Otherwise only the server stopped (a crash or a kill).
- **Sessions to resume:** the workers that were mid-turn (by status or by their marks) or waiting on
  background tasks, on this host and on the Macs.
- **Editors:** the editors that were up and died with it (`SandboxManager.lostEditors`).

Then it brings things back in order. It waits (up to 15 minutes) for the sandbox drive, which a
reboot leaves detached until `ffsb-helper-mount` runs (docs/self-recovery.md). Next it starts those
editors again, then resumes the agents. Each agent's message says what happened and whether its
editor is being started again. Agents on a Mac resume once its daemon is connected and current; one
whose process kept running on the Mac is left alone. The orchestrator gets one paragraph, starting
"FF Factory restarted WITHOUT a clean stop: …".

An update asked for with `request_app_update` is kept in `restart.pending.json` until the server
hands it to the supervisor. If the stop came during the drain, the update is retried: the new server
writes the resume file and `update.request` and exits, the supervisor updates, and the updated
server resumes everything.

**Pending `wake_me` wakes** (workers' and the orchestrator's) are kept in `data/wakes.json` and re-armed
at startup, after a clean restart or a crash alike (`Waker.restore`). One whose time passed while the
server was down fires at once and says how late it is. A wake that cannot start its agent (the agent
limit, the host guard) is retried once a minute, ten times, before the transcript says it failed.

Crash-loop guard: a second unclean stop within 30 minutes (`unclean-recovery.last`) only reports what
was cut off, as before. It does not resume, restart or retry anything.

## Never elevated

Everything the server starts inherits its token: agent shells, and every Unity editor. An elevated
editor stops on Unity's "running as administrator" dialog ([unity-dialogs.md](unity-dialogs.md)).
Layers that keep the app non-elevated:

- `restart.ps1` always starts through the Limited task. `start-server.ps1` run from an elevated
  shell hands over to `restart.ps1`. `supervise.ps1` started elevated runs the task and exits.
- **The server checks at startup** (`server/elevation.ts`: `whoami /groups`, high integrity or an
  enabled Administrators group). If it is elevated, supervised, and a Limited task exists, it starts
  `restart.ps1 -NoDrain` detached, waits for it to stop the supervisor, and exits. The task then
  brings up a fresh non-elevated supervisor and server. If it cannot hand off (no task, a task at
  RunLevel Highest, no supervisor, `FFSB_NO_DEELEVATE` set, or a hand-off tried within 15 minutes),
  it keeps running but refuses to start Unity. The refusal shows on the sandbox card, in a dashboard
  banner and in the logs.
- A non-elevated shell cannot stop an elevated app, because it cannot even read its command line.
  `restart.ps1` detects that and says what to do: run `restart.cmd` once as administrator.

Editors started while the app was elevated stay elevated until they are stopped and started again.
A non-elevated server recognises them by their window title, and the card says they run with
administrator rights. It cannot stop them itself; close them on the desktop.

## macOS: the Node supervisor

On a Mac, launchd runs `scripts/supervise.ts` (the LaunchAgent `com.sketchup-factory.server` from
`scripts/mac/install-autostart.sh`: RunAtLoad, KeepAlive, so it survives logout and reboot), and the supervisor runs
`node server/index.ts`. launchd restarts only the supervisor, the supervisor only the server, so the two never fight
over a restart: the server exiting (a restart, an update, a crash) is the supervisor's, with the same back-off as
`supervise.ps1` (3 s doubling to a minute, reset after five healthy minutes). `launchctl kickstart -k`, `bootout` or a
logout sends the supervisor SIGTERM: it stops the server cleanly (SIGTERM, which records `resume.json`) and exits;
launchd waits up to 90 s (`ExitTimeOut`).

Steps 1, 2 and 5 above are the same: `restart.sh` writes the JSON `data/restart.request` and the server drains, stops
and exits. With `update`, the supervisor runs `scripts/supervisor.ts` before starting it again:

1. **Refuse** (nothing changes) when tracked files are modified (after putting back the package files installs may
   rewrite), the branch has no upstream, `git fetch` fails, or the upstream is not a fast-forward of `HEAD` (local
   commits). No republish or rewrite recovery as on Windows: those are Final Factory's, and a refusal says why.
2. Up to date: nothing is installed or rebuilt.
3. `git pull --ff-only`, `npm ci`, `npm run build` (which runs `npm ci` and the build in `web/`).
4. **Health check.** It writes a provisional `update.result.json` (the new server reads it at boot), starts the new
   server and waits up to 3 minutes for `http://127.0.0.1:<port>/api/health` to report the new commit.
5. **Roll back** when the pull, an install, the build or the health check fails: stop the new server if it started,
   `git reset --hard` to the commit it started from (`config.json`, `data/` and other ignored files stay), `npm ci`
   and build it again, and start it. The resume file the stopping server wrote is kept aside and put back, so the
   rolled-back server still resumes the workers that were cut off and tells the orchestrator.

The orchestrator's restart summary says which: `Update OK (a → b)`, `already up to date`, `Update REFUSED, nothing
changed: <why>` or `Update FAILED and was ROLLED BACK: <why>`. Everything is logged in `data/supervisor.log` (with
the server's output in `data/server.out.log` / `server.err.log` and the supervisor's own in `supervisor.out.log`).

The supervisor uses Node built-ins only (`npm ci` replaces `node_modules` while it runs), and like `update-steps.ps1`
the copy already running does the update: a change to it takes effect once the supervisor restarts
(`scripts/mac/install-autostart.sh`, a reboot or `launchctl kickstart -k gui/$(id -u)/com.sketchup-factory.server`).

**First install of the supervisor** (a LaunchAgent from before it runs `server/index.ts` directly, so
`request_app_update` refuses): `git pull --ff-only && npm ci && npm run build && scripts/mac/install-autostart.sh`.
`install-autostart.sh` rewrites the plist and reloads it, which restarts the app once.

## Files in data\

| File | Written by | Meaning |
|---|---|---|
| `restart.request` | scripts, `request_app_update` | empty: stop now. JSON: drain first (`drain`, `drainMinutes`, `reason`, `update`, `hold`) |
| `drain.done` | server | the drain finished; `restart.ps1` may stop the supervisor |
| `resume.json` / `resume.done.json` | server | sessions to resume / the last one used |
| `update.request` | `restart.ps1 -Update`, server | the next supervisor updates first |
| `supervisor.pid`, `server.pid`, `supervisor.log` | supervisor | its process, the server's, and what it did (both OSes) |
| `update.result.json` | supervisor | `ok`, `error`, `headBefore`, `headAfter`, `at`; on macOS also `refused`, `rolledBack`, `upToDate` |
| `alive.json` | server, every 30 s | its last heartbeat: dates an unclean stop, and tells a power cut from a crash |
| `restart.pending.json` | server | an update asked for but not yet handed to the supervisor (retried after an unclean stop) |
| `unclean-recovery.last` | server | when an unclean stop was last recovered from (the crash-loop guard) |
| `deelevate.last` | server | when it last handed itself to the task |
| `restart.lock` | `restart.ps1` | one restart at a time |
| `orchestrator-inbox/*.txt` | local scripts (`republish-public.ps1`) | sent to the orchestrator as a system message within 5 s, then renamed `*.sent` |
| `republish.pid`, `republish/` | `republish-public.ps1` | the running republish; its bare clone of the private repo and the scanned tree |
