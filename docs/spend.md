# What a request costs: dollars, tokens, transcripts (w859)

Lothsahn, w859: "I would like you to track the per workitem spend as well as the transcript so we can optimize token usage."
And: "We should keep worker transcripts and numbers for at least 7 days. But make sure we don't run the portal out of disk."

**TL;DR:** every turn of every agent is now priced from Claude Code's own per-turn usage (the SDK result's `modelUsage`: input,
output, cache read and cache write tokens and dollars, per model) and added to the request the agent was on when the turn began.
`data/spend.json` keeps, per request (`wNNN`), its dollars and tokens per model and per session, and where the context tokens went.
It outlives both the ledger (which drops a request a week after it closes) and the transcripts. A request's transcripts are kept
**7 days after the request closes** (while it is open: for as long as it is open), and a disk guard compresses and, only past
that, deletes transcripts as the disk fills. Everything labelled *estimated* below is one of: a turn that ran before this
existed (tokens estimated from its dollars), a daemon too old to send usage (dollars only), or the split of a session's context
among kinds of content (always an estimate; the totals it splits are not).

## Where to read it

| | |
|---|---|
| `list_work` | each request's line ends `Cost so far: $12.34 (3 session(s); in …, out …, read …, write …)`; `list_work` with an `id` adds the full spend (below) |
| `read_work` (workers) | the same cost line on their own requests |
| `spend_report` (orchestrators) | no argument: the last 7 days' top requests with where their tokens went, cost by kind of work, where the money goes inside sessions, the transcripts' footprint. `days`, `top`; `request: "w859"` one request in full (models, every session with tokens, cost and a link to its transcript, how long each transcript is kept); `session: "<id>"`; `footprint: true` |
| Dashboard | Dispatcher page: a cost on each request's row, a **Spend** block in its opened row (models, sessions with transcript links, categories), and a **Spend** tab: the analysis |
| HTTP | `GET /api/spend/summary`, `/api/spend/request/<id>`, `/api/spend/report?days=7&top=10` |
| Scripts | `scripts/transcript-footprint.ts <data dir>` (the three transcript measurements, exact, read-only, run on the portal host); `scripts/spend-claude.ts` (the same analysis over a machine's own `~/.claude/projects` transcripts: sessions that ran before this existed, and any machine's, without the portal) |

A **request page** (the opened row) lists every session that worked on the request with its tokens and cost, its role
(worker, dispatcher, personal orchestrator, ops worker, standing agent) and a link to its transcript (`#/session/<id>`), and says
when each transcript may be deleted.

## What is recorded, and where it comes from

`AgentSession` (server/sessions.ts `turnUsage`) puts on each `result` line of a transcript: `usage.cum`, the SDK's cumulative
per-model totals at the turn's end (`result.modelUsage`: tokens and `costUSD`), `usage.main` (`result.usage`, the main loop's own
tokens for the turn) and `usage.meter` (the context reading, below). The same code runs on the machines' agent hosts, so a
machine's result lines carry it too. `Store` (server/store.ts) tells `SpendStore` (server/spend.ts) of every event appended, for
sessions here and on machines alike (`appendFull` and `append`).

The turn's spend is the **difference** between `cum` and the last `cum` seen for that session (`SpendStore.delta`):
- a session's first result, when its transcript holds no earlier result: `cum` is the turn (exact);
- the SDK says a resumed session continues from its saved totals, so the first result after a resume already holds the earlier
  turns: the difference against the stored totals is still the turn;
- totals that start again (a `/clear`; half of the old figure or less): counted in full;
- a session that ran before this existed, at its first result after the deploy: its totals hold all its history, so this turn is
  `usage.main` priced at list prices, marked estimated; from the next turn on it is exact;
- a daemon that does not send `usage` yet: dollars from the difference of `total_cost_usd` (`costUsd` on the result line), no tokens, marked estimated;
- a compaction (`/compact`, automatic or by hand) writes no result line of its own; its cost is in `cum`, so the next turn carries it.

Dollars are the SDK's `costUSD` (which, on the recent sessions checked, equals the calls' list prices to within 0–3%, below).

