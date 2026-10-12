# Bedrock

The agents can run on SketchUp's AWS Bedrock account instead of the Claude plan. In **Auto** the host moves them to
Bedrock when the plan's 5-hour usage nears its limit and back when it has room again. Bedrock bills per token, so the
app counts what it spends against a daily cap.

## Scope

- **This host's agents only**: orchestrators, the dispatcher, workers and standing agents that run on this computer.
  Agents on machines (Macs, Windows PCs) are untouched; they keep their own account.
- **A person's own token wins.** An agent working for someone who set their own Claude token (`userClaudeEnv.<user>`,
  [accounts.md](accounts.md)) stays on that token whatever the mode says.
- Bedrock overrides the host's account choice (`claudeAccounts`) for the agents it covers while it is active.
- Nothing secret is configured: Bedrock authenticates through a named AWS SSO profile in `~/.aws/config`. The app
  knows the profile's name and a region, never a key. A value that looks like a key or token is refused and not echoed.

## Config

`config.json` `bedrock`, or `set_app_config bedrock.<key> <value>` (applies live; a null value returns to the default).

| Key | Default | Meaning |
| --- | --- | --- |
| `mode` | `auto` | `auto`, `plan` (always the plan) or `bedrock` (always Bedrock). |
| `profile` | none | The AWS profile name. Without it Bedrock is off and the UI shows the plan only. |
| `region` | `us-west-2` | The AWS region. |
| `regionPrefix` | `us` | Inference profile prefix: `us`, `eu`, `apac`, `jp`, `au` or `global` (about 10% cheaper). |
| `thresholdPercent` | `94` | Auto goes to Bedrock when the plan's 5-hour session usage reaches this. |
| `weeklyThresholdPercent` | off | Auto also goes when the weekly usage reaches this. |
| `resumeMarginPercent` | `10` | Auto returns to the plan once usage is this many points under the threshold, or its window reset. Must be under `thresholdPercent` (set_app_config and config.json refuse otherwise; a stored value is clamped to threshold - 1, so a reset meter always resumes). |
| `dailyBudgetUsd` | `200` | The most Bedrock may cost per local day. `0` turns the cap off. Do not raise it unless asked. |

## How Auto decides

- Session usage at or over `thresholdPercent` (or weekly at `weeklyThresholdPercent`): Bedrock.
- Once on Bedrock it stays until usage is under `thresholdPercent - resumeMarginPercent` (94 → 84 by default), or the
  window has reset. That gap is the hysteresis: a reading wobbling around the threshold cannot flap the backend. An
  unknown reading keeps the current state. A meter whose window has reset since it was read counts as 0.
- Bedrock is skipped when it cannot be used: no profile, or the AWS login does not work. The plan carries the work and
  the reason says why. Without a profile Bedrock is simply not set up: no notice, no `system_status` warning (only mode
  `bedrock` with no profile is reported, once).
- **Models.** Only sessions on opus, sonnet or haiku go to Bedrock. Any other model (`fable` has no pin and no price)
  stays on the plan, and no cap or gate applies to it. Subagent models are aliases and follow the main process.
