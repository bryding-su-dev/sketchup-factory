# SketchUp Factory

A fork of [FF Factory](https://github.com/Final-Factory/ff-factory) that runs on a Mac against the SketchUp repos: see
[Another project, and a macOS host](#another-project-and-a-macos-host). The rest of this file is the upstream guide
with the app's name changed.

[![CI](https://github.com/Final-Factory/ff-factory/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Final-Factory/ff-factory/actions/workflows/ci.yml)

A self-hosted web portal for running many [Claude Code](https://code.claude.com) agents in parallel
on a Unity project. Each work stream gets its own git worktree, its own Unity editor on the real GPU
and its own agents (built on the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk)), all
driven from a chat-first web page that works on a phone.

It was built for the development of Final Factory,
a Unity 6 DOTS game, and it shows: the prompts, the guard rules and some defaults assume that
project's repo layout, branches (`develop` as the integration branch) and agent plugins. The
pieces are general (worktree sandboxes, editor lifecycle and dialog watchdog, the Unity MCP bridge,
agent sessions with a guard hook, standing agents, remote machines, push notifications, local
voice input), and adapting it to another Unity project is mostly editing prompts in
`server/agents.ts` and `config.json`. It is published as-is; see [Status](#status).

**What you need:** a Windows PC with a GPU for the host (Unity editors run on its desktop), Node
≥ 23.6, git with LFS, Unity, a Claude subscription or API access, and optionally
[Tailscale](https://tailscale.com) to reach it from elsewhere. macOS machines can be added as extra
agent hosts.

You talk to your own **orchestrator** on the main page ("start work on spec 098", "play the tutorial
single-player and log the bugs", "read the Discord forums and find bugs"). It files the work with the
**dispatcher**, which checks it against what everyone else has in flight, creates sandboxes, starts
editors, launches **worker** agents with a full brief, and reports back when they finish
([docs/orchestrators.md](docs/orchestrators.md)).
Everything it does is also a button: the sidebar lists every sandbox, and opening one shows its
agents' live transcripts, where you can type to them directly, interrupt them, approve their tool
requests and start or stop Unity.

## How it works

| piece | what it is |
|---|---|
| sandbox | `git worktree` of a base clone at `<sandboxRoot>/<id>`, on its own branch, with a copy of a warm `Library/` so Unity starts without a cold import. The folder name is the Unity project name, so its editor's MCP instance is `<id>@<hash>` |
| Unity | launched natively (`Unity.exe -projectPath …`) so it renders on the GPU; the server tracks the pid, proves the pid is still that editor (command line contains the sandbox path) before ever killing it, and marks it running once the MCP bridge logs `StdioBridgeHost started` |
| worker agent | a Claude Code session via the [Agent SDK](https://code.claude.com/docs/en/agent-sdk), `cwd` = the sandbox, loading user + project settings (so CLAUDE.md, the ff-agents/ff-speckit/ff-discord plugins and the Unity MCP server all apply), with a sandbox brief appended to the system prompt and a `sandbox` MCP server: `mcp__sandbox__unity` to manage its own editor and `mcp__sandbox__set_label` to relabel its own sandbox |
| orchestrator | another Agent SDK session with read-only repo tools and an in-process `sandboxes` MCP server. Each person has their own, which sees everything, follows up with that person's workers and files work requests; one **dispatcher** has the tools that change things (create/delete/relabel sandbox, start/stop Unity, start/message/interrupt/stop agents, machines, standing agents) and turns the requests into work without doing the same work twice, recording each in the work ledger. See [docs/orchestrators.md](docs/orchestrators.md) |
| standing agent | a long-lived agent with a charter and a schedule (interval, cron or manual), apart from the sandboxes: its own folder under `<sandboxRoot>/_agents` with a `NOTES.md`, one conversation resumed every run, a fresh process per run that stops when the turn ends (so it only holds an agent slot while running), and hard per-run and per-day budgets. Read-only by default; tool groups add a read-only shell, GitHub comments, or delegation requests that the user approves. See [docs/standing-agents.md](docs/standing-agents.md) |
| machine | one of the user's Macs or Windows PCs. A daemon there (`machine/daemon.ts`: a LaunchAgent on a Mac, a scheduled task at logon on Windows, in the user's session) connects out to `/machine` with a per-machine token and runs agents in the user's main clone with the same session code, streaming everything back. Set up and updated over ssh from this host by `add_machine` / the Add button; no sandboxes, own agent limit, extra guard rules for the user's uncommitted work. See [docs/machines.md](docs/machines.md). This host itself can be one too (`add_machine local`), whose daemon then owns the host's sandboxes: [docs/beast-machine.md](docs/beast-machine.md) |
| provider | FFBox, Lothsahn's CPU-only build server, which runs agents in its own hardened containers ([docs/ffbox.md](docs/ffbox.md): what it is, how it works, and how workers change it). Its connector dials out to `/provider` with a token whose SHA-256 is in `config.json`, and reports its container classes (network, model, tier, free slots), its conversations and the crash/desync reports its intake files. Phase 1 is read-only: a card in the sidebar, a page, the orchestrator's `ffbox_activity` tool, nothing that sends it work. Off unless `providers.ffbox.enabled`. See [docs/ffbox-integration.md](docs/ffbox-integration.md) and, for the connector's author, [docs/ffbox-connector-contract.md](docs/ffbox-connector-contract.md) |
| Max | the Discord bot agents post as, read-only. Each `ffdiscord` post, reply, thread or close by an agent SketchUp Factory started is appended to the file in its `FF_MAX_EVENTS` (a Mac's daemon forwards its own), so the Max page lists them with channel, link, first line and session; it also checks the bot token (read from the ffbox config where it already is, never copied) and, optionally, shows the newest messages in a few channels with unread counts. An "External" strip in the sidebar shows Max and FFBox at a glance; the orchestrator has `max_activity`. See [docs/max.md](docs/max.md) |
| intake | Discord and FFBox into the work ledger, off by default: new #bug-reports threads, trusted people's requests to Max in #dev-chat (by Discord author id), FFBox's fix branches and requests. Each carries its source and a fixed-code triage: an obvious bug may be worked without a person (when auto-approve is on); anything else needs a human, and nothing is worked until Ben or Lothsahn approves it. Deduplicated against open and finished work, capped per day, players' text fenced off as untrusted; workers end with a marker, reply in and close the thread, and a release follow-up says "live in 0.50.0.X". The Dispatcher page's Intake tab, `list_work` and the heartbeat show it. See [docs/intake.md](docs/intake.md) |
| guard | a `PreToolUse` hook on every worker, active even in `bypassPermissions`: no push or PR to the game repo's master/main (other repos' master/main are allowed; an undeterminable target counts as the game repo), no force push, no `gh repo delete`, and `gh repo rename/create/edit/archive` or security-setting changes only on repos other than the game repo (an undeterminable one counts as the game repo), no writes to or shell commands naming a `protectedPaths` entry (the live co-op checkout), and Unity MCP calls only after pinning this sandbox's own editor. Each worker's Unity MCP server sees only its sandbox's editor (docs/unity-lifecycle.md) |
| attachments | files people attach to a message (paperclip, paste or drop): saves, bug-report zips, `Player.log`, desync reports, up to 200 MB each by default, uploaded in chunks that resume over a flaky link. Stored once by SHA-256 in the data folder, never opened or unpacked by the server, deleted after 30 days unused. The orchestrator reads them as untrusted user files with their ids, and passes them on with `request_work`, `start_agent` or `message_agent`; each worker gets its own copy in `Inbox/` of its sandbox (a machine's daemon fetches it there). See [docs/attachments.md](docs/attachments.md) |
| voice | a mic in every message box, and a hands-free voice mode for the car. Speech is transcribed on this machine by Whisper (faster-whisper `large-v3-turbo` on the GPU) primed with FF words and the current sandbox and agent names; an end-of-speech detector with an adaptive noise floor finishes each utterance. Dictation puts the text in the box for review; voice mode sends it, reads the reply aloud with local Kokoro TTS and listens again (barge-in, "stop" to end). Models load on demand and unload when idle; audio is not kept. Browser speech engines are the fallback. See [docs/voice.md](docs/voice.md) |
| state | `data/state.json` (sandboxes + session metadata) and `data/transcripts/<session>.jsonl`. Sessions come back `stopped` after a restart and resume (Claude session id) on the next message |

Workers default to `bypassPermissions` (autonomous, bounded by the guard). Switch a session to
`default` from its panel and every tool call that would prompt shows up as an Allow/Deny card.

## Setup (Windows host)

Needs Node ≥ 23.6 (runs the TypeScript directly), git with LFS, the Unity editor version the
project pins, the final-factory-agents plugins registered, and Claude credentials. An interactive
`claude` login works but its refresh can lapse on an always-on box; prefer `claude setup-token`
(a long-lived token) and put it in `config.json` as
`"claudeEnv": { "CLAUDE_CODE_OAUTH_TOKEN": "…" }`.

```powershell
git clone https://github.com/Final-Factory/ff-factory.git C:\ff-sandboxes
cd C:\ff-sandboxes
npm install
copy config.example.json config.json   # check paths
node server/user.ts <name>             # create a login (prompts for a 12+ char password)
npm run setup                          # base clone at repo.basePath (copies objects from referenceRepo)
npm run build                          # web UI -> web/dist
powershell -File scripts\\install-autostart.ps1   # start at logon, supervised
schtasks /run /tn ffsb-server          # start it now
```

Run it from the **logged-in desktop session** (a Task Scheduler "at log on" task, not a service
and not over SSH): Unity editors it launches must land on the interactive desktop to get the GPU.

### Access and security

The page drives agents that run shell commands on the host, so its login is treated like a shell
login: usernames with scrypt-hashed passwords (`data/users.json`, managed with
`node server/user.ts <name> [--name "Display Name"] [--role owner|member]`, which also changes a
password and signs that user out everywhere),
server-side 30-day sessions (`data/auth-sessions.json`; delete it to sign everyone out),
HttpOnly + SameSite=Strict cookies (Secure over HTTPS), 5 failed logins per IP per 15 minutes,
JSON-only writes (CSRF) and a same-origin check on the WebSocket.

Several people can share one portal, each with their own orchestrator chat. Every message records who wrote
it, and the workers, standing runs and approvals it causes are recorded as requested by that person. A person
can have their own Claude token (`userClaudeEnv`), which the agents they ask for run on. The first login
is the owner. Roles are recorded but not enforced yet. See [docs/identity.md](docs/identity.md).

For access from anywhere, bind to loopback (`"host": "127.0.0.1"`) and publish it with
**Tailscale Funnel**, which terminates TLS with a real certificate and needs no router ports:

```powershell
tailscale funnel --bg 8790        # https://<machine>.<tailnet>.ts.net
tailscale funnel status
tailscale funnel --https=443 off  # take it off the internet again
```

### Notifications and the phone

The bell in the sidebar turns on notifications for that device (Web Push, VAPID keys in
`data/vapid.json`, subscriptions in `data/push-subscriptions.json`): an agent waiting for a
permission, a finished turn, an error, a standing-agent run that failed or hit its budget, a
delegation request, each with its own toggle, plus a test button. On iPhone, Web Push only works for
a Home Screen app: open the Funnel URL in Safari, Share → Add to Home Screen, open SketchUp Factory from
there, then turn notifications on. Without a subscription, an open tab in the background still shows
them.

### Driving it from Claude Code

`/mcp` serves the same tool belt the orchestrator has (sandboxes, Unity, agents, transcripts,
branches, machine stats) plus `ask_orchestrator` (talk to your own orchestrator and wait for its reply)
over MCP Streamable HTTP, authenticated with an API key:

```powershell
node server/apikey.ts my-laptop             # on the host: prints a key once (--revoke <name> to kill it)
```
```bash
claude mcp add --transport http -s user ffsb https://<host>.<tailnet>.ts.net/mcp \
  --header "Authorization: Bearer ffsb_…"
```

Then, in any Claude Code session: "spin up a sandbox for spec 093".

### Running on this host

`scripts/install-autostart.ps1` registers `ffsb-server` to run `scripts/start-server.ps1` at
logon, in the desktop session, at RunLevel Limited. That starts `scripts/supervise.ps1`, which runs
node and restarts it whenever it exits.

To restart or update by hand, run **`scripts\restart.cmd`** (or `scripts\restart.ps1 [-Update]`)
from any shell: it asks busy agents to commit and end their turn, restarts through the Limited
task, and the new server resumes the agents it interrupted. Without anyone at the desktop, the
orchestrator's `request_app_update` tool does the same. Unity editors keep running throughout.
Details: [docs/restart.md](docs/restart.md). The orchestrator's `set_app_config` tool changes the few cosmetic
settings agents may touch (`ownerName`, `voice.vocabulary`, `voice.ttsVoice`); everything else in
`config.json` is edited by hand. `republish_public` publishes this repo with a fresh history:
[docs/republish.md](docs/republish.md).

**Self-recovery.** A host guard watches free disk space, the sandbox Dev Drive and memory: it pauses new
work and cleans known-safe junk when disk space runs low, and reattaches the Dev Drive by itself if
Windows drops it (through SYSTEM helper tasks installed once with
`scripts/install-privileged-helpers.ps1`), then restarts the editors and resumes the agents that were
working there. See [docs/self-recovery.md](docs/self-recovery.md).

The app must never run elevated: everything it starts inherits its token, and an elevated Unity
editor stops at startup on a modal "running as administrator" dialog. An elevated server hands
itself to the Limited task at startup, or (if it cannot) refuses to start editors and shows a
banner. The Unity watchdog reports editors stuck on dialogs and dismisses the known harmless ones:
[docs/unity-dialogs.md](docs/unity-dialogs.md) (hangs, crashes and automatic restarts: [docs/unity-lifecycle.md](docs/unity-lifecycle.md)). Logs: `data/server.{out,err}.log` (previous run:
`*.prev`) and `data/supervisor.log`.

The sidebar's "Claude plan" meters (weekly, 5-hour session, per-model weekly) come from the same
claude.ai usage data as Claude Code's `/usage`: `server/usage.ts` asks a short-lived, promptless CLI
process for it (the Agent SDK's experimental usage request; no model call) at startup and every
config `usagePollMinutes` (default 15); **Refresh usage** under the meters asks at once. Each account says
"as of" when. The orchestrator's `system_status` tool reports the same numbers.

They cover every Claude account in use, each with its own meters: the agents' token
(`claudeEnv.CLAUDE_CODE_OAUTH_TOKEN`, shown as "host token …abcd"), this host's own claude.ai login,
and each machine's own login (its daemon polls it the same way and reports it). Which agents run on
which is set per role and per machine ([docs/accounts.md](docs/accounts.md)): config `claudeAccounts`
puts the orchestrator, workers or standing agents here on this host's login instead of the token, and
`machines.useHostClaudeEnv` puts a Mac's agents on that Mac's login. A login is shown by
its email and one login signed in on several computers is one account; a token by its last 4
characters, never its value. Each account lists where it is used and which agents run on it, and an
agent's details name its account when there is more than one. The collapsed footer shows the
account nearest its weekly limit and how many more there are.

The footer also shows every computer's load: this host, and each machine as its daemon reports it
every 15 s (CPU, RAM, GPU, disk). Alone, the host keeps its numbers (CPU, RAM, VRAM); with machines,
each computer is a name and three mini bars (CPU, RAM, GPU; hover for the numbers), and the open
footer has one row per computer. A Mac's RAM is what Activity Monitor calls Memory Used (app, wired
and compressed memory, from `vm_stat`; plain "total minus free" counts the file cache as used) and
turns amber or red with macOS memory pressure. Its GPU shares that RAM, so its bar is how busy the
GPU is (`ioreg`), not VRAM.

Credentials for the usage meter. Each account is asked with its own credential, and the numbers
are kept per credential. The agents' token is sent straight to `GET /api/oauth/usage` as the only
credential of that request. It does not go through the CLI: given a `CLAUDE_CODE_OAUTH_TOKEN`, the
CLI still answers with the claude.ai login stored on the machine (measured 2026-09-27: a made-up
token got that login's exact numbers). If the token's request fails (rejected, rate-limited, no
network), its meter says "usage unknown" with the reason; it never shows older or other numbers.
The endpoint rate-limits a token for long stretches when many agents run on it (HTTP 429 with a
`Retry-After` of about an hour). Until that passes, the token's weekly and 5-hour numbers come from
the rate-limit headers of one Haiku request with one output token, made with the same token; the meter
says "from rate-limit headers", and per-model limits are missing then. Each poll logs one line per credential (which one, by
its last 4 characters and hash prefix, and whether it answered), never the credential itself.
This host's own login is polled without the agents' token
(and without any API key variable). The CLI then uses the interactive claude.ai login stored on this
machine, `~/.claude/.credentials.json` (or `$CLAUDE_CONFIG_DIR/.credentials.json`; the Keychain on
macOS). A normal `/login` carries `user:inference user:profile user:sessions:claude_code
user:mcp_servers user:file_upload`. Each fetch starts a new CLI process, so it reads the file afresh
and picks up refreshes made by any other `claude` run. When the access token has expired, the CLI
refreshes it with the refresh token and writes it back, as any `claude` run would. The app itself
reads only the scopes and expiry times from the file. It never reads, logs or sends the token
values. The agents keep their own token.

If that login is missing, lacks `user:profile`, or has expired (refresh token included), the
sidebar shows "unavailable" with the reason, plus SketchUp Factory's own agent spend over 7 days,
labelled as spend. The fix is always the same: on this machine, run `claude` in a terminal and type
`/login` with the claude.ai account.

### Sandbox Dev Drive (optional)

On the reference setup, sandboxes live on `F:`, a dynamically expanding ReFS Dev Drive stored at `C:\ffsb-devdrive.vhdx`,
with the Library seed at `F:\ffsb\_seed\Library` and `"librarySeedCopy": "clone"`. The Windows
copy engine block-clones on ReFS, so each sandbox's 64 GB Library costs almost nothing until its
editor rewrites files (measured: 1.96 GB / 42k files cloned for 0.06 GB; robocopy does not clone).
`scripts\devdrive.ps1 -Create` makes it and registers `ffsb-devdrive-mount` (SYSTEM, at startup);
the supervisor waits for the drive. `hostDiskPaths: ["C:/"]` keeps the free-space check honest,
since the VHDX grows on C:.

### config.json

See `config.example.json` and `server/config.ts` (every field is documented there). The important
ones: `host`, `sandboxRoot` (keep it short: Windows path lengths),
`librarySeed` (a warm `Library/` to copy; on a ReFS Dev Drive the copy is a near-free block clone),
`protectedPaths` (checkouts agents must never touch), `limits` (editors are ~8-12 GB RAM each),
`ownerName` (optional: the name agents' prompts use for you; otherwise they say "the user").
`publicGitIdentity` (optional `name`/`email`/`repos`): repos whose history is public, by default this
app's own origin. Any other GitHub repo that GitHub reports as public counts too (`gh api`, cached;
`server/publicGit.ts`). The guard refuses an agent's push to a public repo when a commit carries an email
that is not a GitHub noreply address or the configured `email`, on the host and on the machines. Worker
agents (sandboxes and machines) also commit as that identity automatically in clones of public repos: their
git gets an `includeIf "hasconfig:remote.*.url:..."` through `GIT_CONFIG_COUNT` for the configured repos and
every public repo of their owners, the game repo's owner and the gh account (git 2.36+; nobody's gitconfig
changes). Without a configured `name`/`email` that identity is the gh account's login and noreply address.

## Another project, and a macOS host

The code knows the project only through `config.json`'s `project` section (name, description, how work lands:
`push` straight to the integration branch or `pull-request` into it) and two Markdown brief files appended to the
workers' and the orchestrators' prompts: [project/README.md](project/README.md). `project/final-factory/` is the
default; `project/sketchup/` runs the SketchUp Assistant frontend. `repo.seedFiles` copies the gitignored local
files a checkout needs (`.env`, certificates) from `repo.referenceRepo` into every new sandbox.

The per-sandbox editor is optional: leave `unity` out (or `unity.editorPath` empty) and sandboxes are plain git
worktrees, the editor controls disappear from the sandbox panel and from the workers' tools, and the briefs say
nothing about Unity. `project.community: false` takes the Discord, FFBox and Max text out of the briefs too.

A Mac can be the host for such a setup (no editors, no Dev Drive): `config.example.mac.json` is a starting point,
`scripts/mac/install-autostart.sh` registers the server as a LaunchAgent (starts at login, restarts when it exits),
`scripts/mac/restart.sh` and `scripts/mac/uninstall-autostart.sh` do what their names say. The remote-machine and
"host as a machine" features stay Windows-host-only.

**Turn the automatic clean-up off on a developer's own computer** (`"hostGuard": { "cleanup": { "enabled": false } }`),
or skip rules by id (`"skipRules": ["xcode-derived", "homebrew-cache"]`). The default rules were written for a
dedicated build box: on macOS they remove Xcode DerivedData older than three days, Homebrew downloads older than
two weeks and similar caches, at startup and every hour, whatever the free space.

## Development

```bash
npm install && npm --prefix web install
FFSB_CONFIG=/path/to/test-config.json npm run dev   # API on :8790 (or config.port)
npm --prefix web run dev                             # Vite on :5173, proxies /api and /ws
npm run typecheck && npm --prefix web run build
```

A throwaway config pointing `repo.url` at a local bare repo and `unity.editorPath` at nothing is
enough to exercise everything except Unity.

Tests (unit and Playwright end to end), releases and the CI checks are described in
[CONTRIBUTING.md](CONTRIBUTING.md). The running version shows in the sidebar footer and at
`GET /api/health` (with `web`, the web UI build it serves: a page open across a deploy reloads itself into it,
[server/webStatic.ts](server/webStatic.ts)); changes are listed in [CHANGELOG.md](CHANGELOG.md).

## Security model

SketchUp Factory gives AI agents a shell on your machine. Treat access to it like SSH access.

- **Who can drive it:** the web login (scrypt-hashed passwords, server-side sessions, rate-limited,
  CSRF- and origin-checked; see [Access and security](#access-and-security)) and API keys for `/mcp`
  (`node server/apikey.ts`, stored hashed). Anyone with either can run arbitrary commands as the
  host's user through an agent.
- **What agents can do:** workers default to `bypassPermissions`. The guard hook (`server/guard.ts`,
  `server/standingGuard.ts`) blocks the known-destructive git operations and paths listed under
  `protectedPaths`, and pins Unity MCP calls to the agent's own editor. It is a seatbelt against
  mistakes, not a sandbox against an agent that is trying (see Known gaps).
- **Secrets on disk:** `config.json` (it may hold a Claude token in `claudeEnv`) and `data/` (users,
  sessions, API keys, VAPID keys, machine tokens, transcripts) are gitignored and stay on the host.
  Transcripts contain whatever the agents saw.
- **Remote machines** connect out to the portal with a per-machine token and run agents as the user
  logged in there.
- **FFBox's connector** connects out to `/provider` with its own token (`ffpv1_…`, minted by
  `node server/providerToken.ts`; only its SHA-256 is kept, and transcripts redact it). It can only
  report data, which is shown as text and never acted on; it is not an `/mcp` key and cannot run
  anything here. `providers.ffbox.enabled` (default false) turns it off at once.
- **Standing agents** can be pointed at untrusted text (issues, Discord). They are read-only by
  default, have per-run and per-day budgets, and anything that writes goes through a delegation
  request that you approve (unless you turn on auto-approve for that agent).

Report vulnerabilities as described in [SECURITY.md](SECURITY.md).

## Known gaps

- **Workers run as the user's Windows user.** The guard is a seatbelt; a hijacked worker (e.g. prompt
  injection via Discord text) could still use `execute_code` or a script file to touch the user's files,
  processes and the co-op checkout, and can read the Claude token in its environment. The real fix,
  tabled 2026-09-23: run workers and sandbox editors as a low-privilege local user (`ffsb`). First
  step is a probe that Unity gets the GPU and a licence under that user (interactive launch via
  `Start-Process -Credential` vs a non-interactive scheduled task; read `Renderer:` and licensing
  lines from the editor log). Then: a fine-grained GitHub token for that user, its own `uv`,
  plugins and Claude login, and the server launching workers/editors as it.
- **Prompt injection.** Text an agent reads (web pages, issues, chat messages, files in the repo)
  can steer it. The guard stops the obvious damage, not a determined attacker.
- **Windows-first.** The host (Unity launch, window watchdog, restart scripts) is Windows-only;
  remote machines are macOS-only (LaunchAgent). Linux is not supported.
- **Tied to one project.** Prompts and guard rules name Final Factory's conventions; see the top of
  this file.
- The Dev Drive VHDX never shrinks on its own; space freed inside `F:` is reused.

## Status

A working tool used daily on one project, shared in case it is useful. It changes often and without
compatibility promises. Issues and pull requests are welcome (see [CONTRIBUTING.md](CONTRIBUTING.md));
answers may be slow.

## License

MIT, see [LICENSE](LICENSE).
