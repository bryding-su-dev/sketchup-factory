# CI (GitHub Actions)

One workflow, `.github/workflows/ci.yml`, with two jobs. Both run on `ubuntu-latest`; there is no Windows or macOS job
(this host is a Mac, and those minutes cost 2x and 10x on a private repo).

| job | runs | does |
|---|---|---|
| `checks` | every code pull request into `sketchup` (or `main`) | commit identities are noreply, gitleaks, typecheck (server and web), unit tests with coverage, web build |
| `e2e` | a PR labelled **`e2e`**, or Actions → CI → Run workflow | Playwright, Chromium + WebKit, every project (one job, no shards) |

- **Run Playwright:** add the `e2e` label when a PR is ready (a change to `web/`, `e2e/` or the server's HTTP surface). Or run it locally first:
  `npm --prefix web run build && npx playwright test`.
- **No `push` trigger:** a PR's run tested the code that merges; a push run would test it again.
- **Docs-only PRs** (`*.md`, `docs/`, `changelog.d/`) start nothing.
- **Newer pushes cancel** the run in flight, per job, so labelling a PR never cancels its checks.
- **No performance bench in CI** (upstream's w1173 too): run `node web/perf/bench.ts --check --live 0` locally when touching the UI's hot paths.
- **Visual baselines** are the Linux ones; to re-render them run the workflow by hand with *update snapshots* ticked and commit the `linux-snapshots` artifact.

## Cost

The repository is public, so standard hosted runners are free (GitHub: "free for public repositories that use standard
GitHub-hosted runners"). The cuts keep it cheap if it ever goes private (Linux $0.006/min, Windows x2, macOS x10).

Estimate, before → after, for a typical PR (3 pushes; job times from upstream's measured runs, scaled for hosted 2-core runners, so ±30%):

| | before | after |
|---|---|---|
| per push | Linux checks 7 + Windows checks 9 (x2 billed) + Playwright 14 + gitleaks 1 + identity 1 = 31 min, 41 Linux-equivalent | 7 min (docs-only: 0) |
| Playwright | every push | once, on the label |
| after merge | the same again on the `sketchup` push | nothing |
| per PR | ~124 min, ~164 billed-equivalent | ~35 min |
| per week (10 PRs) | ~1,240 min, ~$10 if private | ~350 min, ~$2 if private |
