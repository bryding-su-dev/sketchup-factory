import type { Page } from '@playwright/test';
import type { AppState, Machine, MachineSandbox, MachineStats, Sandbox, ServerEvent, SessionInfo, SystemStats } from '../shared/types.ts';
import { expect, isMobile, openSidebar, settle, signIn, test } from './fixtures.ts';

// The sidebar's computers and the Overview board (web/src/components/Fleet.tsx, shared/fleet.ts): BEAST, then
// each machine with its sandboxes, their live agents and its main clone. The page's WebSocket is intercepted and
// its state replaced with a fixed fleet, as in e2e/meters.spec.ts. The seeded worker "gallery1" stands in for an
// agent in a machine sandbox, so its page has a real transcript.

const NOW = new Date('2026-09-29T12:00:00Z');
const GB = 2 ** 30;
const min = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();
const git = (branch: string) => ({ branch, dirty: 0, untracked: 0, ahead: 1, behind: 0, upstream: `origin/${branch}`, at: NOW.toISOString(), head: { sha: 'abc1234', subject: 'Nightly: Windows runner', date: min(30) } });

const SYSTEM: SystemStats = {
  hostname: 'BEAST',
  platform: 'win32 10.0.26100',
  cpuModel: 'AMD Ryzen 9 7950X',
  cpuCount: 32,
  loadPct: 38,
  memTotalBytes: 128 * GB,
  memFreeBytes: 57 * GB,
  diskTotalBytes: 4000 * GB,
  diskFreeBytes: 1100 * GB,
  gpu: { name: 'NVIDIA GeForce RTX 5090', memTotalMiB: 32607, memUsedMiB: 14540, utilPct: 41 },
  limits: { maxUnity: 4, maxSessions: 8, maxSandboxes: 10 },
};

const stats = (loadPct: number, usedGB: number, totalGB: number, gpu: MachineStats['gpu']): MachineStats => ({
  hostname: 'x',
  platform: 'x',
  cpuModel: 'x',
  cpuCount: 16,
  loadPct,
  memTotalBytes: totalGB * GB,
  memFreeBytes: (totalGB - usedGB) * GB,
  memUsedBytes: usedGB * GB,
  diskTotalBytes: 2000 * GB,
  diskFreeBytes: 640 * GB,
  gpu,
  at: NOW.toISOString(),
});

const worker = (base: SessionInfo, id: string, title: string, status: SessionInfo['status'], ago: number, where: Partial<SessionInfo>): SessionInfo => ({
  ...base,
  id,
  kind: 'worker',
  title,
  status,
  lastActivityAt: min(ago),
  pendingPermissions: [],
  sandboxId: undefined,
  ...where,
});

const hostSb = (id: string, purpose: string, sessionIds: string[], unity: Sandbox['unity']['state']): Sandbox => ({
  id,
  name: id,
  branch: `sandbox/${id}`,
  base: 'develop',
  path: `F:/ffsb/${id}`,
  purpose,
  status: 'ready',
  createdAt: min(600),
  unity: { state: unity },
  sessionIds,
  git: git(id === 'agent-a' ? 'feature/honest-coop' : `sandbox/${id}`),
});

const machineSb = (id: string, purpose: string, sessionIds: string[], unity: MachineSandbox['unity']['state'], branch: string): MachineSandbox => ({
  id,
  branch,
  base: 'origin/develop',
  path: `D:/work/ffsb/${id}`,
  purpose,
  status: 'ready',
  createdAt: min(300),
  unity: { state: unity, logPath: `D:/work/ffsb/${id}/Logs/sandbox-editor.log` },
  sessionIds,
  git: git(branch),
});

const machine = (id: string, extra: Partial<Machine>): Machine => ({
  id,
  host: id,
  purpose: 'unused',
  status: 'ready',
  online: true,
  repoPath: 'D:/work/FFFRepo',
  home: 'C:/Users/dev',
  portalUrl: 'https://portal.example.ts.net',
  maxSessions: 3,
  sessionIds: [],
  createdAt: min(9000),
  ...extra,
});

