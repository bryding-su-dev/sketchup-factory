# What a request costs: dollars, tokens, transcripts (w859)

Lothsahn, w859: "I would like you to track the per workitem spend as well as the transcript so we can optimize token usage."
And: "We should keep worker transcripts and numbers for at least 7 days. But make sure we don't run the portal out of disk."

**TL;DR:** (w1160: a request's headline cost is its **workers' own** cost; the dispatcher's, orchestrators' and ops worker's turns on it are its **coordination**, billed beside it, see "Coordination".) Every turn of every agent is now priced from Claude Code's own per-turn usage (the SDK result's `modelUsage`: input,
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
| `spend_report` (orchestrators) | no argument: the last 7 days' top requests (by the workers' own cost, coordination beside it: see "Coordination") with where their tokens went, cost by kind of work, where the money goes inside sessions, the transcripts' footprint. `days`, `top`; `request: "w859"` one request in full (models, every session with tokens, cost and a link to its transcript, how long each transcript is kept); `session: "<id>"` (its top 20 requests by cost and a count of the rest; `requests: N` lists up to 2,000, w1159); `footprint: true` |
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
  totals that grew on every count since the last result are always this case, even when the result says `restarted` (w1161);
- `restarted` (server/sessions.ts `firstResultBase`): a process's first total below the CLI's own total at the session's last
  result (`SessionInfo.sdkCostUsd`), so the CLI began again from zero. Before w1161 the portal compared with its own figure
  (`costUsd`), which runs ahead of the CLI's total once a process starts from zero; from then on every resume was flagged, and
  each portal restart counted the CLI's whole running total again: the dispatcher's and orchestrators' first turn after a restart
  read $165 to $215 (portal journal, auto-compact lines, 2026-10-11..12), 59 dispatcher turns billed to w605 at $1,836;
- totals that start again (a `/clear`; half of the old figure or less): counted in full;
- a session that ran before this existed, at its first result after the deploy: its totals hold all its history, so this turn is
  `usage.main` priced at list prices, marked estimated; from the next turn on it is exact;
- a daemon that does not send `usage` yet: dollars from the difference of `total_cost_usd` (`costUsd` on the result line), no tokens, marked estimated;
- a compaction (`/compact`, automatic or by hand) writes no result line of its own; its cost is in `cum`, so the next turn carries it.

Dollars are the SDK's `costUSD` (which, on the recent sessions checked, equals the calls' list prices to within 0–3%, below).

## Which account a turn ran on (w1031)

Every turn is also added to the Claude account its process ran on: `SessionInfo.ranAs`, set when a process starts (a worker's launch
spec names it: "vault token vault-lothsahn-1 …EAAA (lothsahn's pool, docs/vault.md)"; before w1078 also "host token …9AAA"; only the last four
characters of a token ever appear). `spend.json` keeps it per request and per session (`accounts`), `spend_report` prints "By Claude
account the turns ran on" and, for one request, "Per Claude account", so a request taken over by another person (docs/vault.md
section 10) shows the turns before the switch on one account and after it on the other. A host session (an orchestrator, the
dispatcher) shows its account key; a turn from before w1031, or a backfilled one, is "not recorded (before w1031)".

## Which request a turn belongs to

`attribute` (server/spend.ts), at the moment a turn's result arrives, from the messages that began it and the ledger as it stood:

