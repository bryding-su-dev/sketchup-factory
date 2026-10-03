/**
 * The FF Factory server as the E2E suite runs it: the real server/index.ts, against a throwaway
 * config and data folder, with a scripted fake in place of the Agent SDK (e2e/fakeAgent.ts). No
 * Unity, no Claude, no network. Playwright starts one per browser project (playwright.config.ts).
 *
 *   E2E_PORT=8791 node e2e/server.ts      (needs the web UI built: npm --prefix web run build)
 *
 * Seeded state (fixed, so screenshots are stable):
 *   sandbox "alpha"    ready, Unity stopped: tests start their own worker agents here
 *   sandbox "gallery"  one idle worker with a seeded transcript, for visual snapshots; never changed
 *   sandbox "stuck"    Unity blocked on a dialog (the watchdog's badge)
 *   login              tester / e2e-password-123 (the owner)
 *   second login       teammate / e2e-teammate-456, "Team Mate", a member (e2e/identity.spec.ts), with an /mcp API
 *                      key bound to it in <data folder>/../teammate-key.txt
 *   Max                a mock Discord on <port + 100> (e2e/mockDiscord.ts) with a bot token in a scratch ffbox config, and
 *                      five seeded events from the gallery worker (e2e/max.spec.ts)
 *   provider "ffbox"   only with E2E_PROVIDER=1 (the provider projects, e2e/provider.spec.ts): switched on, with
 *                      E2E_PROVIDER_TOKEN as its connector token. Off everywhere else, so no other page changes.
 *   intake             only with E2E_INTAKE=1 (the intake projects, e2e/intake.spec.ts): the Discord intake on, reading the
 *                      mock Discord, with Discord id INTAKE_TRUSTED trusted as tester; its cursors start at the server's
 *                      start, so only what a test posts is new. Off everywhere else.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Sandbox, SessionInfo, TranscriptEvent } from '../shared/types.ts';
import { RED_PNG, fakeQuery } from './fakeAgent.ts';
import { E2E_PROVIDER_TOKEN } from './mockConnector.ts';
import { CH, SEEDED_CURSORS, snowflake, startMockDiscord, writeFfboxConfig, writeMaxEvents } from './mockDiscord.ts';

export const USER = 'tester';
export const PASSWORD = 'e2e-password-123';
export const MATE = 'teammate';
export const MATE_PASSWORD = 'e2e-teammate-456';
const withProvider = process.env.E2E_PROVIDER === '1';
const withIntake = process.env.E2E_INTAKE === '1';
/** The Discord user id the intake projects trust, mapped to tester (e2e/intake.spec.ts). */
export const INTAKE_TRUSTED = '444444444444444444';

const ROOT = path.resolve(import.meta.dirname, '..');
const port = Number(process.env.E2E_PORT ?? 8791);
const base = path.join(os.tmpdir(), `ffsb-e2e-${port}`);

if (!fs.existsSync(path.join(ROOT, 'web', 'dist', 'index.html'))) {
  console.error('e2e: the web UI is not built. Run: npm --prefix web run build');
  process.exit(1);
}

fs.rmSync(base, { recursive: true, force: true, maxRetries: 5 });
const dataDir = path.join(base, 'data');
const sandboxRoot = path.join(base, 'sandboxes');
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(sandboxRoot, { recursive: true });

// A tiny git repo stands in for the game repo: the base clone and each sandbox folder.
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore', windowsHide: true });
function repo(dir: string, branch: string) {
  fs.mkdirSync(path.join(dir, 'Screenshots'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'README.md'), '# Mock game repo\n');
  git(dir, 'init', '-q', '-b', branch);
  git(dir, '-c', 'user.name=E2E', '-c', 'user.email=e2e@users.noreply.github.com', 'add', '-A');
  git(dir, '-c', 'user.name=E2E', '-c', 'user.email=e2e@users.noreply.github.com', 'commit', '-q', '-m', 'Initial commit');
}
repo(path.join(base, 'base'), 'develop');
for (const id of ['alpha', 'gallery', 'stuck']) repo(path.join(sandboxRoot, id), `sandbox/${id}`);
// A short clip in a sandbox's screenshot folder, with the .meta Unity writes beside it (e2e/video.spec.ts).
const videos = path.join(sandboxRoot, 'alpha', 'Assets', 'Screenshots', 'Videos');
fs.mkdirSync(videos, { recursive: true });
fs.copyFileSync(path.join(ROOT, 'e2e', 'fixtures', 'clip.webm'), path.join(videos, 'clip.webm'));
fs.writeFileSync(path.join(videos, 'clip.webm.meta'), 'fileFormatVersion: 2\nguid: 0\n');
// A screenshot in a sandbox that the orchestrator mentions by path (e2e/images.spec.ts).
fs.writeFileSync(path.join(sandboxRoot, 'gallery', 'Screenshots', 'orch-proof.png'), Buffer.from(RED_PNG, 'base64'));

