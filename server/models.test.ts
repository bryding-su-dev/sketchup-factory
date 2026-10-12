import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_SUBAGENT_MODELS, MODEL_IDS, dispatchModelRule, modelEnv, modelPins, workerAgents, workerModelBrief } from './models.ts';
import { normalizeSetting, setAppConfig } from './appConfig.ts';
import type { Config } from './config.ts';

/** w33: Opus plans and checks, Sonnet implements, Haiku 5.5 does cheap work (docs/models.md). */

const worker = (subagentModels?: Config['worker']['subagentModels']) => ({ worker: { permissionMode: 'bypassPermissions', effort: 'high', ...(subagentModels ? { subagentModels } : {}) } }) as Pick<Config, 'worker'>;

test('w33: haiku is pinned to Haiku 5.5 by default; config pins add, change or remove one', () => {
  assert.deepEqual(modelEnv({}), { ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku-5-5' });
  assert.equal(MODEL_IDS.haiku, 'claude-haiku-5-5');
  assert.deepEqual(modelEnv({ modelPins: { sonnet: 'claude-sonnet-5-5' } }), { ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku-5-5', ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-5-5' });
  assert.deepEqual(modelEnv({ modelPins: { haiku: '' } }), {}, 'an empty pin leaves the alias to Claude Code');
  assert.deepEqual(modelPins({ modelPins: { haiku: 'claude-haiku-4-5-20251001' } }), { haiku: 'claude-haiku-4-5-20251001' });
  assert.deepEqual(modelPins({ modelPins: { gpt: 'x' } as never }), { haiku: 'claude-haiku-5-5' }, 'an unknown alias is ignored');
});

test('w33: every worker gets a read-only Opus planner and reviewer and a Haiku scout; config changes or drops one', () => {
  const a = workerAgents(worker());
  assert.deepEqual(Object.keys(a), ['planner', 'reviewer', 'scout']);
  assert.deepEqual(Object.fromEntries(Object.entries(a).map(([k, v]) => [k, v.model])), DEFAULT_SUBAGENT_MODELS);
  assert.deepEqual(DEFAULT_SUBAGENT_MODELS, { planner: 'opus', reviewer: 'opus', scout: 'haiku' });
  for (const role of ['planner', 'reviewer'] as const) assert.deepEqual(a[role].disallowedTools, ['Edit', 'Write', 'NotebookEdit'], `${role} never edits`);
  assert.equal(a.scout.disallowedTools, undefined, 'the scout makes the mechanical edits it is given');
  const b = workerAgents(worker({ reviewer: 'off', scout: 'claude-haiku-5-5' }));
  assert.deepEqual(Object.keys(b), ['planner', 'scout']);
  assert.equal(b.scout.model, 'claude-haiku-5-5');
});

test("w33: the worker's brief names its own model and only the subagents it has", () => {
  const full = workerModelBrief(worker(), 'sonnet');
  assert.match(full, /^## Models\nYou run on Sonnet 5\.5\./);
  assert.match(full, /`scout` subagent \(Haiku 5\.5\)/);
  assert.match(full, /`planner` subagent \(Opus 5\.5\)/);
  assert.match(full, /`reviewer` subagent \(Opus 5\.5\)/);
  const some = workerModelBrief(worker({ planner: 'off', reviewer: 'off' }), 'opus');
  assert.match(some, /You run on Opus 5\.5/);
  assert.doesNotMatch(some, /planner|reviewer/);
  assert.match(workerModelBrief(worker(), undefined), /You run on Sonnet 5\.5/);
});

test("w33: the dispatcher's rule: the default implements; opus for plans and reviews; haiku for lookups", () => {
  const r = dispatchModelRule({ defaultModel: 'sonnet' });
  assert.match(r, /without a model runs Sonnet 5\.5, the implementer/);
  assert.match(r, /model "opus" for a request that is itself planning or design .* or review and verification of important work/);
  assert.match(r, /model "haiku" for a request that is only a lookup/);
});

test('w33: set_app_config takes the model keys, checks them and applies them live', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'models-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ defaultModel: 'opus', orchestrator: { model: 'opus', effort: 'medium' }, worker: { effort: 'high' } }, null, 2));
  const cfg = { models: ['opus', 'sonnet', 'haiku', 'fable'], defaultModel: 'opus', orchestrator: { model: 'opus', effort: 'medium' }, worker: { permissionMode: 'bypassPermissions', effort: 'high' } } as unknown as Config;

  assert.deepEqual(setAppConfig(file, cfg, 'defaultModel', 'sonnet'), { before: 'opus', after: 'sonnet' });
  assert.equal(cfg.defaultModel, 'sonnet');
  setAppConfig(file, cfg, 'worker.subagentModels.scout', 'haiku');
  setAppConfig(file, cfg, 'worker.subagentModels.reviewer', 'off');
  setAppConfig(file, cfg, 'modelPins.haiku', 'claude-haiku-5-5');
  assert.deepEqual(cfg.worker.subagentModels, { scout: 'haiku', reviewer: 'off' });
  assert.deepEqual(cfg.modelPins, { haiku: 'claude-haiku-5-5' });
  assert.equal(cfg.worker.effort, 'high', 'the rest of worker stays');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(saved, { defaultModel: 'sonnet', orchestrator: { model: 'opus', effort: 'medium' }, worker: { effort: 'high', subagentModels: { scout: 'haiku', reviewer: 'off' } }, modelPins: { haiku: 'claude-haiku-5-5' } });
  // null: back to the default.
  setAppConfig(file, cfg, 'worker.subagentModels.reviewer', null);
  assert.deepEqual(cfg.worker.subagentModels, { scout: 'haiku' });
  setAppConfig(file, cfg, 'orchestrator.model', null);
  assert.equal(cfg.orchestrator.model, 'opus');

  assert.throws(() => normalizeSetting('defaultModel', 'gpt-5', cfg), /defaultModel is one of opus, sonnet, haiku, fable/);
  assert.throws(() => normalizeSetting('orchestrator.model', 'claude-opus-5-5', cfg), /one of/, 'the orchestrators take an alias from models');
  assert.throws(() => normalizeSetting('worker.subagentModels.planner', 'big', cfg), /"off"/);
  assert.equal(normalizeSetting('worker.subagentModels.planner', 'inherit', cfg), 'inherit');
  assert.throws(() => normalizeSetting('modelPins.sonnet', 'sonnet', cfg), /full model id/);
  assert.equal(normalizeSetting('modelPins.sonnet', '', cfg), '');
});
