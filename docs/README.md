# Docs

How SketchUp Factory works. Start with the [README](../README.md).

## Used by the SketchUp Factory

| doc | topic |
|---|---|
| [orchestrators.md](orchestrators.md) | personal orchestrators, the dispatcher, the work ledger, timers, compaction, a fresh session per request |
| [standing-agents.md](standing-agents.md) | scheduled long-lived agents and delegation requests |
| [restart.md](restart.md) | restarts and updates; [the macOS Node supervisor](restart.md#macos-the-node-supervisor) is the one in use |
| [models.md](models.md) | which model each role runs on (Opus plans and checks, Sonnet implements, Haiku 5.5 for cheap work) and how to change it |
| [accounts.md](accounts.md) | which Claude account each agent runs on; Artifact tools and the Claude Docs connector |
| [identity.md](identity.md) | people, attribution and whose account pays |
| [attachments.md](attachments.md) | files sent with a message |
| [self-recovery.md](self-recovery.md) | disk-space guard and crash-safe data (the Dev Drive parts are Windows-only) |
| [backlog.md](backlog.md), [ui-review.md](ui-review.md), [republish.md](republish.md) | upstream notes; read only when touching that code |

## Inherited from Final Factory, off here

Unity, the game's community tooling and remote machines are disabled in `config.example.mac.json`. The code and these
docs stay so upstream changes keep merging.

| doc | topic |
|---|---|
| [unity-lifecycle.md](unity-lifecycle.md), [unity-dialogs.md](unity-dialogs.md) | Unity editor management |
| [ffbox.md](ffbox.md), [ffbox-integration.md](ffbox-integration.md), [ffbox-connector-contract.md](ffbox-connector-contract.md), [max.md](max.md), [intake.md](intake.md) | FFBox, Discord and the intake |
| [machines.md](machines.md), [beast-machine.md](beast-machine.md), [ops-worker.md](ops-worker.md) | remote machines and upstream's ops worker |
| [voice.md](voice.md) | local voice input (needs a GPU host) |
