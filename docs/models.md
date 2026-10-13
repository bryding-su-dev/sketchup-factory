# Models

Ben, 2026-10-12: "aggressively use sonnet 5.5 and even delegate stuff to haiku 5.5 since the models are so good now ... we
need to save more tokens since my plan at sketchup is so limited", and "i still want opus 5.5 to be the brains of the
operations btw, it should be checking important work and making plans". The policy lives in `server/models.ts`.

| Who | Model | Set by |
|---|---|---|
| Each person's orchestrator, the dispatcher | Opus 5.5 | `orchestrator.model` (default `opus`) |
| The orchestrators' and dispatcher's **routine turns** (a worker's report, a timer, a check-in, a notice: nothing a person typed) | Sonnet 5.5 | `orchestrator.routineModel` (default `claude-sonnet-5-5`, `"off"` = always `orchestrator.model`) |
| A worker's main loop (host sandboxes, machines), standing agents started without a model | Sonnet 5.5 | `defaultModel` (default `sonnet`) |
| A request that is only planning/design, or a review/verification of important work | Opus 5.5 | the dispatcher's `start_agent model: "opus"` (its brief says when) |
| A request that is only a lookup, a summary or a spelled-out mechanical edit | Haiku 5.5 | the dispatcher's `start_agent model: "haiku"` |
| Every worker's `planner` and `reviewer` subagents | Opus 5.5 | `worker.subagentModels.planner` / `.reviewer` (default `opus`) |
| Every worker's `scout` subagent (lookups, searches, summaries, mechanical edits) | Haiku 5.5 | `worker.subagentModels.scout` (default `haiku`) |
| Claude Code's own background calls, and any agent or subagent asked for `haiku` | Haiku 5.5 | `modelPins.haiku` (default `claude-haiku-5-5`) |
| The usage poll's one-token rate-limit probe (`server/usage.ts`) | Haiku 5.5 | `MODEL_IDS.haiku` |
| Auto-approved standing-agent delegations | Sonnet 5.5 | the agent's `auto_model` (default `sonnet`) |

Compaction (`/compact` and automatic, docs/orchestrators.md) runs inside Claude Code on the conversation's own model;
there is no separate setting for it.

## Which model answers a coordinator's turn

An orchestrator or the dispatcher answers a person's own message, the dispatcher's `[work request]`, `[work update]`
and `[ledger]` decisions and a person's `[reaction]` on Opus (`orchestrator.model`), and every other turn on the routine
model (Sonnet). One session switches between them with the SDK's `setModel`; the transcript gets a `Model: …` line per
switch. A routine turn within 60 minutes (`orchestrator.routineAfterMinutes`) of an Opus turn stays on Opus, because a
switch rewrites the conversation into the other model's prompt cache. Workers and standing agents are never switched.
Upstream measured Sonnet deciding as Opus did on 10 of 11 decision kinds, but starting gated work with `override_gate` when
a person's note said "go ahead", so the decisions stay on Opus. Turn it off with `set_app_config orchestrator.routineModel off`.

## Ids and aliases

Checked 2026-10-12 on platform.claude.com/docs/en/about-claude/models/overview: `claude-opus-5-5`, `claude-sonnet-5-5`,
`claude-haiku-5-5`. The Agent SDK this app pins (0.3.284, bundling Claude Code 2.1.284) resolves `opus` and `sonnet` to
those ids, but `haiku` to `claude-haiku-4-5-20251001`, both for the alias and for its own background calls (measured with
`query()` and `modelUsage`). So every Claude process the app starts (workers, orchestrators, standing agents, machine
agents) gets `ANTHROPIC_DEFAULT_HAIKU_MODEL=claude-haiku-5-5` (`modelEnv`, laid under config `claudeEnv`, which still
wins). `modelPins.opus` and `modelPins.sonnet` pin the other two the same way; `""` removes a pin. A newer SDK whose table
already maps `haiku` to 5.5 makes the pin a no-op.

## Workers' subagents

Every worker session gets three subagents through the SDK's `agents` option (`workerAgents`), and a "Models" section in
its brief (`workerModelBrief`) that says when to use each:

- `planner` (Opus, read-only): the plan before a change across several files or systems, an architectural or API
  decision, or an unclear approach.
- `reviewer` (Opus, read-only): the independent check before important work merges, ships or is reported done.
- `scout` (Haiku): lookups, code and doc searches, summaries of long files, logs or transcripts, spelled-out edits.

`"off"` as a subagent's model leaves it out; `"inherit"` runs it on the worker's own model. A repository's own agent
roles (the SketchUp repo's `sketchup-agents` plugin: `Explore`, `code-reviewer`, `verifier`, …) still load beside these,
and the brief says to prefer one when it fits better.

## Changing it

All of these keys can be set live with `set_app_config` and take effect for the next session that starts: `defaultModel`,
`orchestrator.model`, `worker.subagentModels.planner|reviewer|scout`, and `modelPins.opus|sonnet|haiku`. Running
sessions keep the model they started with. Standing agents keep the model they were saved with, so change one with
`update_standing_agent model`.
