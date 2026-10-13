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

Measured on GitHub's hosted runners (PR #12 and #13 runs, 2026-10-13), a typical PR with 3 pushes and a merge:

| | before | after |
|---|---|---|
| per push | Linux checks 1.5 min + Windows checks 3.5 (x2 billed) + Playwright 8.7 + gitleaks and identities (a billed minute each): 14 min, ~21 billed | checks 1.6 min (docs-only: 0) |
| Playwright | every push | once, on the label (8.7 min) |
| after merge | the same again on the `sketchup` push | nothing |
| per PR | ~56 min, ~84 billed Linux-equivalent | ~15 min |
| per week (10 PRs) | ~560 min, ~840 billed, ~$5 if private | ~150 min, ~$0.9 if private |

Per-job rounding is why folding the two ten-second jobs into `checks` matters: each bills a whole minute.