## Which request a turn belongs to

`attribute` (server/spend.ts), at the moment a turn's result arrives, from the messages that began it and the ledger as it stood:

| Session | The turn goes to |
|---|---|
| worker | the request in an `[about wNNN …]` line of a message that began the turn (a follow-up from an orchestrator names its request); else the request it was last sent: the ledger's `links` as they stood when the turn began (`servedAt`: the latest `sent` and the `linked` since, as `servedBy` in shared/workState.ts does, but at the turn's start, so a message that arrived mid-turn does not move it); else the `wNNN:` prefix of its title; else `_unattributed` |
| dispatcher, a person's orchestrator | the requests (in the ledger) named in the first lines of the messages that began the turn (`[work request] w859 …`, `[worker update] …`, `[dispatch] …`), split evenly, at most 4; none: its own bucket (`_dispatcher`, `_personal:<user>`) |
| ops worker | the requests its job messages name; else `_ops` |
| standing agent | `_standing:<id>`; the workers its delegations start are ordinary requests (the delegation's work item) |

A turn on several requests (linked requests share a worker) is split evenly between them; the share is recorded (`shared`) and
shown. Overhead that no request owns is listed apart (`spend_report` "Not any request's"). A request's `tied by` line on its page says how
each session's turns were tied: `about`, `link`, `message`, `bucket`, `backfill`.

## Where the tokens go inside a session

Claude Code reports how big each model call's context was (input, cache read, cache write), never what is in it. The
`ContextMeter` (shared/spend.ts) shares each call's real token counts among the kinds of content the context holds, by characters:
cache reads go to what was in the context before the call, cache writes and uncached input to what is new since the previous
call, output tokens to the agent's own text. The agent's own output (thinking included) is carried in the next call's
context exactly (the fit below: 1.01 tokens per output token), so it is counted by tokens, not characters. What no content explains is `base`
(the system prompt, tool definitions, CLAUDE.md, skill lists, reminders). Categories come from what the week's tool results held
(`toolKind`): `file-read` (Read, `sed -n`, `cat`, `head`), `reread` (a range of a file already read in the session; `afterCompact`
when the summary dropped it), `search`, `git`, `ci-poll` (`gh pr checks`, `gh run`, `sleep`/`until` loops, Monitor, wake_me),
`build-test`, `shell`, `edit`, `mcp-unity`, `mcp-machine`, `web`, `subagent`, `brief` (messages to the agent), `summary` (after a compaction), `assistant`, `base`.

**Calibration (measured, 2026-10-10, beast, last 7 days, 52,187 calls):** a least-squares fit of the tokens a call wrote (cache
write + uncached input) on the characters of tool results and messages since the previous call, and that call's output tokens,
gave 0.431 tokens per character (2.32 characters per token: JSON, paths and escapes tokenize densely), **1.01 tokens per previous
output token** (the carried output, thinking included) and 96 tokens a call of nothing visible (reminders, hook output: they fall in
`base`). `CHARS_PER_TOKEN = 2.3`, `OUTPUT_TOKENS_PER_CHAR = 0.75` (30.8M output tokens for 40.9M visible characters: a third of the output is thinking
no transcript shows). With the 3.5 first guessed, `base` read 54% of the money; with the measured 2.3 and exact output tokens, 25%.
The first call of a session reads a median 54k tokens of base (p10 34k, p90 58k, 206 sessions): skill list ≈ 8k, CLAUDE.md and
instructions ≈ 7.7k, a prompt snapshot ≈ 6.5k, agent and deferred-tool lists ≈ 4.5k, MCP instructions ≈ 1k (characters ÷ 3).

A category's dollars are its share of the request's measured dollars: the split is an estimate, the sum is not.

## Transcripts: how long they are kept

**Seven days after the request closes**, a request that is open keeps them as long as it is open, a reopened request keeps them again.
(Lothsahn's note said "at least 7 days"; counting from the close rather than from the last write means a long request's
first worker is not pruned while the request still runs, and a short one is kept a week after it ended. `dataGuard.retainDays`.)
A session that served several requests is kept until the last of them is past it. A personal orchestrator's, the dispatcher's and
the ops worker's own conversations are never pruned (they are the chat). Before this change nothing pruned a transcript at all; only
`delete_sandbox` and the dashboard's delete removed one with its session, and `SessionManager.remove` now leaves the
transcript on disk while its retention runs (`keepTranscript`); the guard deletes it when it ends. The cost record never goes with a
transcript: `data/spend.json` keeps requests (with their title, kind and close time) and sessions, 1 to 2 KB each.

## The data guard (server/dataGuard.ts)

Runs 3 minutes after the portal starts and every `dataGuard.everyMinutes` (60). By how full the disk holding `data/` is:

| Disk used | Does | Why |
|---|---|---|
| under 50% (`gzipAtUsedPercent`) | nothing | lothsahn's reading: 4.4 GB of data on a 95 GB disk, 19% used. |
| from 50% | compresses (gzip -9, written beside, read back and compared, then the plain file removed) every transcript idle for a day (`gzipIdleHours`), biggest first | lossless; the store reads `.gz` (and search, and `agent_transcript`) and a session that is resumed gets its plain file back first. Compression is cheap, and it runs well before pressure. |
| from 75% (`pruneAtUsedPercent`) | deletes transcripts whose retention has ended, oldest first, until the disk is 5 points below 75% | only past the 7 days; never a running session's; never one that belongs to an open request |
| from 90% (`alertAtUsedPercent`) | if that was not enough, says so: the log and a host notice to the owner, at most once a day, with what it could free and what sits inside the window | it never deletes inside the window: a person decides (a bigger disk, a shorter `dataGuard.retainDays`) |

The percentages are guesses: nothing in the portal's data says what a good number is, and the disk is 95 GB. They rest on
(measured) beast's own Claude Code transcripts, which are the nearest thing to the portal's on hand: **0.26 GB a day**
(2026-10-03 to 09, from the lines' own timestamps; 0.15–0.43 a day), **gzip ratio 0.21** on their text lines (0.65 on the biggest
files, which carry base64 screenshots the portal keeps apart), so 7 days are about 1.8 GB plain and 0.4 GB compressed, 2% of 95 GB.
The portal holds every machine's agents, not only beast's, and its lines are clipped (tool results at 6,000 characters) and
carry no usage, so **the real figures need one run on the portal host**:

```
node scripts/transcript-footprint.ts <data dir>
```

prints today's size, the bytes written per UTC day (exact, by each line's own time), the mean of the last full days, the
projection at 7 days and the gzip ratio on a sample. `spend_report footprint:true` and the Spend tab show the same, less exactly
(file birth time). Set the three percentages in `config.json` as `dataGuard`; the defaults are 50 / 75 / 90, 7 days, 24 h, 60 min.