| Session | The turn goes to |
|---|---|
| worker | the request in an `[about wNNN …]` line of a message that began the turn (a follow-up from an orchestrator names its request); else the request it was last sent: the ledger's `links` as they stood when the turn began (`servedAt`: the latest `sent` and the `linked` since, as `servedBy` in shared/workState.ts does, but at the turn's start, so a message that arrived mid-turn does not move it); else the `wNNN:` prefix of its title; else `_unattributed` |
| dispatcher, a person's orchestrator | the requests (in the ledger) named in the first lines of the messages that began the turn (`[work request] w859 …`, `[worker update] …`, `[dispatch] …`), split evenly, at most 4, as that request's **coordination** (below); none: its own bucket (`_dispatcher`, `_personal:<user>`) |
| ops worker | the requests its job messages name; else `_ops` |
| standing agent | `_standing:<id>`; the workers its delegations start are ordinary requests (the delegation's work item) |

A turn on several requests (linked requests share a worker) is split evenly between them; the share is recorded (`shared`) and
shown. Overhead that no request owns is listed apart (`spend_report` "Not any request's"). A request's `tied by` line on its page says how
each session's turns were tied: `about`, `link`, `message`, `bucket`, `backfill`.

### The rules as they stand (w1209 audit)

- **Money is conserved.** A turn's dollars are the SDK's difference of cumulative totals; `attribute` returns weights that sum to 1, so every
  dollar of a session is in exactly one share of requests and buckets (`_dispatcher`, `_personal:<user>`, `_ops`, `_standing:<id>`,
  `_unattributed`). Tested: workers' own + coordination + not-any-request's = the window's total, and requests + buckets = sessions, for a mix
  of every kind of session (spend.test.ts "whatever the mix of turns").
- **A coordinator is never billed through the worker rules.** The session's role (`dispatcher`, `personal`, `ops`, `standing`) comes from the
  session when it is live and from the record when the store no longer holds it (`infoOfRecord`); before, a turn of such a session fell through
  to the worker rules (`_unattributed`) and its role would have been rewritten.
- **A worker's linked requests that closed before the turn began are left out** while another is open (`openFirst`): the ledger never unlinks a
  request, so a worker that finished w1 and went on with w2 used to put half of every later turn on w1. A reopened request is open again; all
  closed: they share it, the money has to go somewhere. An `[about]` line is always taken as written.
- **Ids inside parentheses in a harness notice are citations** (`[machines]`, `[app restarted]`, `[restart]`, `[host]`, `[heartbeat]`,
  `[data restored]`, `[machine updates]`), not the turn's subject. The coordinators' rule text is the system prompt, never a message, so it is not read at all.
- **Where the tokens go: `carried`.** The context meter starts empty with each process. A conversation resumed after a restart reads a
  context it never saw built, and that read used to count as `base`. The first call of a resumed process now puts that unexplained cache read in
  `carried` (and later calls keep reading it as carried). Dollars and attribution are unaffected either way: it moves a share of a request's
  dollars between two categories.

### Corrections to history (w1209)

Two rules changed in the a9d5eae restart (2026-10-13 01:52:30 -06:00, `RULES_FROM_MS`), and the turns recorded before it by the old ones were wrong:

| | Old rule | Cost, measured | Now |
|---|---|---|---|
| A restart's first result | the CLI resumes from its saved running total, so the portal read the whole total as one turn (`delta`, w1161) | the portal's own auto-compact lines on 2026-10-12 give 7 such turns of $197.89 to $215.30 for the dispatcher and the two orchestrators, **$1,456.89** in one day; the same applies to every resumed worker (not measured) | the difference against the last totals |
| An id cited in parentheses in a harness notice | billed the turn to that request (`namedIdsIn`, w1160) | w605: $1,836 (60 dispatcher turns) | the turn is the coordinator's own |

`SpendStore.correctHistory` records those turns again by the current rules, once per session, 150 seconds after the portal starts, in the
background (`repairSpend` in server/index.ts, which first keeps a copy of the record as `spend.json.pre-w1209`): the transcript is replayed twice, by
the old rules and by the current ones, and for each live-recorded turn the two read differently the old reading is taken out and the current one put
in, in the session and in every request it touched. It changes the record by the difference and nothing else (the context categories come from the calls' own
usage and do not move). The turns the backfill estimated from the portal's cost totals (before the live recording started) carry the same double count in another form: the portal's own
total doubled at a restart, so the turn after it reads as the whole running total again. A backfilled turn that costs at least 90% of what the session had cost so far, from $20
up, is that restart and nothing else (a real turn cannot cost as much as the whole session so far), and what it really cost is what is left over; its tokens are estimated again from that.
It refuses a session whose replay does not explain its recorded total within 5% and says so in the journal
(`spend repair: … left as recorded`); a session whose transcript is gone, and every turn backfilled before the live recording started, stay as recorded. A coordinator's
coordination days are rebuilt from the corrected record.

### Audit findings (w1209, 2026-10-13; measured = from the portal's `spend_report` on 3c98743 or its journal, estimated = said so)

| # | Finding | $ | Where | Fixed |
|---|---|---|---|---|
| 1 | The restart notices cited "(w605)" and billed the dispatcher's restart turns to it | measured: w605 coordination $1,836 over 7 days, $1,475 of it 10-11 and 10-12; after the repair $0.49 (its real mentions) | machines.ts:802 and agents.ts:1168 texts, `namedIdsIn` | going forward in a9d5eae (#362); history by `correctHistory` |
| 2 | After the first fix w605 read as $1,475 of *worker* cost in a 3-day window | measured | the first split's replay (spend.ts `rebuildCoordination`) | #381 |
| 3 | A restart counted the CLI's whole running total as one turn | measured, before and after the repair (spend_report, 2026-10-13 14:10Z and 15:35Z): 3 days total $14,908 → $5,563, coordination on requests $8,117 → $226, not any request's $1,630 → $413, workers on requests $5,161 → $4,924 (-$237: resumed workers too; w1063 $270 → $153); 7 days total $23,034 → $12,073, coordination $9,674 → $701. The portal's own lines: $1,456.89 on 10-12 for three coordinators | `delta` (w1161) | going forward in a9d5eae; history by `correctHistory` |
| 4 | A worker kept its closed requests linked and put a share of every later turn on them | not measured (needs the ledger's links over time) | `servedAt` | `openFirst` |
| 5 | A coordinator whose session the store no longer holds was billed through the worker rules | not measured; no case seen | `record` → `attribute(info undefined)` | `infoOfRecord` |
| 6 | A resumed conversation's context counted as `base` | category only, no dollars: base is 71% of in-session spend in the last 3 days (measured), the part that is resumed context is not separable from the record | `ContextMeter.call` | `carried` going forward |
| 7 | A bucket's request view labelled its days "workers" under a "coordination" header; `_unattributed` answered 87,000 characters | presentation | `renderRequest` | one figure per day; 25 sessions then a count |
| 8 | A turn that names several requests is split evenly over the first 4 | no loss or double count (weights sum to 1, tested); a batch of messages naming different requests puts the whole turn on the first four: not measured | `attribute`, `namedIdsIn` | not changed. After the repair coordination is $701 of $12,073 in 7 days (5.8%) and not-any-request's $679, so a per-message weighting could move a part of $701 between requests: not worth a second method (a guess at the size, from those two figures) |
| 9 | The repair's first release took each turn out of, and put it back on, the session's biggest account, so other accounts read negative | measured: token:5d6d575eda30 -$2,018 and token:0d94ad2b5488 -$1,428 in the 7-day report (-$565 and -$757 in 3 days) | `correctHistory` `add(account)` | spread by the session's own mix; the accounts of the 11 sessions corrected are rebuilt from `spend.json.pre-w1209` (`repairAccounts`, an estimate for the requests) |
| 10 | The backfilled (estimated) part has the same restart double count, by the portal's doubled own total | measured: the repair on d00bfa8 took **$72.52** out of 3 backfilled sessions (the signature: a turn that cost at least 90% of the session so far, from $20 up), against $10,980.08 in the live part. The largest 7-day coordination, w863 $68.10 (dispatcher $67.35, 9 turns) and w788 $66.87 (dispatcher $66.75, 5 turns), both on 10-10 and all estimated, were NOT restart double counts: $7.5 and $13 a turn is not the running total (about $100 or more on 10-10). Most likely real, heavy dispatcher turns (a release's CI polling); not provable, because a backfilled turn has no per-call usage ("a context reading of 1 model call") | `backfillSession` `d` | `correctHistory` (fixV 2) |
2,073 | `backfillSession` `d` | `correctHistory` (fixV 2) |

**Checking the restart repair against the transcripts** (measured by the orchestrator in /srv/fff/data/transcripts, 2026-10-13; the conclusion is mine):
the dispatcher's transcript (f8862ae9) has `"restarted":true` on 22 result lines; at the two restart lines with a value on each side the
CLI's total CONTINUED (line 31875 → 31880: 198.0636 → 198.1108, the turn cost $0.05; line 31968 → 31974: 199.4973 → 199.5540), and its
`cum.<model>.usd` equals `costUsd` in every line sampled (last 243.73). The old rule counted ~$198 for each of those restart turns. 22 such lines at a
running total of about $100–245 is about $3.6k–4.3k; the repair took $3,648 off this session ($5,167 → $1,519). Its live-recorded part now
is about $275 against a final running total of $243.73 (lothsahn's orchestrator $134 against $253.17, Ben's $269 against $226.93, estimated: the rest of
each session's total is backfilled from the older `costUsd` lines and cannot be checked this way). Drops of `costUsd` exist but early (a fresh process
or a /clear, e.g. line 227 → 246) and without the flag; both rules count those in full. Only 2 of the 22 restart lines were sampled with a value on each
side: the full list of drops is not pulled.

Not any request's, after the repair: $413 in 3 days (Ben's orchestrator $185, the dispatcher $172, lothsahn's $42.23, the sentry $7.44, ops $6.11) and $679 in 7 (measured).
They are conversations and heartbeats that name no request, not misbilled worker spend. In the 7-day window $5,513 of $12,073 is under "not recorded" as an account
(turns from before w1031 and backfilled ones: estimated, $6,203 of the window).

## Coordination: billed apart from the workers' own cost (w1160)

Lothsahn, w1160: "We should still track per request, but bill it separately." The dispatcher's, a person's orchestrator's and the
ops worker's turns (the **coordinators**) are still counted for the requests their messages name, but as that request's
**coordination**, beside its **workers' own cost**, never inside it. Before, w605 read $1,836 and w979 $308 over 2026-10-10..12, nearly all
of it dispatcher and orchestrator turns that happened to name them (the orchestrator's reading of that window's top 20: about $5.8k of $6.9k
was coordinator spend; an estimate, not a measurement).

| Where | Shows |
|---|---|
| `spend_report` (default) | one line: *the workers' own cost on requests $A; coordination on requests $B (dispatcher $, Lothsahn's orchestrator $, ops worker $); not any request's $C* (A + B + C = the window's total, with no turn counted twice). **Top requests are ranked by the workers' own cost**; each row reads `workers $X, coordination $Y (by coordinator)`. A short list "Most coordination on a request" ranks by coordination, so a request with no worker cost still shows. Kinds of work are the workers' own cost, with coordination beside it. "Where it went" (the category split) and "by model" and "by account" stay over every session, coordinators included |
| `spend_report request:` | workers' own cost, coordination (per coordinator), all together; the days (workers / coordination); sessions with workers first, each coordinator marked *coordination* |
| `spend_report session:` | a coordinator session says its cost is coordination and lists the requests it billed it to, apart from *Not any request's* (its `_dispatcher`, `_personal:<user>`, `_ops` bucket); a worker's list is its workers' own cost |
| `list_work id`, `read_work` | `Cost so far` is the workers' own; a second sentence gives the coordination |
| Dashboard | a request's chip reads `$workers + $coordination coord.`; the opened row and the Spend tab show both |
| HTTP | `/api/spend/summary` `usd` and the tokens are the workers'; `coordinationUsd` is the coordination; `/api/spend/report` has `workers`, `coordination`, `topCoordination` and, per row, `coordination` |