/** The fixed fleet: BEAST with two sandboxes, LothDesktop with a sandbox pool, the M5 with its main clone, an offline M3. */
function fleet(s: AppState): AppState {
  const orch = s.sessions.find((x) => x.id === s.orchestratorId)!;
  const gallery = s.sessions.find((x) => x.id === 'gallery1')!;
  const sessions = [
    orch,
    worker(orch, 'b-play', 'Honest co-op: BEAST client', 'running', 1, { sandboxId: 'agent-a' }),
    worker(orch, 'b-old', 'Old build check', 'stopped', 400, { sandboxId: 'agent-a' }),
    { ...gallery, title: 'Nightly e2e: Windows leg', status: 'running' as const, lastActivityAt: min(2), sandboxId: undefined, machineId: 'lothdesktop', machineSandbox: 'sb1' },
    worker(orch, 'l-review', 'Review the nightly report', 'idle', 25, { machineId: 'lothdesktop', machineSandbox: 'sb1', requestedBy: { userId: 'lothsahn', displayName: 'Lothsahn' } }),
    worker(orch, 'l-main', 'Spec 075 nightly e2e', 'idle', 12, { machineId: 'lothdesktop' }),
    worker(orch, 'm5-host', 'Honest co-op: M5 host', 'running', 0, { machineId: 'm5' }),
  ];
  return {
    ...s,
    sessions,
    sandboxes: [hostSb('agent-a', 'Honest co-op playthrough', ['b-play', 'b-old'], 'running'), hostSb('agent-b', 'unused', [], 'stopped')],
    standingAgents: [],
    delegations: [],
    providers: [],
    system: SYSTEM,
    host: { elevated: false },
    machines: [
      machine('lothdesktop', {
        name: 'LothDesktop',
        platform: 'win32',
        purpose: 'Spec 075 nightly e2e',
        sandboxRoot: 'D:/work/ffsb',
        maxSandboxes: 3,
        maxUnity: 2,
        sessionIds: ['l-review', 'gallery1', 'l-main'],
        git: git('075-nightly-windows'),
        sandboxes: [machineSb('sb2', 'unused', [], 'stopped', 'sandbox/sb2'), machineSb('sb1', 'Nightly e2e run', ['l-review', 'gallery1'], 'running', 'feature/fleet-view')],
      }),
      machine('m5', { platform: 'darwin', purpose: 'Honest co-op host', sessionIds: ['m5-host'], git: git('develop') }),
      machine('m3', { platform: 'darwin', online: false, lastSeen: min(180) }),
    ],
    machineStats: {
      lothdesktop: stats(22, 41, 64, { name: 'NVIDIA GeForce RTX 4080', memTotalMiB: 16376, memUsedMiB: 6100, utilPct: 18 }),
      m5: stats(64, 34, 64, { name: 'Apple M5 Max', memTotalMiB: 65536, memUsedMiB: 9216, utilPct: 71, unified: true }),
    },
  };
}

/**
 * After the migration (docs/beast-machine.md): BEAST's own daemon, machine "beast", holds its two sandboxes; the host
 * has none of its own. `online` false: that daemon is down.
 */
function migratedFleet(online = true) {
  return (s: AppState): AppState => {
    const f = fleet(s);
    const onBeast = (x: SessionInfo) => (x.sandboxId ? { ...x, sandboxId: undefined, machineId: 'beast', machineSandbox: x.sandboxId } : x);
    const beast = machine('beast', {
      name: 'BEAST',
      local: true,
      host: 'localhost',
      platform: 'win32',
      online,
      repoPath: 'C:/ffsb/_base',
      sandboxRoot: 'F:/ffsb',
      maxSandboxes: 5,
      maxUnity: 4,
      maxSandboxAgents: 6,
      sessionIds: ['b-play', 'b-old'],
      sandboxes: [
        { ...machineSb('agent-a', 'Honest co-op playthrough', ['b-play', 'b-old'], 'running', 'feature/honest-coop'), path: 'F:/ffsb/agent-a' },
        { ...machineSb('agent-b', 'unused', [], 'stopped', 'sandbox/agent-b'), path: 'F:/ffsb/agent-b' },
      ],
    });
    return { ...f, sandboxes: [], sessions: f.sessions.map(onBeast), machines: [beast, ...f.machines] };
  };
}

