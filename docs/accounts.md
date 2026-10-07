# Claude accounts: which agent runs on which

Every agent the portal starts runs on one of three kinds of Claude credential:

- **The host token**: config `claudeEnv.CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`), shown as
  "host token …abcd".
- **A computer's stored login**: the claude.ai login made with `claude` → `/login` on that computer. On
  Windows and Linux it is `~/.claude/.credentials.json` (or under `CLAUDE_CONFIG_DIR`); on macOS it is in the
  Keychain. The usage meters show it as "<host> login" or "<machine> login".
- **A person's own token**: config `userClaudeEnv.<user>` ([identity.md](identity.md)). This one always
  wins for work that person asked for, wherever it runs.

## The switches

| Agents | Config | Values | Default |
|---|---|---|---|
| The orchestrator | `claudeAccounts.orchestrator` | `"token"` or `"login"` (this host's) | `"token"` |
| Sandbox workers on this host | `claudeAccounts.workers` | same | `"token"` |
| Standing agents on this host | `claudeAccounts.standing` | same | `"token"` |
| Workers and standing agents on a Mac | `machines.useHostClaudeEnv` | `true` (host token) or `false` (the Mac's login); global, or per machine | `true` |
| Workers on this host's own daemon ([beast-machine.md](beast-machine.md)) | `claudeAccounts.workers`, unless `machines.useHostClaudeEnv` names the machine | as for sandbox workers here; "login" is this host's login, with the rest of `claudeEnv` (e.g. `CLAUDE_CONFIG_DIR`) kept | `"token"` |

`machines.useHostClaudeEnv` takes `true`/`false` or an object with one entry per machine id, plus `"*"` for
the machines it does not name: `{ "m3": false, "m5": false }`, or `{ "*": false, "m5": true }`.

All four are in `set_app_config`'s allowlist, so the orchestrator can change them when the user asks:

```
set_app_config claudeAccounts.orchestrator "login"
set_app_config machines.useHostClaudeEnv false  machine: "m3"
set_app_config machines.useHostClaudeEnv false  machine: "m5"
```

Without `machine`, `machines.useHostClaudeEnv` sets every machine not named, and keeps the per-machine
entries. `null` removes a setting (back to the default). The server refuses a malformed value when it
loads `config.json` (`checkAccountConfig`, `server/config.ts`).

Setting a role to `"login"` is refused when this host has no login that can run an agent: none stored, or
the access token and the refresh token have both expired (`hostLoginProblem`, `server/secrets.ts`). A login
without the `user:profile` scope is accepted: agents need only `user:inference`, and only the usage meters
need `user:profile`. On macOS a missing file proves nothing, because the login is in the Keychain.

## What "login" does at launch

A process set to the login starts with **no credential at all in its environment**: the server's own
environment and config `claudeEnv` are merged, then every variable in `AUTH_ENV` (`server/usage.ts`:
`CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY` and the rest) is dropped. Claude Code then falls back to the
stored login. This is the same environment the usage tracker uses to poll the host login
(`UsageTracker.refresh`), so the account the meters show as "<host> login" is the one those agents run on.
The other `claudeEnv` variables, such as `CLAUDE_CONFIG_DIR`, stay.

- Orchestrator and sandbox workers: `hostProcessEnv(cfg, role)` (`server/secrets.ts`), used by
  `orchestratorOptions` and `workerOptions` (`server/agents.ts`).
- Standing agents on this host: `hostClaudeEnv(cfg, 'standing')` plus `LaunchSpec.login` (`server/standing.ts`,
  `place`); `buildOptions` (`server/launch.ts`) drops the credentials of the environment it starts from.
- Agents on a Mac: the portal sends the host token in the launch spec only when the machine takes it
  (`hostClaudeEnvFor`), and sets `LaunchSpec.login` when it does not (`machineUsesLogin`), so a token left in
  the daemon's own environment cannot stand in for the Mac's login either.
- A person's own token is laid over all of these (`claudeEnvFor`, `server/identity.ts`).

## When a change takes effect

The environment is fixed when an agent's process starts. A change applies to agents started after it;
running ones keep their account until their process restarts. For the orchestrator, that means restarting
the app.

## Artifacts and claude.ai connectors

Workers can publish a self-contained HTML file as a claude.ai artifact page (Claude Code's `Artifact`,
`ArtifactComments` and `ArtifactData` tools) and use the claude.ai connectors config allows. Two gates in
Claude Code keep both out of an SDK session by default:

- **Artifact**: Claude Code withholds the tools from every SDK session ("sdk_default_off") unless
  `CLAUDE_CODE_ARTIFACT` is set. `ARTIFACT_ENV` (`server/launch.ts`) sets it for sandbox workers here
  (`workerOptions`) and for workers on a Mac (their launch spec), under config `claudeEnv`, so
  `"CLAUDE_CODE_ARTIFACT": "0"` there turns it off. Publishing needs a claude.ai login: it works on this
  host's stored login (`claudeAccounts.workers: "login"`) and a Mac's. On a `claude setup-token` token it
  is untested.
- **claude.ai connectors**: a session with strict MCP config never loads them. Sandbox workers here used to
  run with strict MCP config so the host user's own MCP servers (`~/.claude.json`, a project's `.mcp.json`,
  plugins) stay out, an `ffsb` entry most of all. With connectors configured they run without it, and an MCP
  allowlist (settings `allowedMcpServers`, `connectorAllowlist`) admits only their own servers (`sandbox`,
  `UnityMCP`, by name) and the connectors whose upstream URL matches config `worker.claudeAiConnectors`.
  Claude Code matches a connector by URL, not by its "claude.ai …" name. `mcp__ffsb` is also in
  `disallowedTools`, in case an organization's managed allowlist replaces this one. A connector needs a
  login with the `user:mcp_servers` scope, which a setup-token lacks, so none load on a token.

| Config | Default | Meaning |
|---|---|---|
| `claudeAiConnectors.orchestrator` | `false` | Whether orchestrators get the claude.ai connectors at all (Claude Code's `disableClaudeAiConnectors` when off). Off by default: upstream measured their connector tools at about 41,300 input tokens in every turn, and orchestration does not use them. |
| `claudeAiConnectors.workers` | `true` | `false`: sandbox workers load no connector, whatever `worker.claudeAiConnectors` lists, and keep strict MCP config. |
| `worker.claudeAiConnectors` | `["https://api.anthropic.com/v1/pages/mcp"]` (Claude Docs) | Upstream URLs (`*` wildcards) of the claude.ai connectors sandbox workers on this host load. `[]`: none, and strict MCP config as before. |

Find a connector's URL in a session's MCP status (`mcpServerStatus()`, `config.url`). Allow only what
workers need: they run with `bypassPermissions` on text that can come from Discord or the web, and a connector
such as Gmail or Drive acts as the person whose login it is. Edit `config.json` to change it (it is not in
`set_app_config`'s allowlist).

Workers on a Mac run without strict MCP config already, so they load the Mac's own MCP servers and every
connector of the Mac's login. Standing agents and orchestrators have no Artifact tools: their `tools` lists
leave them out on purpose. Standing agents also keep strict MCP config, so they load no connectors either.

Like the account, all of this is fixed when a process starts: after an app update, every worker picks it up
when its process next starts, including a resumed one.

## Attribution: meters, system_status, agent details

Each session maps to an account source key (`sessionSource`, `server/usage.ts`):

1. A running process: the account it **started** on. `AgentSession` records it as `SessionInfo.account` when
   the process starts (`accountKeyOf` of its final environment: `token:<hash prefix>`, or `host:login` with
   no token). A Mac daemon runs the same code and reports it, and the portal reads a Mac's `host:login` as
   that Mac's login (`login:<id>`, `server/machines.ts`). So an orchestrator set to `"login"` shows on the
   token until it restarts, because that is what it runs on. Daemons older than this field leave it unset,
   and their sessions fall through to 2.
2. Otherwise, the account the next process will get from the current config: a person's own token for
   their work; on a Mac the host token or that Mac's login; on this host `host:login` when the session's
   role is set to `"login"`, else the host token.

The usage meters (`buildAccounts`) list which host roles share the token and which the login when they are
split, for example "the agents' token on BEAST (workers, standing agents)" and "BEAST login (the
orchestrator)". `system_status` starts its account section with one line naming every role's account, the
account of each machine's agents, and the people with their own token. It adds a warning when a role set
to the login cannot use it.

The usage tracker polls the host token and this host's login whatever the switches say, and each Mac's
daemon polls its own login.

## How often

Every account is polled once when the portal starts (a daemon: when it connects, unless it reported in the last half
interval), then every config `usagePollMinutes` (default 15, 5 to 240; `set_app_config usagePollMinutes`). The usage
endpoint rate-limits, so the numbers are allowed to be that old: each account's meters say "as of" when.

- The portal (`UsageTracker`, `server/usage.ts`) counts the interval from its last poll, whatever started it. A
  changed interval applies at once, here and on the daemons (`usage_config`, sent at connect and when it changes).
- Rate-limit events no longer poll (they did, up to once a minute). A new token set with `set_app_config` is polled
  within seconds.
- `system_status` uses the numbers as they are when they are under one interval old, and starts a poll when they are
  older (the last poll failed, or its timer was held up).
- **Refresh usage** under the meters (`POST /api/usage/refresh`) polls every account now, and asks each connected
  daemon for its login (`usage_now`), unless a poll is running or started seconds ago. The next scheduled poll then
  counts from it.
- A request that never answers cannot hold the polls up: each gives up after 75 s, and a poll still marked running
  after 5 minutes no longer blocks the next one.