## Backfill

90 seconds after the portal starts, once, in the background (10 sessions then a short pause, newest first), `SpendStore.backfillSession`
reads each session's transcript that the record has not seen. Dollars are the recorded `costUsd` of the result lines, differenced
(the SDK's, as the portal stored them then); **tokens and the model split are estimates**: a turn's output tokens from the
characters the agent wrote (× 0.75), its cache writes from the characters it and its tools wrote (÷ 2.3), and what the dollars have
left as cache reads at the model's list price. Each backfilled turn is tied to its request by its messages' `[about]` line, the
ledger's links (for requests still in the ledger), the `wNNN:` title prefix, else `_unattributed`; all of it is in
`estimated`, shown as "backfilled or estimated: its tokens are estimates", and the Spend tab says how many sessions, turns and
dollars were backfilled and when. It never counts a turn twice: only events before the first one recorded live (`liveFrom`).
It cannot know a pre-existing session's cache split exactly, nor its context readings: none for backfilled turns.

## Limits

- A machine's daemon sends `usage` (tokens per model, context readings) only after it has this code; until then its turns are
  dollars only and estimated. `machine_update` (the ops worker) brings a machine up to date; the portal needs a deploy first.
- Attribution rests on the ledger's `links` and the messages. A message that names two requests for a worker in one go splits the turn
  evenly. An orchestrator turn that names no request is overhead, not any request's.
- The categories are by characters. Tool results are clipped to 6,000 characters in the transcript but counted whole by the meter (it sees them before the clip).
- A turn is tied to the messages its result answers (`answers`), so a message that arrives mid-turn belongs to the next turn. A new agent
  process whose totals started again (the SDK did not carry the saved ones) says so (`usage.restarted`), and its first turn counts in full.
  A daemon too old to send usage, at its first result on a session that already had turns, records $0 for that turn (the backfill skips it too).
- The guard compresses and the backfill reads on the pool and yield between files, but one big transcript parse is one blocking step (a few hundred ms).
- `data/spend.json` is never pruned (1 to 2 KB a request and a session; rewritten whole at most every 10 s). Prune it by hand if it grows past a few tens of MB.
- Prices (shared/spend.ts) weigh the shares and price the estimates; every dollar called measured is the SDK's.
- The first reading below is beast's alone (its Claude Code transcripts; no other machine's, and not the portal's orchestrators).

## First reading: beast, the last 7 days (2026-10-03 to 10, `scripts/spend-claude.ts`, measured)

Tokens per call are the API's own; dollars are those tokens at list prices (checked against the CLI's own totals, below). 206
sessions, 44,220 model calls: **$4,661** (cache read 16B tokens $3,178 = 68%, cache write 136M $994 = 21%, output 27M $489 = 10%,
uncached input 89k). The CLI's `cost-state` totals agree with the calls' list prices to the cent on every session from 2026-10-08
on (ratio 1.00, 1.00, 0.97 on the 10th, which is in progress); before 10-07 its totals are short (session 8c24c8d7: calls $265, CLI $13),
so the older days are the calls' arithmetic, which matches the CLI exactly where the CLI is complete.