async function fixedFleet(page: Page, hash = '#/', shape: (s: AppState) => AppState = fleet) {
  await page.routeWebSocket('**/ws', (ws) => {
    const server = ws.connectToServer();
    let orchId = '';
    server.onMessage((raw) => {
      const e = JSON.parse(String(raw)) as ServerEvent;
      if (e.type === 'state') {
        orchId = e.state.orchestratorId;
        ws.send(JSON.stringify({ type: 'state', state: shape(e.state) } satisfies ServerEvent));
        return;
      }
      // What the live server says about sandboxes, machines and other tests' agents is not this fleet.
      if (['system', 'host', 'usage', 'accounts', 'machine_stats', 'machine', 'machine_removed', 'sandbox', 'sandbox_removed', 'standing', 'delegation', 'provider'].includes(e.type)) return;
      if ((e.type === 'session' && e.session.id !== orchId) || e.type === 'session_removed') return;
      ws.send(raw);
    });
    ws.onMessage((m) => server.send(m));
  });
  // The log is read on the machine through its daemon; this fleet has none, so the page gets these lines.
  await page.context().route(/\/api\/machines\/lothdesktop\/sandboxes\/sb1\/unity-log/, (r) =>
    r.fulfill({ json: { lines: ['[Licensing::Module] Channel doesn\'t exist', 'Refreshing native plugins compatible for Editor', 'error CS0103: The name \'Foo\' does not exist'] } }),
  );
  await page.clock.setFixedTime(NOW);
  // Every group open at the start of a test; a reload inside it keeps what the test folded.
  await page.addInitScript(() => {
    if (sessionStorage.getItem('fleet-test')) return;
    sessionStorage.setItem('fleet-test', '1');
    localStorage.removeItem('ffsb.fleet.collapsed');
  });
  await signIn(page);
  await page.goto(`/${hash}`);
  await expect(page.locator('.sidebar')).toBeAttached();
}

/** A proof image for the PR, kept with the run's results (test-results/…), and attached to the report. */
async function proof(page: Page, name: string) {
  await settle(page);
  const file = test.info().outputPath(`${name}.png`);
  await page.screenshot({ path: file });
  await test.info().attach(name, { path: file, contentType: 'image/png' });
}

test('fleet: the sidebar groups every computer, with its sandboxes, their agents and the main clone', async ({ page }) => {
  await fixedFleet(page);
  const sidebar = await openSidebar(page);
  const groups = sidebar.locator('.fl-group');
  await expect(groups).toHaveCount(4);
  expect(await groups.evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')))).toEqual(['fl-group-host', 'fl-group-lothdesktop', 'fl-group-m5', 'fl-group-m3']);

  const beast = sidebar.getByTestId('fl-group-host');
  await expect(beast.locator('.fl-name')).toHaveText('BEAST');
  await expect(beast.getByTestId('fl-capacity')).toHaveText('2/10 sandboxes · 1/4 editors');
  await expect(beast.getByTestId('fl-agents-sum')).toHaveText('1 agent, 1 busy');
  await expect(beast.getByTestId('meter-CPU')).toHaveText('CPU 38%');
  await expect(beast.getByTestId('meter-GPU')).toHaveText('GPU 45%');
  await expect(beast.getByTestId('meter-Disk')).toHaveText('Disk 1.1T');
  // The four meters sit on one line in the sidebar's width, none of them cut.
  const cells = await beast.locator('.fl-meter').evaluateAll((els) => els.map((e) => ({ top: Math.round(e.getBoundingClientRect().top), cut: e.scrollWidth > e.clientWidth + 1, text: e.textContent })));
  expect(new Set(cells.map((c) => c.top)).size, 'meters on one line').toBe(1);
  expect(cells.filter((c) => c.cut).map((c) => c.text), 'meters cut short').toEqual([]);
  // Nor is the counts line.
  expect(await beast.getByTestId('fl-capacity').evaluate((e) => e.scrollWidth <= e.clientWidth + 1), 'counts line cut short').toBe(true);
  // A live agent: its title, busy or idle, and how long since it last did something; a stopped one is a count.
  const play = beast.getByTestId('fl-sandbox-agent-a');
  await expect(play.getByTestId('fl-agent')).toHaveCount(1);
  await expect(play.getByTestId('fl-agent')).toContainText(/Honest co-op: BEAST client\s*busy\s*1m/);
  await expect(play.locator('.fl-stopped')).toHaveText('+1 stopped');
  await expect(beast.getByTestId('fl-sandbox-agent-b').locator('.fl-free')).toHaveText('FREE');

  const loth = sidebar.getByTestId('fl-group-lothdesktop');
  await expect(loth.locator('.fl-title')).toContainText('LothDesktop');
  await expect(loth.locator('.fl-title')).toContainText('Windows');
  await expect(loth.getByTestId('fl-capacity')).toHaveText('2/3 sandboxes · 1/2 editors');
  await expect(loth.getByTestId('fl-agents-sum')).toHaveText('3 agents, 1 busy');
  const sb1 = loth.getByTestId('fl-sandbox-lothdesktop/sb1');
  await expect(sb1.locator('.row-title')).toHaveText('Nightly e2e run');
  await expect(sb1.locator('.row-sub')).toContainText('Working · feature/fleet-view');
  await expect(sb1.locator('.fl-unity')).toHaveAttribute('title', 'Unity running');
  await expect(sb1.getByTestId('fl-agent')).toHaveText([/Review the nightly report\s*idle\s*25m/, /Nightly e2e: Windows leg\s*busy\s*2m/]);
  await expect(loth.getByTestId('fl-sandbox-lothdesktop/sb2').locator('.fl-free')).toBeVisible();
  // The main clone: the machine's label and its own agents (not the sandbox's).
  const main = loth.getByTestId('fl-main-lothdesktop');
  await expect(main.locator('.row-title')).toHaveText('Spec 075 nightly e2e');
  await expect(main.locator('.row-sub')).toContainText('main clone');
  await expect(main.getByTestId('fl-agent')).toHaveText([/Spec 075 nightly e2e\s*idle\s*12m/]);

  // The M5 has no sandbox pool; the M3 is offline.
  await expect(sidebar.getByTestId('fl-group-m5').getByTestId('fl-capacity')).toHaveText('main clone only');
  await expect(sidebar.getByTestId('fl-group-m5').getByTestId('fl-agents-sum')).toHaveText('1 agent, 1 busy');
  await expect(sidebar.getByTestId('fl-group-m3').locator('.fl-meters')).toHaveText('offline · seen 3h ago');
  if (!isMobile(page)) await proof(page, 'sidebar');
});

test('fleet: a group folds away, and stays folded after a reload', async ({ page }) => {
  await fixedFleet(page);
  let sidebar = await openSidebar(page);
  const head = sidebar.getByTestId('fl-group-lothdesktop').locator('.fl-head');
  await expect(head).toHaveAttribute('aria-expanded', 'true');
  await head.click();
  await expect(head).toHaveAttribute('aria-expanded', 'false');
  await expect(sidebar.getByTestId('fl-group-lothdesktop').locator('.fl-places')).toHaveCount(0);
  // Folded, the header still says what is there: the counts and what waits on the user.
  await expect(head.getByTestId('fl-capacity')).toContainText('2/3 sandboxes');

  expect(await page.evaluate(() => localStorage.getItem('ffsb.fleet.collapsed'))).toBe('["lothdesktop"]');

  await page.reload();
  sidebar = await openSidebar(page);
  await expect(sidebar.getByTestId('fl-group-lothdesktop').locator('.fl-head')).toHaveAttribute('aria-expanded', 'false');
  await expect(sidebar.getByTestId('fl-group-host').locator('.fl-head')).toHaveAttribute('aria-expanded', 'true');
  // And opens again.
  await sidebar.getByTestId('fl-group-lothdesktop').locator('.fl-head').click();
  await expect(sidebar.getByTestId('fl-sandbox-lothdesktop/sb1')).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('ffsb.fleet.collapsed'))).toBeNull();
});