// Max (docs/max.md): the token in a scratch ffbox config, a mock Discord, and what agents' ffdiscord calls wrote.
const discordPort = port + 100;
await startMockDiscord(discordPort);
writeFfboxConfig(path.join(base, 'ffbox'));
writeMaxEvents(path.join(base, 'max-events.jsonl'), 'gallery1');
fs.writeFileSync(path.join(dataDir, 'max.json'), JSON.stringify({ events: [], cursors: SEEDED_CURSORS, channels: {} }));
// The intake's first look is done: only threads and messages posted from now on are new.
if (withIntake) {
  const start = snowflake(new Date(Date.now() - 1000).toISOString());
  fs.writeFileSync(path.join(dataDir, 'intake.json'), JSON.stringify({ cursors: { [`bug:${CH.betaBugs}`]: start, [`bug:${CH.bugs}`]: start, [`req:${CH.devChat}`]: start }, recent: [], versions: {} }));
}

const configFile = path.join(base, 'config.json');
fs.writeFileSync(
  configFile,
  JSON.stringify(
    {
      port,
      host: '127.0.0.1',
      trustProxy: false,
      ownerName: 'Tester',
      dataDir,
      sandboxRoot,
      repo: { url: path.join(base, 'base'), basePath: path.join(base, 'base') },
      defaultBase: 'develop',
      unity: { editorPath: path.join(base, 'no-unity', 'Unity.exe'), watchdog: { stallMinutes: 0, runningPollSeconds: 0, autoDismiss: false } },
      limits: { maxUnity: 2, maxSessions: 50, maxSandboxes: 10, minFreeGB: 0 },
      models: ['opus', 'sonnet'],
      defaultModel: 'opus',
      // Worker updates reach people's own orchestrators (docs/orchestrators.md; e2e/orchestrators.spec.ts).
      orchestrator: { model: 'opus', effort: 'low', notifyOnWorkerEvents: true },
      worker: { permissionMode: 'bypassPermissions', effort: 'low' },
      voice: { enabled: false, autoInstall: false, tts: false },
      // A 20 MB cap: e2e/attachments.spec.ts sends a 9 MB file (two chunks) and is refused a 21 MB one.
      attachments: { maxMB: 20 },
      max: { eventsFile: path.join(base, 'max-events.jsonl'), ffboxConfigDir: path.join(base, 'ffbox'), discordApi: `http://127.0.0.1:${discordPort}/api/v10`, inbound: { pollMinutes: 60 } },
      ...(withIntake ? { intake: { discord: { enabled: true, bugChannels: ['beta_bugs', 'bug_reports'], trusted: { [INTAKE_TRUSTED]: 'tester' }, pollMinutes: 120 }, reviewers: ['tester'] } } : {}),
      // The provider projects also take FFBox's ledger check and its fix branches (docs/intake.md; e2e/provider.spec.ts).
      ...(withProvider
        ? {
            providers: { ffbox: { enabled: true, tokenSha256: createHash('sha256').update(E2E_PROVIDER_TOKEN).digest('hex') } },
            intake: { ffbox: { enabled: true, boardCheck: true, escalations: true, repo: 'Final-Factory/FinalFactory' } },
          }
        : {}),
    },
    null,
    2,
  ),
);

