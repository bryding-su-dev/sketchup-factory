# Project briefs

The app's code knows nothing about the project it works on beyond `config.json`'s `project` section:

| key | what it does |
|---|---|
| `name`, `description` | How agents' prompts name and describe the project |
| `integration` | `push`: workers rebase and push to the integration branch (`defaultBase`); `pull-request`: they open a PR into it and never push to it |
| `community` | `true` (default): the Discord, FFBox and Max rules are in the briefs; `false`: agents never hear of them |
| `workerBriefFile` | Markdown appended to every worker's brief (sandboxes on this host and on machines) |
| `orchestratorBriefFile` | Markdown appended to both orchestrators' "what there is" brief |

Each folder here is one project's brief pair. `final-factory/` is the default (the text this app was written with);
`sketchup/` is the SketchUp Assistant frontend. Add a folder for another project and point `config.json` at it:

```json
"project": {
  "name": "SketchUp",
  "description": "the SketchUp Assistant frontend: a Vue 3 + TypeScript chat interface for AI agents inside SketchUp",
  "integration": "pull-request",
  "community": false,
  "workerBriefFile": "project/sketchup/worker-brief.md",
  "orchestratorBriefFile": "project/sketchup/orchestrator-brief.md"
}
```

Brief files are read when a brief is built (every agent start), so edits apply to the next agent without a restart.
Keep them free of secrets and internal addresses: they go into every transcript.
