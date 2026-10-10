# Contributing

Thanks for looking. This is a tool built for one team's workflow and shared as-is, so please open
an issue before a large change to check it fits.

## Development

```bash
npm ci && npm ci --prefix web
npm run typecheck && npm --prefix web run typecheck
npm --prefix web run build                 # the server serves web/dist
```

A throwaway `config.json` (set `FFSB_CONFIG` to its path) pointing `repo.url` at a local bare repo
and `unity.editorPath` at nothing is enough to run everything except Unity. See the Development
section of the README. Node 23.6 or newer runs the TypeScript directly; there is no build step for
the server.

## Tests

CI runs everything below on every push and pull request to `main`
([.github/workflows/ci.yml](.github/workflows/ci.yml)).

### Unit tests

```bash
npm test                  # node --test server/*.test.ts scripts/*.test.ts
npm run test:coverage     # the same, with a coverage table (node's built-in coverage)
node --test server/guard.test.ts    # one file
```

Tests live next to the code as `*.test.ts` and use `node:test`. A few (`updateSteps`, `republish`,
`elevation`) drive the PowerShell scripts and run only on Windows; CI runs the suite on Linux and
Windows. `server/agentSession.test.ts` shows how to test session behaviour without Claude: it swaps
the Agent SDK's `query()` for the scripted fake in `e2e/fakeAgent.ts` (`setQueryForTesting`).

### End-to-end tests (Playwright)

```bash
npx playwright install chromium webkit        # once
npm --prefix web run build                    # the test server serves web/dist
npm run test:e2e                              # all three projects
npm run test:e2e -- --project=mobile-safari e2e/chat.spec.ts   # one project, one file
npx playwright show-report                    # after a run: the HTML report, with traces of failures
```

`e2e/server.ts` starts the real server against a throwaway config and data folder under the system
temp directory, with a fake agent (`e2e/fakeAgent.ts`) in place of Claude: no Unity, no network, no
credentials. The fake answers by tag (`#perm` asks for a permission, `#long`, `#screenshot`, `#slow`,
`#fail`; anything else is echoed). It seeds three sandboxes (`alpha` for tests to use, `gallery` with a
fixed transcript for screenshots, `stuck` with a blocked Unity editor) and the login `tester` /
`e2e-password-123`. Each project (desktop Chromium, Pixel-sized Chrome, iPhone-sized WebKit) gets its
own server on ports 8791-8793, so run nothing else there.

A test that intercepts the page's requests (`page.route`) sets `test.use({ serviceWorkers: 'block' })`: the app registers a
service worker, and WebKit does not route the requests of a page one controls (the route is never hit and the real server
answers; w893, `e2e/composerClears.spec.ts`).

Visual snapshots (`toHaveScreenshot`) are compared only on Linux, where CI renders them; the
baselines are the `*-linux.png` files in `e2e/__screenshots__/`. When you change the UI on purpose,
run the CI workflow by hand with **update snapshots** ticked (Actions → CI → Run workflow), download
the `linux-snapshots` artifact, review the images and commit them. On Windows or macOS set
`E2E_SNAPSHOTS=1` to compare against baselines of your own (those files are gitignored).

### Performance

```bash
npm --prefix web run build
node web/perf/bench.ts                                   # 7,000 stopped agents, an 8,000-event chat, live traffic
node web/perf/bench.ts --route '#/sandbox/agent-mcp'     # the chat beside the sandbox holding most past agents
node web/perf/bench.ts --cpu 4 --memory 60               # a 4x slower CPU; the JS heap over an hour
node web/perf/bench.ts --check --live 0                  # the budgets CI holds the page to
```

`web/perf/bench.ts` runs the built page against the mock backend (`web/mock/`) at a real portal's scale
(`web/mock/scale.ts`) in headless Chromium: per key typed, the time to the next frame, React commits and components
rendered, and long tasks; at rest, the main thread's busy share and layouts per second; the heap over time. With
`MOCK_STATE_FILE`, `MOCK_TRANSCRIPT_FILE` and `MOCK_WORK_FILE` it uses a portal's own `state.json`, a transcript
and `work.json` instead of generated ones (strip any secrets first, and never commit them). CI runs `--check`, which
fails on components rendered per key, DOM size, typing p95, long tasks and layouts at rest: counts where possible,
so a slow runner does not fail it.

## Versions and releases

The version lives in `package.json` (web/package.json follows it) and uses semantic versioning. Add
a line under **[Unreleased]** in [CHANGELOG.md](CHANGELOG.md) with your change. To release:

```bash
npm run release -- minor --dry-run   # patch | minor | major | X.Y.Z: shows the notes
npm run release -- minor             # bumps, cuts the changelog, commits "Release vX.Y.Z", tags it
```

Then push the commit and the tag (the script prints the command).

## Guidelines

- Keep changes focused, with a test for new server behaviour (`server/*.test.ts`) and an E2E test for
  a new UI flow.
- **Commit with your GitHub noreply address** (`<id>+<login>@users.noreply.github.com`, from GitHub
  Settings → Emails): the history is public, and CI fails any commit whose author or committer email
  is not a noreply address. Set it with `git config user.email` in your clone.
- Never commit `config.json`, `data/`, real hostnames, usernames, tokens or paths from your
  machine. Use neutral examples (`C:/path/to/...`, `<host>.<tailnet>.ts.net`). CI runs gitleaks.
- Anything that widens what agents may do (guard rules, tool groups, permissions) needs a clear
  reason in the pull request.

By contributing you agree that your contributions are licensed under the MIT License
([LICENSE](LICENSE)).