- **Daily cap.** The day is the host's local day. At 80% of `dailyBudgetUsd` the owner's orchestrator is told once. At
  100% Bedrock stops: work goes to the plan if the plan has room, otherwise it **waits** (the badge says "Bedrock cap
  reached – waiting") and starts when the plan frees up or the next day begins. A turn already running is not cut off,
  so the day can overshoot the cap by what in-flight turns cost.

## Agents mid-turn

A turn in progress finishes on the backend it started on. When the decided backend changes, the next message to an
**idle** agent restarts its process on the new backend with the history resumed; a cross-provider resume is tested.
Agents that are mid-turn, waiting for a permission, running tasks or compacting are left alone and move on a later
message. While the cap is spent and the plan is full, messages are held in the existing queue.

**No Bedrock turn starts after the cap.** An idle Bedrock process whose decision is now the plan (cap spent, blocked,
or mode `plan`) is restarted on the plan before the message is delivered, and this happens before the host guard looks,
so the guard judges it as the new process start it is. If it cannot be restarted yet (a background task or a pending
permission), the message waits in the queue ("waiting for its background work to end before moving off Bedrock (…)")
and is delivered once the process can move (the queue is retried every 30 seconds and when a turn ends). A Bedrock
process whose decision is still Bedrock takes the message as usual; a plan process takes it whatever the decision. The
harness's own notices (`bypassGate`) follow the same rule. After a change of `bedrock.profile` or `bedrock.region`, an idle
Bedrock process on the old one is restarted the same way.

## Switching by hand

- The dashboard: the **Plan | Bedrock | Auto** control under the sidebar (shown when a profile is set). Choosing
  Bedrock asks for confirmation, because it spends money.
- Or ask the orchestrator: `set_app_config bedrock.mode plan|bedrock|auto`. `POST /api/backend/mode {"mode": …}` is the
  same call.

The badge at the top of the sidebar (and a mark on the phone's menu button) shows the active backend: Plan, Bedrock, or
the cap message, with today's spend, and an amber dot when AWS is the problem. Agents on Bedrock carry a **B** tag in
the fleet rows and "on Bedrock · $0.42" in their details. Under the system meters, **Bedrock** shows today against the
cap, this week, the reason, and the top spenders (`GET /api/backend`, fetched when opened).

## Models

A Bedrock process gets the three aliases mapped to inference profile ids `<prefix>.anthropic.<model>`:

| Alias | Id (prefix `us`) |
| --- | --- |
| opus | `us.anthropic.claude-opus-5-5` |
| sonnet | `us.anthropic.claude-sonnet-5-5` |
| haiku | `us.anthropic.claude-haiku-5-5` |

Checked 2026-10-12 with `aws bedrock list-inference-profiles` in us-west-2 and us-east-1, and Claude Code's Bedrock
documentation (https://code.claude.com/docs/en/amazon-bedrock). With `regionPrefix: "global"` the prefix is `global`.

## The environment

A Bedrock process gets `CLAUDE_CODE_USE_BEDROCK=1`, `AWS_PROFILE`, `AWS_REGION` and
`ANTHROPIC_DEFAULT_OPUS_MODEL` / `_SONNET_MODEL` / `_HAIKU_MODEL`. These are removed from the server's environment first,
so nothing can win over the profile or the plan: `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
`ANTHROPIC_BASE_URL`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AWS_BEARER_TOKEN_BEDROCK`,
`AWS_DEFAULT_REGION`, `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_FOUNDRY`, `CLAUDE_CODE_USE_MANTLE`. The session's
account is recorded as `bedrock:<profile>`; the plan meters leave such sessions out.

A **plan** process gets the opposite: `CLAUDE_CODE_USE_BEDROCK`, `AWS_PROFILE`, `AWS_REGION`, `AWS_DEFAULT_REGION`, the AWS
keys, `AWS_BEARER_TOKEN_BEDROCK` and `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL` are removed from what the server
inherited (a server started from a Bedrock shell must not run "plan" agents on Bedrock), then the model pins of
`modelPins` are put back. This holds for a person's own token too, and in `buildOptions` for standing agents and machines.

## Spend

The spend is an **estimate from token counts at Bedrock list prices**, kept per turn.

Prices in USD per million tokens (AWS Price List API, `AmazonBedrockFoundationModels`, us-west-2, 2026-10-12; global
endpoints):

| Model | Input | Output | Cache write (5 min) | Cache read |
| --- | --- | --- | --- | --- |
| Opus 5.5 | 4 | 20 | 5 | 0.20 |
| Sonnet 5.5 | 2 | 10 | 2.50 | 0.10 |
| Haiku 5.5 | 0.10 | 0.50 | 0.125 | 0.01 |

- A regional prefix (`us`, `eu`, …) costs 10% more than `global`; the estimate applies it.
- Haiku has a long-context tier above 100K input tokens at 0.5 input / 2.5 output. A turn's totals cannot show it, so
  the estimate keeps the **larger** of the table and Claude Code's own figure for the same tokens.
- A resumed session's first result already carries what came before; only the difference since the last total is
  counted, so nothing is counted twice.
- A counter that is lower than the last total in any field (a new process, a reset) counts whole, on top of what was
  counted before; an entry counts unless its `provider` says it is not Bedrock (a missing provider is not $0).
- AWS Cost Explorer is the reconciliation, but it is **account-wide**: it includes other users of the AWS account, so it
  will read higher than this app's number.

Files in `data/`:

- `bedrock-spend.jsonl`: one line per turn (time, session, model, tokens, USD). The day and week totals are rebuilt from
  it at start.
- `bedrock-state.json`: Auto's state per account (on Bedrock since when and why), the per-session token totals and which
  notices were sent.

## SSO expiry

When the AWS login lapses the probe (`aws sts get-caller-identity`, cached, repeated every 5 minutes) or a failed turn's error says so. The badge shows an amber dot with the reason, Auto falls back to the plan, the
owner's orchestrator is told once. Fix: `aws sso login --profile
<profile>`. Bedrock resumes by itself at the next probe.

A probe that fails without saying why (a timeout, a network blip) must happen twice in a row, 10 seconds apart, before
Bedrock counts as unavailable; a clear answer (SSO expired, profile not found, AWS CLI not installed, no credentials)
counts at once.

## Access denied

A Bedrock turn that fails with `AccessDeniedException`, "not authorized", "model access" or a `ValidationException`
about the model, twice within 10 minutes, puts Bedrock into a 30-minute unavailable state: the plan carries the work
and the owner is told once ("Bedrock refused the model (…): ask your AWS admin for bedrock:InvokeModel on the Claude
inference profiles in <region>"). It tries again by itself after 30 minutes; a passing `sts` probe does not lift it
earlier (the login works, the model is what is refused). Changing the profile or region clears it.

## Preflight

```
node scripts/bedrock-preflight.ts [--profile P] [--region R] [--call]
```

Read-only. Lists profile names, the caller's account id and role, whether the three model ids are ACTIVE, yesterday's
and today's account-wide cost; `--call` also makes one tiny Haiku call (a fraction of a cent) with the same environment
an agent gets. Run it before turning Bedrock on and whenever it stops working.

## Live setup

```
aws sso login --profile <profile>
node scripts/bedrock-preflight.ts --profile <profile> --call
set_app_config bedrock.profile <profile>
set_app_config bedrock.region us-west-2
set_app_config bedrock.mode auto
```

Optional: `bedrock.regionPrefix global`, `bedrock.thresholdPercent`, `bedrock.weeklyThresholdPercent`,
`bedrock.resumeMarginPercent`, `bedrock.dailyBudgetUsd`.

## Switching without an agent (no tokens needed)

The sidebar's Plan | Bedrock | Auto control and `scripts/backend.ts` are plain code: no model is involved, so they work when
the plan has no tokens left and no agent can be asked. Both set `bedrock.mode`, and it applies to the very next message of
every agent (an idle process restarts on the new backend, history resumed; a running turn finishes where it is).

```
node server/apikey.ts backend-switch --scope backend      # once: prints a key (shown once), good for these two endpoints only
echo 'ffsb_…' > ~/.sketchup-factory-backend-key && chmod 600 ~/.sketchup-factory-backend-key
node scripts/backend.ts status | plan | bedrock | auto [--url http://127.0.0.1:8790] [--key-file <file>]
```

The key may also come from `FF_BACKEND_KEY`. A `backend`-scoped key reaches `GET /api/backend` and `POST /api/backend/mode` and
nothing else (not `/mcp`, not the rest of the API). With the server down, the script edits `bedrock.mode` in `config.json`
instead and says so; it holds from the next start. `server/backendSwitch.ts` is the logic, `server/backendSwitch.test.ts` its tests.

A model recorded on one backend ("us.anthropic.claude-haiku-5-5" on Bedrock, "claude-haiku-5-5" on the plan) is refused by the
other, so a session restarted onto another backend starts with its alias (`startModel`).