**The method (an estimate).** A coordinator's turn is split **evenly** among the requests (at most 4) named in the first lines of the
messages that began it, the rule that was already in force (`attribute`, `namedIdsIn`). Dollars and tokens of the turn are measured;
how many requests it served is not knowable (the model works on all the messages of a turn together), so the shares are an even split and
are labelled as an estimate in every output. The alternatives (by message length, by the tokens each id's text takes) would be as
unmeasured and would cost more to explain. A turn that names no request is in its bucket, as before; it is in the total, never in a request.
`namedIdsIn` ignores an id inside parentheses in a harness notice (`[machines]`, `[app restarted]`, `[restart]`, `[host]`,
`[heartbeat]`, `[data restored]`, `[machine updates]`): w1161 found that "(w605)" in two notices that reach the dispatcher on every
portal restart billed those turns to w605 (a citation of the update rule, not the subject). That fixes turns from the deploy on; turns
already recorded stay where they were put.

**What is stored.** A request keeps `coordDays`: dollars and tokens of coordinator turns by the coordinator's **session id** and UTC day,
a part of `days`; workers' own cost in a window is `days` minus it. The all-time split needs nothing new: each of the request's
`sessions` already has its role, so `SpendStore.splitOf` is exact for every request, old ones too. Only a window report needs the days.
Turns recorded before days existed get them from the coordinator's own transcript (a chat is never pruned), 150 seconds after the
portal starts, one session at a time (`rebuildCoordination`; a session with `coordV` 2 is done). The replay is **by the rules that recorded
each turn**: before `coordFrom` (the first turn the current code recorded) the old attribution (an id cited in parentheses in a harness
notice counted) and the old cost rule (a restart's whole running total was one turn); after it, the current ones. No day holds more
coordination than the request spent that day, and what the replay does not explain goes to the days with room. Until the rebuild finishes a
window report shows $0 coordination for the old part; the days of the old part are an estimate, the sums are not.

*The first version got this wrong (w1160, 2026-10-13):* it replayed old turns by the new rules and scaled the result up to the recorded size,
so w605's $1,836 of dispatcher turns (billed to it by the restart notices that cite "(w605)") were spread over the days of its few real mentions,
and the 3-day window read $1,475 of **worker** cost (days minus too little coordination) beside $0.13 of coordination. Its days, keyed by
"dispatcher" and the like, are dropped at load and every coordinator is rebuilt.

## Where the tokens go inside a session

Claude Code reports how big each model call's context was (input, cache read, cache write), never what is in it. The
`ContextMeter` (shared/spend.ts) shares each call's real token counts among the kinds of content the context holds, by characters:
cache reads go to what was in the context before the call, cache writes and uncached input to what is new since the previous
call, output tokens to the agent's own text. The agent's own output (thinking included) is carried in the next call's
context exactly (the fit below: 1.01 tokens per output token), so it is counted by tokens, not characters. What no content explains is `base` (on a resumed conversation, `carried`: the context the process never saw built)
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
  evenly. An orchestrator turn that names no request is overhead, not any request's. A coordinator turn that names several is split evenly too: an estimate ("Coordination").
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
