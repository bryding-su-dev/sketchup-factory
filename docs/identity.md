# People: identity, attribution and whose account pays

Ben and Lothsahn share one FF Factory. Each has their own login and their own orchestrator chat
([orchestrators.md](orchestrators.md)), every message records who wrote it, and everything a message causes carries
that person as `requestedBy`. A
worker then runs on that person's Claude account when FF Factory holds one for them, and FFBox (from phase
3 of [ffbox-integration.md](ffbox-integration.md)) bills the work to that person's account on its side.

## Logins

- Each person has a login in `data/users.json`: a username, a scrypt hash, a display name and a role
  (`server/auth.ts`). The username is the **user id**. It never changes, and it is what FFBox maps to an
  account. The display name is what people and prompts see ("Lothsahn").
- Roles: `owner` (Ben, who runs the portal) and `member` (a teammate). The first login is the owner and
  later ones are members. A `users.json` written before roles existed reads every login as the owner.
  **Roles are recorded, not enforced yet.** The per-role limits (no M5 for a member, no `add_machine`,
  and so on) are phase 6 of the FFBox design, section 7.
- Manage logins on the host:

  ```
  node server/user.ts lothsahn --name "Lothsahn" --role member          # create, or change the password
  node server/user.ts lothsahn --name "Lothsahn" --role member --keep-password   # profile only
  ```

- `/mcp` API keys can be bound to a login: `node server/apikey.ts loth-laptop --user lothsahn`. Everything
  that key's tools start is requested by that person, and its `for_user` cannot name anyone else. A key
  minted before this change, or without `--user`, acts for the owner.
- `GET /api/me` returns the signed-in user's `userId`, `displayName` and `role`.

## Attribution

`Requester` is `{ userId, displayName }` (`shared/types.ts`). Where it is recorded:

| what | field | set from |
|---|---|---|
| a person's message, any chat | transcript `user` event `requestedBy` | the login that sent it (`server/index.ts`, `requesterOf`) |
| a message an orchestrator sends a worker (`message_agent`) | the event's `requestedBy` | a person's own orchestrator: its person; the dispatcher: the person it acts for (below) |
| a worker | `SessionInfo.requestedBy` | who started it: the login (Start agent), or the person the dispatcher acts for (`start_agent`): the filer of the request it serves |
| a person's own orchestrator | `SessionInfo.requestedBy` | its person |
| a work request | `WorkItem.requestedBy`, `requesters` | the person whose orchestrator filed it; a merge adds the merged request's people to `requesters` |
| the latest person a session heard from | `SessionInfo.lastRequestedBy` | set by people's and the orchestrator's messages, not by harness messages |
| a standing run | `StandingRun.requestedBy`, and the session's `requestedBy` for that run | the login that pressed Run now or wrote to it; the **system payer** for a scheduled run |
| a delegation request | `DelegationRequest.requestedBy` | whoever the run that filed it was for |
| a delegation approval | `DelegationRequest.approvedBy`; its worker's `requestedBy` | the person who approved it. An auto-approved worker is requested by the request's `requestedBy` |
| a `[worker update]` to a person's orchestrator | the event's `requestedBy` | that person |

### Who the orchestrators act for

Each person writes only to their own orchestrator, and its tools act for them. The model still reads each message
with a first line `[from <display name>]` (`server/sessions.ts`, `promptText`); the transcript keeps the text without
it. A worker hears an orchestrator's messages as `[from the orchestrator, for <name>]`.

### Every message names its sender (w389)

