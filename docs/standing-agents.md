# Standing agents

A standing agent is a long-lived Claude Code agent with an ongoing job, such as triaging Discord
reports or reviewing PRs. It is defined and managed from the web app, and it sits apart from the
sandboxes: it has no worktree and no Unity. It wakes on a schedule (or when the user presses Run now),
does its job, writes down what it did, and goes back to sleep. When it needs real work done in the
game repo, it asks for a sandbox worker instead of doing the work itself.

The list starts empty. Nothing is seeded or hard-coded: every agent is defined in the UI or through
the orchestrator's tools.

## Definition

Stored in `data/state.json` next to the sandboxes (`StandingAgent` in `shared/types.ts`).

| field | meaning |
|---|---|
| name | display name; the id is its slug, and the folder is named after the id |
| charter | the agent's standing instructions, appended to its system prompt |
| model | one of `config.models` |
| trigger | `every N minutes`, a 5-field cron expression (host local time), or `manual only` |
| folder | its working directory, `<standingRoot>/<id>` (default `<sandboxRoot>/_agents/<id>`, e.g. `F:\ffsb\_agents\pr-reviewer`). It holds `NOTES.md`, the agent's durable state. Not a sandbox and never under the app's data dir (the guard protects that) |
| enabled | a paused agent keeps its definition, history and conversation but never runs on schedule. Run now still works |
| budget | `perRunUsd`, `perDayUsd` and `maxMinutes` per run (added: a hung run would hold an agent slot forever) |
| tools | tool groups, below |

## Runs

