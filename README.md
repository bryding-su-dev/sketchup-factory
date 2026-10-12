# SketchUp Factory

> **Forked from** [Final-Factory/ff-factory](https://github.com/Final-Factory/ff-factory), the Final Factory agent
> factory, adapted for SketchUp. Upstream changes are pulled in periodically.

A self-hosted web portal for running many [Claude Code](https://code.claude.com) agents in parallel on the SketchUp
Assistant frontend ([SketchUp/sketchup-assistant](https://github.com/SketchUp/sketchup-assistant)). Each work stream
gets its own git worktree and its own agents (built on the
[Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk)), all driven from a chat-first web page that works on a
phone. It runs on a Mac; there is no per-sandbox editor, so a sandbox is a plain worktree.

You talk to your own **orchestrator** on the main page ("start work on SKAIF-123", "review the open PRs"). It files the
work with the **dispatcher**, which checks it against what everyone else has in flight, creates sandboxes, launches
**worker** agents with a full brief, and reports back when they finish ([docs/orchestrators.md](docs/orchestrators.md)).
Everything it does is also a button: the sidebar lists every sandbox, and opening one shows its agents' live
transcripts, where you can type to them, interrupt them and approve their tool requests.

**What you need:** a Mac that stays on, Node ≥ 23.6, git, `gh`, a Claude subscription (a claude.ai login) or API
access, and optionally [Tailscale](https://tailscale.com) to reach the portal from elsewhere.

## How it works

| piece | what it is |
|---|---|
| sandbox | a `git worktree` of a base clone of the project repo (`repo.basePath`) at `<sandboxRoot>/<id>`, on its own branch (`sandbox/<id>`), with `repo.seedFiles` (gitignored files such as `.env`) copied in from `repo.referenceRepo`. No editor runs per sandbox |
| worker | a Claude Code session via the Agent SDK, `cwd` = the sandbox, loading user and project settings (so the repo's `CLAUDE.md`, skills and plugins apply), with a sandbox brief (`project/sketchup/worker-brief.md`) appended to the system prompt and a `sandbox` MCP server: `set_label` to relabel its own sandbox, `switch_branch`, `wake_me`. Workers also get Claude Code's `Artifact`, `ArtifactComments` and `ArtifactData` tools and the Claude Docs connector ([docs/accounts.md](docs/accounts.md#artifacts-and-claudeai-connectors)) |
| orchestrator | an Agent SDK session with read-only repo tools and an in-process `sandboxes` MCP server. Each person has their own: it sees everything, follows up with that person's workers, and files work requests. It has timers (`set_timer`, `list_timers`, …) as well as `wake_me` ([docs/orchestrators.md](docs/orchestrators.md#timers)) |
| dispatcher | the one orchestrator with the tools that change things (create/delete/relabel sandboxes, start/message/interrupt/stop agents, standing agents, `request_app_update`). It turns requests into work without doing the same work twice, and records each in the work ledger |
| standing agent | a long-lived agent with a charter and a schedule (interval, cron or manual), apart from the sandboxes: its own folder under `<sandboxRoot>/_agents` with a `NOTES.md`, a fresh process per run, hard per-run and per-day budgets, read-only by default. See [docs/standing-agents.md](docs/standing-agents.md) |
| guard | a `PreToolUse` hook on every worker, active even in `bypassPermissions`: no push or PR to the project repo's master/main, no force push, no `gh repo delete`, no writes to or shell commands naming a `protectedPaths` entry, this app's checkout ([the guard flag](#the-factorys-own-checkout)) or its `dataDir` |
| attachments | files people attach to a message, stored once by SHA-256, never opened by the server; each worker gets its own copy in `Inbox/` of its sandbox ([docs/attachments.md](docs/attachments.md)) |
| state | `data/state.json` (sandboxes and session metadata) and `data/transcripts/<session>.jsonl`. Sessions come back `stopped` after a restart and resume on the next message |

Workers default to `bypassPermissions` (autonomous, bounded by the guard). Switch a session to `default` from its panel
and every tool call that would prompt shows up as an Allow/Deny card.

> Inherited from upstream and switched off in `config.example.mac.json`: Unity editor management, remote machines,
> FFBox/Discord/Max intake and voice input. Their code and docs remain (see [docs/README.md](docs/README.md)).

## Setup (Mac)

```bash
git clone -b sketchup https://github.com/bryding-su-dev/sketchup-factory.git && cd sketchup-factory
npm install
cp config.example.mac.json config.json   # set sandboxRoot, repo.*, protectedPaths
node server/user.ts <name>               # create a login (prompts for a 12+ char password)
npm run setup                            # sandbox root and the base clone at repo.basePath
npm run build                            # web UI -> web/dist
scripts/mac/install-autostart.sh         # LaunchAgent: start at login, supervised
```

`config.json` is gitignored. Put a long-lived Claude token in it as `"claudeEnv": { "CLAUDE_CODE_OAUTH_TOKEN": "…" }`
(from `claude setup-token`), or set `claudeAccounts` to `"login"` to run the agents on the Mac's claude.ai login.
Artifacts and connectors need that login, not a token ([docs/accounts.md](docs/accounts.md)). `project.name`,
`project.integration` (`pull-request`) and the two brief files under `project/` describe the project to agents
([project/README.md](project/README.md)).

For development: `npm run dev` (API on `config.port`, default 8790) and `npm --prefix web run dev` (Vite on :5173).

### Access and security

The page drives agents that run shell commands on the host, so its login is treated like a shell login: scrypt-hashed
passwords (`data/users.json`, managed with `node server/user.ts <name> [--name "Display Name"] [--role owner|member]`),
server-side 30-day sessions, HttpOnly + SameSite=Strict cookies, 5 failed logins per IP per 15 minutes, JSON-only
writes (CSRF) and a same-origin check on the WebSocket. Several people can share one portal, each with their own
orchestrator chat; every message records who wrote it ([docs/identity.md](docs/identity.md)). The first login is the
owner.

For access from elsewhere, bind to loopback (`"host": "127.0.0.1"`) and publish it with Tailscale Funnel
(`tailscale funnel --bg 8790`, `tailscale funnel --https=443 off` to stop). `node server/apikey.ts <name>` mints an API
key for `/mcp`, which serves the orchestrator's tool belt to Claude Code (`--revoke <name>` to kill it).

The sidebar bell turns on Web Push for that device (an agent waiting for a permission, a finished turn, an error). On
iPhone it only works for a Home Screen app.

## Running it

**Supervisor and updates.** `scripts/mac/install-autostart.sh` registers the LaunchAgent
`com.sketchup-factory.server`. launchd keeps the Node supervisor (`scripts/supervise.ts`) alive; the supervisor runs
the server and restarts it when it exits. To restart by hand run `scripts/mac/restart.sh` (`--update` pulls, installs,
rebuilds and restarts; `--no-drain` skips waiting for busy agents); `scripts/mac/uninstall-autostart.sh` removes it. The
dispatcher's `request_app_update` does the same without anyone at the Mac: it asks busy agents to commit and end their
turn, `scripts/supervisor.ts` fast-forwards the checkout, rebuilds, health-checks `/api/health` for the new commit and
rolls back to the previous commit if anything fails, and the new server resumes the agents it interrupted. It refuses
a modified or diverged checkout. Details: [docs/restart.md](docs/restart.md#macos-the-node-supervisor). Logs:
`data/supervisor.log`, `data/server.out.log`, `data/server.err.log`.

**Timers and standing agents.** Orchestrators set timers for themselves (`set_timer`: once, every N minutes or daily),
kept in `data/timers.json` across restarts. Standing agents run on their own schedule and ask for sandbox workers
through delegation requests you approve ([docs/standing-agents.md](docs/standing-agents.md)).

**A fresh session per request.** A new request starts a new worker session (`start_agent`); resuming an old worker's
conversation hands it all its earlier context, which costs tokens on every turn and lets old work bleed into the new.
`message_agent` with a request the worker is not on yet is refused unless it gives a `continue_reason`, which is logged.
A fresh worker gets a handoff of the related requests, never the old transcript
([docs/orchestrators.md](docs/orchestrators.md#a-fresh-session-per-request)).

<a id="the-factorys-own-checkout"></a>
**The factory's own checkout.** By default the guard keeps agents out of this app's checkout. Set
`"guard": { "protectFactoryCheckout": false }` (or `set_app_config guard.protectFactoryCheckout false`) on an install
you own outright, and workers may run commands and edit files there to change or update the app. `data/` stays
protected either way. They can then edit the guard itself, so the seatbelt is only as good as the agent
([SECURITY.md](SECURITY.md)).

**Models** ([docs/models.md](docs/models.md)). Opus 5.5 plans and checks: the orchestrators, the dispatcher (`orchestrator.model`)
and every worker's `planner` and `reviewer` subagents. Sonnet 5.5 implements: every worker's main loop (`defaultModel`). Haiku 5.5
does cheap work: every worker's `scout` subagent, and Claude Code's own background calls (`modelPins.haiku`, since the pinned SDK maps
`haiku` to 4.5). All of these keys can be set with `set_app_config`.

**Accounts and usage.** The sidebar's "Claude plan" meters show each Claude account in use, polled every
`usagePollMinutes` (default 15), and the footer shows the Mac's load. `claudeAccounts` picks, per role
(orchestrator, workers, standing), the token or the Mac's login ([docs/accounts.md](docs/accounts.md)). Token values are
never shown or logged.

**Bedrock** ([docs/bedrock.md](docs/bedrock.md)). With `bedrock.profile` set (an AWS SSO profile name), this host's
agents move to SketchUp's AWS Bedrock account when the plan's 5-hour usage reaches `bedrock.thresholdPercent` (Auto), under a
daily cap (`bedrock.dailyBudgetUsd`, default $200). The sidebar shows the backend and a Plan | Bedrock | Auto control. Keys, all
settable with `set_app_config`: `bedrock.mode`, `bedrock.profile`, `bedrock.region`, `bedrock.regionPrefix`,
`bedrock.thresholdPercent`, `bedrock.weeklyThresholdPercent`, `bedrock.resumeMarginPercent`, `bedrock.dailyBudgetUsd`.

**Clean-up.** The host guard pauses new work and removes known-safe junk (Xcode DerivedData, Homebrew downloads,
caches) when disk space runs low, and hourly otherwise. On a developer's own Mac set
`"hostGuard": { "cleanup": { "enabled": false } }` or skip rules by id with `"skipRules"`
([docs/self-recovery.md](docs/self-recovery.md)).

### config.json

See `config.example.mac.json` and `server/config.ts` (every field is documented there). The important ones: `host`,
`port`, `sandboxRoot`, `repo` (`url`, `basePath`, `referenceRepo`, `seedFiles`), `defaultBase`, `project`,
`protectedPaths` (checkouts agents must never touch), `guard.protectFactoryCheckout`, `limits` (`maxSessions`,
`maxSandboxes`, free disk and RAM), `models` and `defaultModel`, `orchestrator`, `worker` (permission mode, effort,
`claudeAiConnectors`), `claudeAccounts`, and `ownerName`. A few cosmetic settings can be changed by the dispatcher with
`set_app_config`; everything else is edited by hand. `publicGitIdentity` sets the identity workers commit with in
public repos, and the guard refuses a push there with any other non-noreply email.

## Development

```bash
npm install && npm --prefix web install
FFSB_CONFIG=/path/to/test-config.json npm run dev   # API on config.port
npm --prefix web run dev                             # Vite on :5173, proxies /api and /ws
npm run typecheck && npm --prefix web run build
npm test                                             # node --test server/*.test.ts scripts/*.test.ts
```

A throwaway config whose `repo.url` is a local bare repo is enough to exercise everything. CI
([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs on pushes and pull requests to `sketchup`; see
[CONTRIBUTING.md](CONTRIBUTING.md). The running version shows in the sidebar footer and at `GET /api/health`; changes
are listed in [CHANGELOG.md](CHANGELOG.md). Internal names such as the `FFSB` cookie, `FFSB_CONFIG` and `ffsb-*` keys
come from upstream and are unchanged.

## Security model

SketchUp Factory gives AI agents a shell on your machine. Treat access to it like SSH access.

- **Who can drive it:** the web login and API keys for `/mcp` (stored hashed). Anyone with either can run arbitrary
  commands as the host's user through an agent.
- **What agents can do:** workers default to `bypassPermissions`. The guard hook (`server/guard.ts`,
  `server/standingGuard.ts`) blocks known-destructive git operations and the paths above. It is a seatbelt against
  mistakes, not a sandbox against an agent that is trying.
- **Secrets on disk:** `config.json` (it may hold a Claude token) and `data/` (users, sessions, API keys, transcripts)
  are gitignored and stay on the Mac. Transcripts contain whatever the agents saw.
- **Standing agents** can read untrusted text. They are read-only by default, have budgets, and anything that writes
  goes through a delegation request you approve.

Report vulnerabilities as described in [SECURITY.md](SECURITY.md).

## Known gaps

- **Workers run as the Mac's user.** A hijacked worker (prompt injection through a web page, an issue or a file) could
  use a script to touch that user's files and read the Claude token in its environment. Running workers as a
  low-privilege user is the real fix and is not done.
- **Prompt injection.** Text an agent reads can steer it. The guard stops the obvious damage, not a determined attacker.
- **Mac only.** The supervisor and updater are macOS-only here; the Windows scripts are inherited and untested for
  SketchUp. Linux is not supported.
- **Tied to one project.** The briefs under `project/sketchup/` and the guard's repo rules name the SketchUp Assistant
  frontend's conventions.

## Status

A working tool used daily on one project. It changes often and without compatibility promises.

## License

MIT, see [LICENSE](LICENSE).
