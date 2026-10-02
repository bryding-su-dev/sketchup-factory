import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { communityConfigured, editorConfigured, PROJECT_DEFAULTS, projectBrief, ROOT } from './config.ts';
import { seedLocalFiles } from './sandboxes.ts';

test('project defaults describe Final Factory and its brief files exist', () => {
  assert.equal(PROJECT_DEFAULTS.name, 'Final Factory');
  assert.equal(PROJECT_DEFAULTS.integration, 'push');
  for (const f of [PROJECT_DEFAULTS.workerBriefFile!, PROJECT_DEFAULTS.orchestratorBriefFile!, 'project/sketchup/worker-brief.md', 'project/sketchup/orchestrator-brief.md']) {
    assert.ok(fs.existsSync(path.join(ROOT, f)), `${f} missing`);
  }
});

test('projectBrief reads the file once configured and is "" otherwise', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-project-'));
  const file = path.join(dir, 'brief.md');
  fs.writeFileSync(file, '## Notes\nhello\n');
  assert.equal(projectBrief({ project: { ...PROJECT_DEFAULTS, workerBriefFile: file } }, 'workerBriefFile'), '## Notes\nhello');
  assert.equal(projectBrief({ project: { ...PROJECT_DEFAULTS, workerBriefFile: undefined } }, 'workerBriefFile'), '');
  assert.equal(projectBrief({ project: { ...PROJECT_DEFAULTS, workerBriefFile: path.join(dir, 'missing.md') } }, 'workerBriefFile'), '');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('editorConfigured and communityConfigured follow the config switches', () => {
  assert.equal(editorConfigured({ unity: { editorPath: '' } as never }), false);
  assert.equal(editorConfigured({ unity: { editorPath: '/Applications/Unity/Unity.app' } as never }), true);
  assert.equal(communityConfigured({}), true);
  assert.equal(communityConfigured({ project: PROJECT_DEFAULTS }), true);
  assert.equal(communityConfigured({ project: { ...PROJECT_DEFAULTS, community: false } }), false);
});

test('seedLocalFiles copies what the reference clone has, skips the rest, keeps existing files, refuses escapes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-seed-'));
  const ref = path.join(dir, 'ref');
  const sb = path.join(dir, 'sb');
  fs.mkdirSync(path.join(ref, 'certs'), { recursive: true });
  fs.mkdirSync(sb);
  fs.writeFileSync(path.join(ref, '.env'), 'A=1');
  fs.writeFileSync(path.join(ref, 'certs', 'key.pem'), 'key');
  fs.writeFileSync(path.join(sb, '.env'), 'MINE=1');
  const skipped = seedLocalFiles({ referenceRepo: ref, seedFiles: ['.env', 'certs/key.pem', '.env.local'] }, sb);
  assert.deepEqual(skipped, ['.env.local']);
  assert.equal(fs.readFileSync(path.join(sb, '.env'), 'utf8'), 'MINE=1');
  assert.equal(fs.readFileSync(path.join(sb, 'certs', 'key.pem'), 'utf8'), 'key');
  assert.deepEqual(seedLocalFiles({ referenceRepo: ref }, sb), []);
  assert.deepEqual(seedLocalFiles({ seedFiles: ['.env'] }, sb), ['.env']);
  assert.throws(() => seedLocalFiles({ referenceRepo: ref, seedFiles: ['../outside'] }, sb), /leaves its folder/);
  fs.rmSync(dir, { recursive: true, force: true });
});
