import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CLAUDE_DOCS_CONNECTOR, ROOT, VOICE_DEFAULTS, loadConfig, ownerLine } from './config.ts';
import { gitIsClean, gitRemotes } from './guard.ts';
import { appVersion, formatVersion, readSha, readVersion } from './version.ts';

/** config.json loading, the app version, and the guard's two real git lookups. */

function withConfig(t: { after: (fn: () => void) => void }, raw: unknown) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-config-'));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, typeof raw === 'string' ? raw : JSON.stringify(raw));
  const before = process.env.FFSB_CONFIG;
  process.env.FFSB_CONFIG = file;
  t.after(() => {
    if (before === undefined) delete process.env.FFSB_CONFIG;
    else process.env.FFSB_CONFIG = before;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

const minimal = (dir: string) => ({
  sandboxRoot: path.join(dir, 'sb'),
  repo: { url: 'https://example.test/game.git', basePath: path.join(dir, 'base') },
  unity: { editorPath: 'C:/Unity/{version}/Editor/Unity.exe' },
});

test('loadConfig: defaults fill what the file leaves out, nested objects merge', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-config-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  withConfig(t, { ...minimal(dir), dataDir: path.join(dir, 'data'), limits: { maxUnity: 1 }, unity: { editorPath: 'x', watchdog: { stallMinutes: 5 } }, voice: { model: 'small.en' } });
  const cfg = loadConfig();
  assert.equal(cfg.port, 8790);
  assert.deepEqual(cfg.limits, { maxUnity: 1, maxSessions: 6, maxSandboxes: 4, minFreeGB: 100, minFreeRamGB: 10 });
  assert.equal(cfg.unity.idleStopMinutes, 120);
  assert.equal(cfg.hostGuard.warnFreeGB, 80);
  assert.ok(cfg.hostGuard.cleanup.tempPatterns.includes('edge-shot-*'));
  assert.equal(cfg.unity.watchdog.stallMinutes, 5);
  assert.equal(cfg.unity.watchdog.autoDismiss, true);
  assert.deepEqual(cfg.unity.extraArgs, []);
  assert.equal(cfg.voice.model, 'small.en');
  assert.equal(cfg.voice.tts, VOICE_DEFAULTS.tts);
  assert.equal(cfg.voice.toolsDir, path.join(dir, 'data', 'tools', 'whisper'));
  assert.equal(cfg.standingRoot, path.join(path.resolve(dir, 'sb'), '_agents'));
  assert.equal(cfg.orchestrator.notifyOnWorkerEvents, true);
  assert.deepEqual(cfg.worker.claudeAiConnectors, [CLAUDE_DOCS_CONNECTOR]);
});

test('loadConfig: worker.claudeAiConnectors must be a list of https URLs', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-config-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  withConfig(t, { ...minimal(dir), dataDir: path.join(dir, 'data'), worker: { claudeAiConnectors: 'Claude Docs' } });
  assert.throws(() => loadConfig(), /worker.claudeAiConnectors is a list/);
  withConfig(t, { ...minimal(dir), dataDir: path.join(dir, 'data'), worker: { claudeAiConnectors: [] } });
  assert.deepEqual(loadConfig().worker.claudeAiConnectors, []);
});

test('loadConfig: required keys, and standing agents kept out of the app and its data', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-config-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  withConfig(t, { repo: minimal(dir).repo, unity: minimal(dir).unity });
  assert.throws(() => loadConfig(), /missing "sandboxRoot"/);
});

test('loadConfig: a standingRoot inside the app folder is refused', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-config-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  withConfig(t, { ...minimal(dir), dataDir: path.join(dir, 'data'), standingRoot: path.join(ROOT, 'agents') });
  assert.throws(() => loadConfig(), /must not be inside/);
});

test('loadConfig: no file says how to make one', (t) => {
  const before = process.env.FFSB_CONFIG;
  process.env.FFSB_CONFIG = path.join(os.tmpdir(), 'ffsb-no-such-config.json');
  t.after(() => (before === undefined ? delete process.env.FFSB_CONFIG : (process.env.FFSB_CONFIG = before)));
  assert.throws(() => loadConfig(), /Copy config.example.json/);
});

test('ownerLine: one line naming the user, or nothing', () => {
  assert.equal(ownerLine({}), '');
  assert.equal(ownerLine({ ownerName: '  ' }), '');
  assert.equal(ownerLine({ ownerName: ' Ben\n Ryding ' }), '\nThe user (the person who runs this portal) is Ben Ryding.\n');
});

test('version: package.json and the checkout, with an override for builds without .git', (t) => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(readVersion(), pkg.version);
  assert.equal(appVersion().version, pkg.version);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-version-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(readVersion(dir), '0.0.0'); // no package.json
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"x"}');
  assert.equal(readVersion(dir), '0.0.0'); // no version in it

  const before = process.env.FFSB_GIT_SHA;
  t.after(() => (before === undefined ? delete process.env.FFSB_GIT_SHA : (process.env.FFSB_GIT_SHA = before)));
  delete process.env.FFSB_GIT_SHA;
  assert.equal(readSha(dir), undefined); // not a git checkout
  assert.match(readSha() ?? '', /^[0-9a-f]{7,}$/); // this one is
  process.env.FFSB_GIT_SHA = '0123456789abcdef0123';
  assert.equal(readSha(dir), '0123456789ab');

  assert.equal(formatVersion({ version: '0.1.0', sha: 'abc1234' }), 'v0.1.0 (abc1234)');
  assert.equal(formatVersion({ version: '0.1.0' }), 'v0.1.0');
  assert.equal(formatVersion(undefined), 'unknown version');
});

test('guard git lookups: a clean tree, a dirty one, not a repo; push remotes', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-git-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(gitIsClean(dir), false); // not a repo: unknown counts as not clean
  assert.equal(gitRemotes(dir), undefined);
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { stdio: 'ignore' });
  git('init', '-q');
  assert.equal(gitIsClean(dir), true);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'x');
  assert.equal(gitIsClean(dir), false);
  git('remote', 'add', 'origin', 'https://example.test/game.git');
  git('remote', 'set-url', '--push', 'origin', 'git@example.test:game.git');
  git('remote', 'add', 'fork', 'https://example.test/fork.git');
  assert.deepEqual(
    [...gitRemotes(dir)!.entries()].sort(),
    [
      ['fork', 'https://example.test/fork.git'],
      ['origin', 'git@example.test:game.git'],
    ],
  );
});