- Each agent owns one Claude session (kind `standing`) for its whole life. A run resumes that
  session with a short `[run]` message (trigger, budget left, "read NOTES.md, do the job, update
  NOTES.md, end with a summary"). When the turn ends, the server stops the process. Between runs
  the agent is asleep and does not count toward `limits.maxSessions`. During a run it does.
- **No overlap.** An agent has at most one pending or active run. A schedule tick that comes due
  while a run is active is recorded as `skipped (previous run still going)`.
- **Limit full.** A due run waits (dashboard: "waiting for an agent slot") until a slot frees, for
  at most 60 minutes or until the next scheduled occurrence, whichever is sooner. It is then
  recorded as `skipped (no free agent slot)`. Standing agents only take free slots; they never stop
  a worker.
- **Schedule.** Interval: the next run is N minutes after the previous one came due. Cron: the next
  match after now. If the server was down past a due time, it runs once on boot (one catch-up, not
  one per missed slot).
- **Budget, hard-enforced.** Each run is its own `query()` process, started with
  `maxBudgetUsd = min(perRunUsd, perDayUsd - spent today)`, so the Claude CLI itself stops the run
  when it crosses the cap (it checks between model calls, so one call can overshoot slightly). The
  server also stops a run whose measured cost reaches the cap, and one that passes `maxMinutes`. A
  run is not started at all when today's budget is spent. "Today" is the host's local date. Costs
  are the SDK's estimates.
- **Messages.** Typing to a standing agent in its panel starts a run with that text attached (same
  budget, overlap and limit rules). If a run is active, the text joins it.
- A server restart marks an active run `interrupted`.

Run history (last 50, per agent) records trigger, start/end, outcome (`ok`, `error`, `budget`,
`timeout`, `stopped`, `skipped`, `interrupted`), cost, and the summary (the final message).

## Tools and guard

Every standing agent gets Read, Glob, Grep, Skill, and Write/Edit **only inside its folder**. It
loads user settings (so the ff-agents / ff-discord plugin skills are available) but no MCP servers
except its own. Permission mode is `bypassPermissions`, bounded by two `PreToolUse` hooks:

1. `sandboxGuard`, the same one workers get: no push to the game repo's master/main, no force push,
   no remote branch deletion, no killing processes, no protected paths (the live checkout, this
   server's code unless `guard.protectFactoryCheckout` is `false`, and its data).
2. `standingGuard`: Write/Edit only in its own folder; shell commands must be on an allowlist
   that depends on the groups, and may not name another sandbox, the base clone, or use command
   substitution, heredocs or output redirection (write files with the Write tool instead).

Tool groups (none by default, so the default is read-only on files only):

| group | adds |
|---|---|
| `shell_read` | Bash, limited to read-only commands: `git` log/show/diff/fetch/clone/ls-remote/…, `gh` pr/issue/repo/run view and list, `gh api` GET, plus cat/grep/ls/jq-style utilities |
| `github_comment` | `gh pr comment`, `gh issue comment`, `gh pr review --comment`, and `gh api` POSTs to issue/PR comment and review endpoints. Never approve, request changes, merge, close or edit (implies `shell_read`) |
| `delegate` | `request_delegation` and `my_delegations` (below) |

### Delegation

`request_delegation(title, task)` records a delegation request and tells the orchestrator of the person
the run was for (the system payer's for a scheduled run; [orchestrators.md](orchestrators.md)). The user
approves or rejects it on the dashboard, or asks their orchestrator, which files it as a work request for
the dispatcher: `approve_delegation` requires `user_asked` and a request its person asked for, like
`delete_sandbox`. Approving picks a ready sandbox labelled `unused` with no live
agent, or else an online machine labelled `unused` with no agents and a clean tree, relabels it, and
starts a worker with the task. No free target: the approval fails and the request stays pending.
`my_delegations` lets the agent see its requests and, once approved, the worker's status and last
result on its next run.

**Auto-approve** (per agent, `autoApprove` / the `auto_*` fields of create/update_standing_agent,
and the editor): requests start without the user, up to `maxPerRun` and `maxPerDay` (default 3 and 3),
with `model` / `effort` (default sonnet, high) on `targets` (default unused sandboxes, then idle
machines; `exclude` default `mp-r2`; a sandbox not labelled `unused` is never used). A request over
the limits waits for the user as before. One with no free target is queued and retried every tick until
`expiryHours` (default 8) after it was filed, then marked `expired`. The worker gets the normal
guard plus a brief: its own branch, a PR into develop only, never merge. Every step is in the
request's log, pushed as a notification, and the orchestrator of the person the request is for is woken
(`[auto-delegation]`) when a worker starts, finishes its first turn, or a request expires.

## Dashboard and orchestrator

- Sidebar section **Standing agents**: a card per agent with status, next run, and today's spend.
  The agent page shows status, trigger, next run, today's spend vs budget, the last run's result
  and summary, run history, pending delegation requests (Approve / Reject), and the conversation.
  Buttons: Run now, Stop run, Pause / Resume, Edit, Delete (confirms).
- Dispatcher tools (also on `/mcp`): `list_standing_agents`, `create_standing_agent`,
  `update_standing_agent`, `run_standing_agent_now`, `pause_standing_agent`,
  `resume_standing_agent`, `list_delegation_requests`, `approve_delegation` / `reject_delegation`,
  and `delete_standing_agent` (requires `user_asked`). People's own orchestrators have the two lists.

## Decisions and changes from the brief

- **No seeded agent**: the example below is documentation only.
- Added `maxMinutes` per run, and "Stop run".
- Folders live under `<sandboxRoot>/_agents` (`standingRoot` in config), never in `data/`: the
  guard's own-folder exception would otherwise unprotect the whole data dir.
- The read-only shell is an allowlist, not a denylist. It is a seatbelt like the rest of the guard:
  an agent can still read any file the host user can, and a comment is a way out. Keep charters
  that read untrusted text (Discord, PR bodies) away from `github_comment` unless needed.
- Not in v1: starting delegated workers without approval, reporting a delegated worker's result
  back into the agent's run automatically, Discord or web tools, per-agent environment/secrets.

## Example charter (documentation only)

A PR reviewer, with trigger `every 30 minutes`, groups `shell_read` + `github_comment`, budget
$3/run and $15/day. It needs `gh auth login` on the host; comments post as that account.

> Review open, non-draft pull requests on example-org/example-game. Each run: list them with
> `gh pr list -R example-org/example-game --state open --json number,title,headRefOid,isDraft,author`.
> NOTES.md holds a table of PR number to the head SHA you last reviewed; skip PRs whose head is
> unchanged. For each new or updated PR, read `gh pr view` and `gh pr diff`, check the changes
> against the repo's CLAUDE.md rules (determinism, fp math, simulation vs presentation), and write
> one review to a file in your folder. Post it with
> `gh pr comment <n> -R example-org/example-game --body-file <file>`, starting with
> "Automated review (FF Factory)". One comment per head SHA. Never approve, request changes
> or merge. Record the SHA in NOTES.md, and end with one line per PR reviewed.