const T0 = '2026-09-24T09:00:00.000Z';
const at = (min: number) => new Date(Date.parse(T0) + min * 60_000).toISOString();
const sandbox = (id: string, purpose: string, sessionIds: string[] = []): Sandbox => ({
  id,
  name: id,
  branch: `sandbox/${id}`,
  base: 'develop',
  path: path.join(sandboxRoot, id),
  purpose,
  status: 'ready',
  createdAt: T0,
  unity: { state: 'stopped' },
  sessionIds,
});
const gallery: SessionInfo = {
  id: 'gallery1',
  kind: 'worker',
  sandboxId: 'gallery',
  title: 'Seeded worker',
  status: 'idle',
  model: 'opus',
  permissionMode: 'bypassPermissions',
  sdkSessionId: 'fake-gallery',
  createdAt: T0,
  lastActivityAt: at(4),
  turns: 1,
  costUsd: 0.42,
  pendingPermissions: [],
  lastResult: 'The belt splitter now balances all three outputs.',
};
fs.writeFileSync(
  path.join(dataDir, 'state.json'),
  JSON.stringify({
    sandboxes: [sandbox('alpha', 'E2E playground'), sandbox('gallery', 'Visual baseline', ['gallery1']), sandbox('stuck', 'Unity blocked demo')],
    sessions: [gallery],
    settings: { heartbeatMinutes: null },
  }),
);
/** A transcript event before its seq is assigned (Omit over each member of the union). */
type Unnumbered = TranscriptEvent extends infer E ? (E extends TranscriptEvent ? Omit<E, 'seq'> : never) : never;
const events: Unnumbered[] = [
  { t: at(0), kind: 'user', from: 'human', text: 'Make the belt splitter balance its three outputs (zebrafish).' },
  { t: at(1), kind: 'assistant', text: 'I will look at **SplitterSystem** first, then write a test.\n\n- read the system\n- add a failing test\n- fix it' },
  { t: at(2), kind: 'tool_use', toolUseId: 'tu1', name: 'Bash', input: { command: 'git status --short', description: 'Show changed files' } },
  { t: at(2), kind: 'tool_result', toolUseId: 'tu1', isError: false, text: ' M Assets/Scripts/SplitterSystem.cs' },
  { t: at(3), kind: 'assistant', text: 'The belt splitter now balances all three outputs.' },
  { t: at(4), kind: 'result', ok: true, text: 'The belt splitter now balances all three outputs.', costUsd: 0.42, turns: 3, durationMs: 95_000 },
];
fs.mkdirSync(path.join(dataDir, 'transcripts'), { recursive: true });
fs.writeFileSync(path.join(dataDir, 'transcripts', 'gallery1.jsonl'), events.map((e, i) => JSON.stringify({ seq: i + 1, ...e })).join('\n') + '\n');

process.env.FFSB_CONFIG = configFile;
// No stored claude.ai login here, so the plan meter reports "unavailable" instead of starting a CLI;
// and no agents' token from the environment this runs in, which the meter would poll for real.
process.env.CLAUDE_CONFIG_DIR = path.join(base, 'claude');
delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
// Nor a real Discord token: Max reads only the scratch ffbox config above.
for (const k of ['DISCORD_TOKEN', 'FFDISCORD_APP_TOKEN', 'FFDISCORD_SERVER_ID', 'FFBOX_SECRETS', 'FFBOX_CONFIG_DIR']) delete process.env[k];
fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });

const { Auth } = await import('../server/auth.ts');
const auth = new Auth(dataDir, { trustProxy: false });
await auth.setUser(USER, PASSWORD);
await auth.setUser(MATE, MATE_PASSWORD, { displayName: 'Team Mate', role: 'member' });
fs.writeFileSync(path.join(base, 'teammate-key.txt'), auth.createApiKey('teammate-laptop', MATE));
// FFBox's key for Max's escalations (docs/intake.md), scoped to POST /api/intake/ffbox (e2e/provider.spec.ts).
if (withProvider) fs.writeFileSync(path.join(base, 'ffbox-key.txt'), auth.createApiKey('ffbox', undefined, 'ffbox'));

const { setQueryForTesting } = await import('../server/sessions.ts');
setQueryForTesting(fakeQuery() as never);

const { internals } = await import('../server/index.ts');

// After the server's own reconcile (which clears a blocked state on boot): an editor stuck on a dialog.
// It has no pid and no log, so the poll and the watchdog leave it as it is.
const stuck = internals.store.sandboxes.get('stuck')!;
internals.store.putSandbox({
  ...stuck,
  unity: {
    state: 'blocked',
    detail: 'blocked: Safe Mode: compile errors',
    blocked: {
      reason: 'dialog',
      title: 'Enter Safe Mode?',
      text: 'The project has compilation errors.',
      buttons: ['Enter Safe Mode', 'Ignore', 'Quit'],
      advice: 'Press Ignore, then fix the compile errors.',
      since: at(5),
      resumeState: 'starting',
    },
  },
});
console.log(`e2e: FF Factory test server ready on http://127.0.0.1:${port} (data in ${base})`);