Every message from a person, or from an orchestrator on a person's behalf, reaches the model with a first line naming
whose it is, in every kind of session: `[from <name>]` when a person typed it (an orchestrator's chat, a worker's chat
in the dashboard, a standing agent's), `[from the orchestrator, for <name>]` when an orchestrator sent it. When the
portal does not know the person, the line says so (`[from a person the portal did not name]`, `[from the orchestrator,
for no named person]`); a message is never left bare. The line survives the send queue (it is added as the message is
delivered) and a restart (the resume's list of unanswered messages says `(from <name>)`; `server/restart.ts`,
`senderOf`). Harness messages carry their own tags (`[wake_me]`, `[worker update]`, …) and no person.

Why: on 2026-10-04 Lothsahn typed "Undo the release hold" in a worker's chat. A person's message to a worker then
arrived bare, and the worker's prompt said "The user (the person who runs this portal) is Ben", so it wrote "Release hold
lifted (Ben, 18:38 UTC)" into a PR description: a release decision Ben never made. Agents' prompts now name the owner
only as the one who runs the portal (`server/config.ts`, `ownerLine`), and say to attribute an approval, a hold, an
override or a decision only to the person a message names, writing "unconfirmed" and asking when it names nobody
(`SENDER_RULE`).

The dispatcher's tools (`start_agent`, `message_agent`, `run_standing_agent_now`, `approve_delegation`) act for the
person who filed the request they serve (`work_id`; `server/orchestrators.ts`, `dispatcherActor`). Without a
`work_id`, `for_user` may only name someone the last 200 transcript events show asking (`server/identity.ts`,
`actingFor`: the people whose requests it heard, or who wrote to it) or the system payer, so text an agent wrote
cannot bill a stranger. With neither, the call is refused, unless the owner is writing to the dispatcher in that turn.

### The system payer

Work nobody asked for is attributed to config `systemPayer`, a user id. Ben chose himself. It is settable with
`set_app_config systemPayer`, and defaults to the owner, which is also the fallback when the id names no
login. It applies to scheduled standing runs now, and to intake-triggered FFBox diagnoses from phase 4
(`trigger: "automatic"`, contract below).

### Where it shows

- Agent tabs show the person's name, and the phone's agent switcher adds "for <name>". An agent's details
  show "for <name>".
- In an agent's chat, messages from someone other than the person it works for have their name above them. A
  person's own orchestrator only has their messages.
- Standing runs show who started them by hand, and delegations show "approved by <name>".
- `[worker update]` lines say "(requested by <name>)".

## Local billing: a person's own Claude token

This covers work Lothsahn asks for that runs on Ben's machines: BEAST sandboxes and the M3. Lothsahn has no
access to the M5.

- Config `userClaudeEnv` holds a Claude env per user id, for example
  `{ "lothsahn": { "CLAUDE_CODE_OAUTH_TOKEN": "<his claude setup-token>" } }`. Set it with
  `set_app_config userClaudeEnv.CLAUDE_CODE_OAUTH_TOKEN` with `user: "lothsahn"`. The value is write-only:
  it reads back only as `set (…abcd)`, and it is redacted from transcripts like `claudeEnv`
  (`server/secrets.ts`).
- An agent's Claude env is `claudeEnvFor(requestedBy)`: the person's entry laid over the owner's, which is,
  on this host, the token or this host's login as config `claudeAccounts` picks per role, and, on a Mac,
  the token or the Mac's login as `machines.useHostClaudeEnv` picks ([accounts.md](accounts.md)). A person
  without an entry runs on the owner's account (`server/identity.ts`). This applies to sandbox workers
  (`workerOptions`), Mac workers (`machineWorkerSpec`) and standing runs on either (`standing.ts`, `place`).
- The env is fixed when an agent's process starts. A worker keeps the account of the person who started it.
  A message from someone else is recorded, but it does not move the worker to another account.
- A person's own orchestrator runs on their entry when they have one, otherwise on the owner's orchestrator account
  (the host token, or this host's login with `claudeAccounts.orchestrator: "login"`); `system_status` names who is on
  the owner's. The dispatcher runs for the system payer, on their entry if they have one.
- The usage meters list each person's token as its own account ("Lothsahn's token …abcd", "agents working
  for Lothsahn"). It is polled like the host token, with that token alone (`server/usage.ts`).

## FFBox

The phase 3 work messages (`submit`, `diagnose`, `stop`) each carry `requestedBy` and `trigger`, and never a
credential. FFBox picks the account by `requestedBy.userId`. With no account for that person it refuses the
work and never falls back to another person's account. The contract is in
[ffbox-connector-contract.md](ffbox-connector-contract.md), "Work messages". FF Factory does not send work to
FFBox yet.

## Follow-ups

- **Roles, enforced** in the tool handlers (the table in ffbox-integration.md, section 7). A member cannot
  use the M5, and in a turn that answers both people the narrower role applies.
- **The accepted/refused handling** when phase 3 wires `submit`: record `billedTo` and flag a mismatch with
  `requestedBy`. Show a refusal (`unknown_requester`, `no_account`) to the person who asked.
- **Low-privilege workers.** A login that can start a BEAST worker is, in effect, a shell as Ben's Windows
  user (README, "Known gaps"). Ben's open question 9 decides whether Lothsahn's login waits for that fix.