By day and model: 10-03 Opus $701; 10-04 $790; 10-05 $792; 10-06 $944; 10-07 $450; 10-08 Sonnet $181 + Opus $127; 10-09 Sonnet $384 + Opus $48;
10-10 (part) Sonnet $174 + Opus $70. The drop is the 10-08 switch of workers to Sonnet 5.5.

Top requests by cost (beast only; a request is the one a session's first message names, or its `[about]` lines later; an old-format
brief ("Goal: …") that names only a related request can be tied to that one, so treat a title below as the session's, not as
certain; the portal's own attribution uses the ledger and is exact):

| # | Request | Cost | Sessions / calls | Mean context | Where its tokens went (share of its dollars) |
|---|---|---|---|---|---|
| 1 | `_chat`: two or three person-to-orchestrator chats from before the portal's orchestrators (not a request) | $445 | 3 / 3,292 | 464k | 1,834 calls after a message $293, machine tools $101 |
| 2 | w259 mass driver features (and a colour-picker session that names it) | $284 | 2 / 2,122 | 504k | own output 43%, base 24%, file reads 14%, search 5%, shell 4% |
| 3 | `_worker-no-id`: 17 workers whose brief names no request (before the numbering) | $266 | 17 / 2,638 | 325k | file reads $53, shell $39, search $38, Unity tools $37 |
| 4 | w256 landing-zone ghost | $218 | 2 / 1,695 | 488k | own output 44%, base 20%, file reads 15%, search 6% |
| 5 | w294 Unity's blocking editor dialogs | $136 | 1 / 867 | 467k | own output 36%, base 31%, file reads 16%, search 9%; $22 to write the context again after the cache went cold |
| 6 | w510 (and a ledger PR-state session that names it) | $106 | 2 / 852 | 449k | own output 37%, file reads 22%, base 19%, search 10% |
| 7 | w727 Steam Deck UI scale (w723 resumed) | $76 | 1 / 400 | 767k | own output 40%, base 20%, file reads 19%; 50 CI-poll calls $8 |
| 8 | w334 Plasma Bolt | $69 | 1 / 587 | 433k | own output 40%, base 26%, file reads 19% |
| 9 | w426 (the dispatcher's turns about it) | $68 | 1 / 681 | 336k | 437 calls after a message $48, machine tools $17 |
| 10 | w668 Command Core panel | $68 | 1 / 564 | 476k | own output 49%, base 15%, file reads 14%, Unity tools 7% |

By kind of work (titles are the session's opening, so "other" is large): other $1,742 over 66, ops $767 over 39, no request $756 over 5, bug fix $737 over 33,
feature $309 over 26, investigation $251 over 24, release $51 over 7, review $51 over 3.

Where the money goes inside sessions (context shares by characters, applied to the measured dollars): the agent's own output
and thinking, carried in every later call, 39% ($1,836); base 25% ($1,158; the median first call reads 54k tokens); file reads 14% ($671);
searches 6% ($267); messages 4% ($174); shell output 3% ($151); git 2% ($105); Unity tools 2% ($90); machine tools 2% ($87); builds and tests 1% ($68);
CI polling 1% ($26); re-reads 0.3% ($14). Calls by what made them necessary (the kind of result they follow; every call re-reads
the whole context): after a message 4,925 calls $997 (21%, $0.20 a call against $0.09 for the rest), after a file read 6,997 calls $706,
shell 6,331 $600, search 6,241 $517, Unity tools 5,617 $446, builds and tests 3,654 $381, git 3,368 $318, machine tools 2,667 $280, CI polling 2,860 $263.

### The biggest opportunities, each with its measured size

1. **Workers never compact, and long contexts are most of the money.** Calls that read more than 400k tokens cost $2,707 of the
   $4,663 (58%); more than 700k, $1,145 (25%); 59 of the week's 206 sessions ended above 400k. Compactions seen: 19 in 44,242 calls.
   Each call re-reads the whole context (cache reads are 68% of the money), so cost grows with calls × context. *Modelled* from the
   measured growth of every call (compact whenever the context passes the threshold, down to 85k = base + summary + files read
   again, the compaction's own call included): 150k saves $2,354 (50%), **200k saves $2,240 (48%, 468 compactions)**, 300k saves $1,866 (40%).
   On the last three days alone (workers on Sonnet since 10-08): $1,307 → $765 at 200k (saves $541, 41%). Orchestrators already
   compact at `orchestrator.compactAtTokens` (200k); workers have no equivalent (w740 notes it).
2. **A big context written again after a long wait.** 123 calls came after a pause of over an hour and wrote most of their
   context again: $363 for those calls, **$352 more than reading it from the cache (7.5% of the week)**, $2.82 a call against $0.09
   (last three days: $42 more, 3%). The waits are CI, builds and people. Compacting before a wait, or ending the turn on a request
   that waits and starting a fresh session after, removes it.
3. **Opus.** 84% of the dollars. The same calls priced as Sonnet 5.5: $3,921 → $3,258, **saves $664 (14% of the week)**; cache reads cost the same on the two ($0.20 a million), so the
   gain is writes and output. Since the 10-08 switch Opus is still $245 of $984 (the dispatcher's and orchestrators' chats, the nightly sentry's verifiers): repriced, those save about $100 over three days.
4. **Waiting calls.** Calls that follow a CI-poll, wait or Monitor result: 2,860 calls, $263 (5.6%); 50 CI-poll calls in w727 alone cost $8.
   `blocked_on` and `wake_me` already take a worker out of the loop; the $263 is the part that still polls.
5. **Orchestrator chats.** The person-to-orchestrator chats (`_chat`, three sessions): $445 over 3,292 calls at a mean 464k context (largest 968k), 1,834
   of those calls after a message ($293). They ran uncompacted far past the 200k default; the same threshold as in 1 applies.

What is small, measured, and not worth the effort: re-reading a range of a file already read: 288 re-reads, $14 (0.3%), 18 of them after a
compaction. Trimming the base context: every 10k tokens off every session's first call saves about $96 a week
(10k × 44,242 calls × $0.20 per million, plus one write per session), 2%. Thinking is a third of the output tokens (9.3M of 27M), about 3% of the money.

## Changing it

The portal's own `data/spend.json` is written like `work.json` (`SnapshotFile`, crash-safe, at most every 10 s). The format
version is 1; a field added later is optional. The record is not part of `state.json`.
