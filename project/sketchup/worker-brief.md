## SketchUp
You are working on the SketchUp Assistant frontend (SAF): a Vue 3 + TypeScript chat interface for AI agents in SketchUp, embedded as an iframe in SketchUp Desktop, SketchUp for Web and SketchUp for iPad, with a React 19 Trimble Assist host (`src/su-trimble-assist-host/`) behind the `TrimbleAssistExperience` feature flag. Its `CLAUDE.md` is the canonical guide: read it first, and `docs/architecture.md` before any architectural change. The repo's own skills, hooks and agent roles load in this sandbox as they do for the user; use them.

### Getting the sandbox running
- A fresh worktree has no dependencies: run `yarn install` first.
- The portal copied the gitignored local files a checkout needs (`.env`, `.env.local`, the dev HTTPS certificates). If `yarn dev` falls back to plain HTTP or the React host silently degrades to the legacy chat, those files are missing: say so instead of working around it.
- Port 3000 is shared with other dev servers on this machine. Never kill a server you did not start; when 3000 is taken, pass a free port (`yarn dev --port <n>`) and check with `lsof` which process owns a port before trusting it.

### Conventions that are not optional
- `yarn ci` is the gate before any push: lint, format check, typecheck, unit tests, build. Run it whole and push only when it is green; running its pieces separately misses the format check.
- Work is tracked as Jira SKAIF stories. Branches are `SKAIF-<num>-<camelCaseShort>`, commit subjects start with `SKAIF-<num>:`, and a story's spec lives in `specs/SKAIF-<num>-*/`.
- The spec-driven flow (`draft-spec`, `speckit-plan`, `speckit-checklist`, `speckit-tasks`, `speckit-analyze`, `speckit-implement`, `review-code`) is human-gated: run only the phase you were asked for and stop; never chain to the next phase.
- Invariants a reviewer will refuse a PR over: `window.sketchup` is dereferenced only in `src/services/sketchupIntegration.ts`; every user-facing string goes through `t()`; locale JSON files are pipeline-owned and never hand-edited (a new key rides the English fallback until the translation pipeline runs; a failing Crowdin step is someone else's job, do not work around it); code comments explain the code and never cite ticket, requirement or contract numbers.
- `develop` is the integration branch and takes merged pull requests only; `main` is the release branch and off-limits.

### Verifying
Unit tests (`yarn test:unit`) are necessary, not sufficient, for UI changes: verify the change in the real app where you can (the repo's harness and skills say how) and state plainly what you verified and what you did not. End-to-end tests (`yarn test:e2e`) run against a shared deployed environment; run them only when the task calls for it, never in parallel with another agent's run.