test('fleet: the Overview board shows every computer as a card with its live agents', async ({ page }) => {
  await fixedFleet(page, '#/overview');
  const board = page.getByTestId('overview');
  await expect(board.locator('.page-title')).toHaveText('Overview');
  await expect(board.locator('.overview-sum')).toHaveText('5 agents live · 3 busy');
  await expect(board.locator('.board-card')).toHaveCount(4);
  const loth = board.getByTestId('board-lothdesktop');
  await expect(loth.getByTestId('fl-capacity')).toHaveText('2/3 sandboxes · 1/2 editors');
  await expect(loth.getByTestId('fl-agents-sum')).toHaveText('3 agents, 1 busy');
  // Free sandboxes are one line of chips on the board; the requester shows on each agent.
  await expect(loth.getByTestId('fl-free-line')).toHaveText(/FREE\s*sb2/);
  await expect(loth.getByTestId('fl-agent').filter({ hasText: 'Review the nightly report' })).toContainText('Lothsahn');
  await expect(board.getByTestId('board-host').getByTestId('fl-free-line')).toHaveText(/FREE\s*agent-b/);
  await proof(page, 'overview');

  // An agent opens its sandbox's page, on that agent.
  await loth.getByTestId('fl-agent').filter({ hasText: 'Nightly e2e: Windows leg' }).click();
  await expect(page).toHaveURL(/#\/machine\/lothdesktop\/sandbox\/sb1\/gallery1$/);
  await expect(page.getByTestId('machine-sandbox-panel')).toBeVisible();
});

test('fleet: a machine sandbox has its own page: agents as tabs, Unity with its log, and git', async ({ page, browserName }) => {
  await fixedFleet(page, '#/machine/lothdesktop/sandbox/sb1');
  const panel = page.getByTestId('machine-sandbox-panel');
  await expect(panel.locator('.ph-name')).toHaveText('Nightly e2e run');
  // The newest agent is selected, and its transcript loads.
  await expect(panel.locator('.msg-assistant').first()).toBeVisible();
  if (!isMobile(page)) {
    await expect(panel.locator('.ph-facts')).toContainText('lothdesktop/sb1');
    await expect(panel.locator('.ph-facts')).toContainText('feature/fleet-view');
    await expect(panel.getByRole('tab')).toHaveText([/Review the nightly report\s*Lothsahn/, /Nightly e2e: Windows leg/]);
  }
  await panel.getByRole('button', { name: 'Details' }).click();
  const details = page.locator('.details-sheet');
  await expect(details).toContainText('lothdesktop/sb1');
  await expect(details.locator('.unity-bar')).toContainText('Unity running');
  await expect(details.getByRole('button', { name: 'Stop Unity' })).toBeEnabled();
  await expect(details).toContainText('Nightly: Windows runner');
  if (!isMobile(page)) await proof(page, 'machine-sandbox');
  await details.getByRole('button', { name: 'Log', exact: true }).click();
  const log = page.locator('.drawer');
  await expect(log).toContainText('Nightly e2e run (lothdesktop/sb1)');
  // WebKit did not hand this fetch to the route mock in local runs (the real server answered "no machine"), so the
  // lines themselves are checked in Chromium.
  if (browserName === 'chromium') await expect(log.locator('.log-err')).toHaveText("error CS0103: The name 'Foo' does not exist");
});

test('fleet: the machine sandbox routes answer, and name what is missing', async ({ page }) => {
  await signIn(page);
  const r = await page.request.get('/api/machines/nosuch/sandboxes/sb1/unity-log');
  expect(r.ok()).toBeFalsy();
  expect(await r.text()).toMatch(/nosuch/);
  const u = await page.request.post('/api/machines/nosuch/sandboxes/sb1/unity', { data: { action: 'reboot' } });
  expect(u.status()).toBe(400);
});

test("fleet: BEAST's own daemon holds its sandboxes: they stay under BEAST, and open as its machine sandboxes", async ({ page }) => {
  await fixedFleet(page, '#/', migratedFleet());
  const sidebar = await openSidebar(page);
  const groups = sidebar.locator('.fl-group');
  // No group of its own for the daemon: the same four computers as before the migration. Counted first, as above: the
  // machines' groups render a moment after the sidebar, and a read before that failed about half the time.
  await expect(groups).toHaveCount(4);
  expect(await groups.evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')))).toEqual(['fl-group-host', 'fl-group-lothdesktop', 'fl-group-m5', 'fl-group-m3']);
  await expect(sidebar.locator('.section-head', { hasText: 'Computers' }).locator('.count')).toHaveText('4');
  const beast = sidebar.getByTestId('fl-group-host');
  await expect(beast.locator('.fl-name')).toHaveText('BEAST');
  await expect(beast.getByTestId('fl-os')).toHaveText('Windows · host');
  // Its limits are the daemon's pool now (max_sandboxes 5, max_unity 4).
  await expect(beast.getByTestId('fl-capacity')).toHaveText('2/5 sandboxes · 1/4 editors');
  await expect(beast.getByTestId('fl-agents-sum')).toHaveText('1 agent, 1 busy');
  const play = beast.getByTestId('fl-sandbox-beast/agent-a');
  await expect(play.getByTestId('fl-agent')).toContainText(/Honest co-op: BEAST client\s*busy\s*1m/);
  await expect(beast.getByTestId('fl-sandbox-beast/agent-b').locator('.fl-free')).toHaveText('FREE');
  if (!isMobile(page)) await proof(page, 'sidebar-beast-daemon');
  await play.getByTestId('fl-agent').click();
  await expect(page).toHaveURL(/#\/machine\/beast\/sandbox\/agent-a\/b-play$/);
  await expect(page.getByTestId('machine-sandbox-panel')).toBeVisible();
});

test("fleet: BEAST's card says when its daemon is down, and opens the daemon's page", async ({ page }) => {
  await fixedFleet(page, '#/overview', migratedFleet(false));
  const board = page.getByTestId('overview');
  await expect(board.locator('.board-card')).toHaveCount(4);
  const card = board.getByTestId('board-host');
  await expect(card.getByTestId('fl-os')).toHaveText('Windows · host · daemon offline');
  await expect(card.locator('.board-head-link')).toHaveAttribute('title', "Open BEAST's daemon (beast)");
  await card.locator('.board-head-link').click();
  await expect(page).toHaveURL(/#\/machine\/beast$/);
});
