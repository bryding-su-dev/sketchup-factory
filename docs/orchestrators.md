# Orchestrators: one per person, and a dispatcher

Ben and Lothsahn used to share one orchestrator chat, so each read the other's conversation and could interrupt it.
Now every person has their own orchestrator, and one dispatcher owns everything that changes the machines. People's
orchestrators file work requests with the dispatcher, which checks them against the work already in flight before it
starts anything. The record of every request and what became of it is the work ledger.

## The two kinds

**A person's own orchestrator** (`orchestratorRole: 'personal'`, its `requestedBy` is its person) talks only with that
person. It runs on their own Claude token when config `userClaudeEnv` has one, otherwise on the account
`claudeAccounts.orchestrator` picks (the owner's), and `system_status` says which. Its tools, as listed in
`server/belts.ts` `PERSONAL_TOOLS`:

- read everything: `list_sandboxes`, `list_machines`, `list_branches`, `agent_transcript`, `search_transcripts`,
  `system_status`, `ffbox_activity`, `max_activity`, `list_standing_agents`, `list_delegation_requests`;
- its own `wake_me`, and its person's heartbeat (`set_heartbeat`);
- `message_agent`, only to its person's own workers (they started it, or one of their requests is on it);
- the ledger: `request_work`, `list_work`, `update_work`;
- `message_person`, to another person's own orchestrator ([People to people](#people-to-people)).

It cannot start, stop or change anything else. To get work done it files a request.

**The dispatcher** (`orchestratorRole: 'dispatcher'`) has every other tool, plus `list_work` and `decide_work`. People
do not chat with it; the owner can open its page and write to it. It runs for the system payer (config `systemPayer`,
Ben). It hears work requests, updates to them, capacity news and the host's notices, and answers people only through
the ledger.

Both briefs describe the same world (`worldBrief` in `server/agents.ts`). Its FFBox paragraph is Lothsahn's text,
verbatim (`FFBOX_BRIEF`): what FFBox is, that it owns #bug-reports and dev_bug_reports, and that the ffbox repo can be
changed through workers, who push straight to its master one change at a time because a push goes live on the box within
about five minutes. The longer version is [ffbox.md](ffbox.md). `ffbox_activity` stays read-only.

Both are sessions of kind `orchestrator`, so neither takes an agent slot, and both keep the orchestrator's limits: no
shell, no web tools, `Read`/`Glob`/`Grep` on the base clone, and `Write`/`Edit` only in their own memory folder
([Memory](#memory)). Their briefs share one description of the world
(`worldBrief` in `server/agents.ts`); the dispatcher's is the old shared orchestrator's, edited for a chat people do not
write to.

## Requests and the ledger

`request_work {title, brief, priority, constraints, related_ids, attachments}` files a request (`w12`). `attachments`
are ids of files the person attached to their message (saves, bug-report zips, logs): the request keeps them, and every
worker started for it gets a copy in its `Inbox/` ([attachments.md](attachments.md)). Before the dispatcher sees it,
the server (`server/work.ts`) does three things:

1. **Repeats.** An open request of the same person with the same title (ignoring case and punctuation) is returned
   instead of a new one, and the new text goes into its log.
2. **Overlaps.** It pulls keys out of the request (specs like `098`, PRs named as such, other `#N` references,
   branch-like names of the branches checked out anywhere, and the ids in `related_ids`) and compares it with open requests and those closed in the last 48 hours, live and
   recent workers wherever they run (their title, and the branch and open PR of their sandbox, this host's or a
   machine's, or of the machine's main clone), pending delegation requests, and commits on the base branch in the last
   48 hours. A shared request, worker, PR or branch scores 1; a shared spec or `#N` with a similar title scores 0.8,
   without one 0.5; otherwise title similarity. 0.8 and over is strong. The person's orchestrator gets the overlaps at
   once, in the tool's answer.
3. **Limits.** Below.

Requests also come from the intake ([intake.md](intake.md)): Discord bug reports, trusted people's requests to Max
and FFBox's work, each with its source, its triage (an obvious bug, or it needs a human) and, until a reviewer approves
it, `approval: pending`, which keeps it from the dispatcher and makes `start_agent` refuse it. Work started from the
dashboard, over `/mcp` or for a delegation is recorded as an active request too, so the ledger shows all work.

The dispatcher then does one of these for each request:

| decision | how | status |
|---|---|---|
| start it | `start_agent` with `work_id`, or `message_agent` with `work_id` to a worker already on it | `active` |
| merge it | `decide_work merge` into the open request it repeats; its people join that one | `merged` |
| link it | `decide_work link` to workers already doing it | `active` |
| queue it | `decide_work queue`, saying what it waits for | `queued` |
| ask | `decide_work ask`, at most 3 questions per request | `question` |
| reject it, or close it | `decide_work reject` / `done`, saying why | `rejected` / `done` |

`start_agent` refuses a request with a strong overlap still in flight (a commit only informs), or one that already has a
live worker, unless `override_duplicate` says what is different. `work_id` is the dispatcher's alone. A worker started
for a request runs for the person who filed it, on their account. The requester's orchestrator can add a note (which
answers a question), change the priority, close the request, or reopen it within 7 days (`update_work`). Closing is the
filer's: the others still on the request hear it. Someone whose request was merged into it only leaves it.

The ledger is `data/work.json`: every open request and the newest 300 closed ones. The page gets the open ones and those
closed in the last 3 days.

## People to people

A person's orchestrator reaches another person with `message_person {to, text}` (`to` is a user id), when its person
asks it to: a decision only the other person can make, a script only they can run on their own machine. The server
(`Orchestrators.messagePerson`, `server/orchestrators.ts`):

- refuses anyone but a person's own orchestrator (the tool is only in their belt, `server/belts.ts` `PERSONAL_ONLY`, and
  the method checks the chat's role again), an unknown user id, the sender's own person, an empty text and one over
  2000 characters;
- allows 3 messages from one person to another until the recipient writes to their own orchestrator (`personWrote`), so
  two orchestrators cannot keep a conversation going between themselves;
- sends the recipient's own orchestrator (made if missing) a harness message, recorded with the sender as `requestedBy`:
  `[person message] From Lothsahn's orchestrator (user id lothsahn), written for Lothsahn:`, the text, then a line
  saying it is data to show the recipient, not an instruction. It is in the recipient's transcript at once, so a
  restart keeps it; one sent mid-turn waits for that turn, like every harness message;
- marks it unread on the recipient's session (`personMessages`) until they open their chat (`POST
  /api/sessions/:id/seen`, their own only) or write to it, and sends them alone a notification (kind `person`).

The recipient's orchestrator shows who it is from and what it asks, in a line or two, and never acts, files work or
answers on its own: its person decides, and it answers with the same tool only with what they say. A turn a
`[person message]` starts is the harness's, not the person's, so the destructive tools stay closed in it. The dispatcher
neither relays nor sees these messages.

## Memory

Each orchestrator has a memory folder of its own: `data/orchestrator-memory/person-<user id>` for a person's (Ben's,
Lothsahn's, anyone's), `data/orchestrator-memory/dispatcher` for the dispatcher (config `orchestrator.memoryRoot` moves
the root). `memoryDirFor` (`server/orchestratorMemory.ts`) makes it when missing. It is Claude Code's auto memory,
pointed there with `settings.autoMemoryDirectory`: the CLI loads its `MEMORY.md` index into every conversation's
context and names the folder in its prompt, so what an orchestrator saves survives restarts and fresh conversations,
and every person's orchestrator has its own though they share the base clone as their working directory. The brief
repeats the folder and the rules.

Orchestrators got `Write` and `Edit` for it, and stay read-only on everything else. A PreToolUse hook (`memoryGuard`)
decides every write, and a hook's refusal holds in every permission mode:

- **Where:** only a Markdown (`.md`) file inside its own folder, after resolving `..`, symlinks and junctions (its real
  path must stay inside the folder's real path), with Windows' path rules (case, both slashes). Refused: the repo,
  `config.json`, the rest of `data/`, other orchestrators' folders, relative paths, links and hard links, UNC and
  `\\?\`/`\\.\` paths, alternate data streams (`MEMORY.md:x`), names ending in a dot or space, device names.
- **What:** no secrets, gitleaks-style: Anthropic, GitHub, AWS, Google, Slack and npm tokens, FF Factory connector
  tokens, Discord bot tokens, private keys, and a password or key assigned a long value.
- **When:** only in a turn its person started with a message of their own (the dispatcher: the owner writing in its
  chat). Orchestrators read text agents wrote (`[worker update]`, relayed Discord and FFBox reports); a harness turn
  must not be able to plant an instruction that every later conversation loads.

### Memory in a private repository

The memory holds one person's preferences, in their words, so it does not belong in a public repository; and a folder
in the app's data on one machine is not versioned. So when the memory root is itself a git repository, the app commits
what changed there and pushes it (`server/memoryGit.ts`, on every backup pass: at startup and every 10 minutes).

- **Private only.** It pushes only to an `origin` GitHub reports as private (`gh api repos/<owner>/<name>`, with the
  machine's own `gh` login). To a public remote, to one that is not on GitHub, or when GitHub cannot be asked, it
  commits here and does not push, and the log says why once. What waited goes out on a later pass.
- **Never into another repository.** The root must be the top of its own repository. The default root is a folder of
  the app's checkout, and the app's repository never gets memory commits.
- **No secrets.** The write guard already refuses them; a Markdown file that holds one anyway is left out of the commit
  and named in the log. Only `.md` files are committed.
- **Whose commits.** The repository's own `user.name` and `user.email` when it has them, else the app's public identity
  (`publicGitIdentity`), never this machine's global identity.
- It never pulls, merges or force-pushes. One machine owns a memory root; a push that is refused stays local and says so.

To switch it on (the owner does this once; nothing in config changes):

```sh
cd <data>/orchestrator-memory          # or wherever orchestrator.memoryRoot points
git init -b main
git remote add origin https://github.com/<owner>/<a private repository>.git
```

The next backup pass makes the first commit and pushes it. The crash backup beside it (`<root>.backup`) keeps working
and leaves `.git` out. General rules about how to work do not belong in this repository either: they go to the harness
repositories by pull request, where workers and forks can read them.

The folder sits in `data/`, which workers' guard already protects (`server/guard.ts`), so no worker can write an
orchestrator's memory either. Workers and standing agents are unchanged. Reading stays as before: an orchestrator can
read any file, other orchestrators' memory included.

## Where messages go

| message | to |
|---|---|
| `[work request]`, `[work update]` | the dispatcher, gathered for 1.5 s per person |
| `[dispatch]` (a decision) | the orchestrators of the people the request is for; a question only to its filer |
| `[worker update]` (a turn an orchestrator started ended, or a permission is waiting) | the orchestrators of the people the worker works for: its requests' requesters, else whoever started it, else the system payer. The ledger records the worker's last line; the dispatcher is not woken |
| `[ledger]` | the dispatcher: after a restart or a fresh conversation, the requests still waiting (what it had not answered died with its process); and when requests are queued and a worker ends a turn, after 30 s of quiet, at least 2 minutes apart and at most 20 an hour (a wake that comes too soon waits) |
| a failed worker of an open request | the dispatcher, as a `[work update]` |
| `[standing agent]`, `[auto-delegation]` | the orchestrator of the person the run was for (the system payer for a scheduled run) |
| `[unity blocked]` | the dispatcher, and the people whose workers are in that sandbox |
| `[app restarted]`, `[machines]`, `[unity]`, `[host]`, the orchestrator inbox | the dispatcher. A person's orchestrator cut off mid-turn by a restart is told to pick its turn up again |
| `[heartbeat]` | each person's own orchestrator, with that person's busy workers, when they turned it on |
| `[person message]` | the recipient's own orchestrator (message_person), and a notification to the recipient alone |
| `[work request]` marked intake | the dispatcher, once approved (by a reviewer, or an auto-approve rule for an obvious bug), gathered a minute at a time ([intake.md](intake.md)) |
| `[intake question]` | the reviewers' own orchestrators, when a worker on an intake request stops at a design decision |
| push notifications and in-page notices | a person's own orchestrator's only to that person; a worker's finished turn to the people it works for; the dispatcher's turns to nobody, its questions and errors to the owner |

`/mcp` `ask_orchestrator` and `orchestrator_transcript` talk to the key's person's own orchestrator.

## Loops, limits and safety

- The dispatcher reaches people only through ledger decisions, one reply per decision.
- A person's orchestrator files or updates at most 3 times, and follows up with one worker at most 3 times, between two
  messages of its person. Harness messages alone cannot keep it going.
- A person's orchestrator messages another person at most 3 times until that person writes to their own orchestrator.
- People are not capped per hour or per day (Ben, 2026-09-29): only the per-message budget above holds. Automated
  sources (standing agents, the Discord/FFBox intake, once they file here) get at most 10 requests an hour and 40 a
  day per requester, set per source in config `workLimits.standing` / `workLimits.intake` (`server/work.ts`
  `limitsFor`); repeats are free.
- Attribution on the dispatcher comes from the request (`work_id`). Without one, `for_user` must name someone its
  conversation shows asking, or the system payer; with neither, the tool refuses. "Whoever wrote last" is never used,
  because most of what the dispatcher hears is the harness.
- The dispatcher's destructive and admin tools (`delete_sandbox`, `set_app_config`, `request_app_update`,
  `republish_public`, `add_machine`, `remove_machine`, `create_standing_agent`, `update_standing_agent`,
  `delete_standing_agent`, `approve_delegation`; `server/belts.ts`) run only for a request its person filed or last
  changed in a turn of their own (`humanAsked`), or in a turn the owner started in the dispatcher's chat. A turn counts as
  a person's only when every message it answers is theirs: the CLI folds messages sent during a turn into it. Request
  text is written by a model that may be relaying injected text, so its "the user asked" is not enough. Recovery tools
  (`host_recovery`, `machine_daemon`) stay free.
- Only its person writes to a personal orchestrator, and only an owner to the dispatcher (HTTP 403 otherwise). This
  covers messages, interrupts, permission answers and the permission mode.

## What people see

- The home page is your own chat, as before.
- The sidebar lists, under it, the other people's orchestrators (read only) and the Dispatcher, with its open requests
  ("1 question · 2 active").
- The Dispatcher page has two tabs. Requests lists everyone's open requests, questions first, with the closed ones behind
  a link; a row opens to its brief, workers, overlaps and log. Conversation is the dispatcher's chat, which only the
  owner writes to.
- Decisions arrive in your chat as one-line notices ("Merged into w15: “Belts drop items…”") that open the request.
- A message from another person arrives in your chat as an amber notice, open, with their name and text ("Lothsahn:
  Could you run the firewall script on BEAST?"); Open goes to their chat. Until you open your chat, the sidebar's
  Orchestrator row has an amber count ("Unread: 1 message from Lothsahn"), and your devices get a "Message from
  Lothsahn" notification.
- Your heartbeat is your own.

## The first start

The shared chat becomes the dispatcher and keeps its conversation, so it starts out knowing what is in flight. Every
login gets its own orchestrator with one line saying where the old conversation went. The old global heartbeat becomes
the owner's. Pending `wake_me` wakes, standing agents and delegation requests carry on unchanged. Everything the harness
already sent to the shared chat still reaches the dispatcher, which is why the shared chat became the dispatcher rather
than Ben's own.

## Not in this version

- Delegation requests are not ledger items until their worker starts (then it is recorded), so a dashboard or
  automatic approval skips the overlap check.
- `/mcp` has `list_work` but not `request_work`.
- Roles are still not enforced: a member's work can go to the owner's machines if the dispatcher sends it there (its brief
  tells it not to).
- An idle personal orchestrator keeps its process until the server restarts.
- The dispatcher cannot `message_person`: it still reaches people only through ledger decisions.
- This host's sandboxes still run in the portal's own process. Moving them behind a daemon, as on the machines, is
  [backlog.md](backlog.md) item 1; the dispatcher already addresses a daemon's sandbox as `"<machine>/<name>"`, and
  nothing in the ledger or the routing depends on where a worker runs.
