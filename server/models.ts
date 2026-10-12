// The model policy (w33, docs/models.md). Ben, 2026-10-12: "aggressively use sonnet 5.5 and even delegate stuff to haiku 5.5
// ... i still want opus 5.5 to be the brains of the operations, it should be checking important work and making plans".
// Opus runs the orchestrators and the dispatcher (config orchestrator.model) and a worker's planner and reviewer
// subagents; Sonnet is every worker's main loop (config defaultModel); Haiku does a worker's cheap lookups (its scout
// subagent) and Claude Code's own background calls. Every Claude process the app starts gets modelEnv's pins.
import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';
import type { Config } from './config.ts';

/** The ids the aliases mean here, checked 2026-10-12 against platform.claude.com/docs/en/about-claude/models/overview. */
export const MODEL_IDS = { opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5' } as const;
export type ModelAlias = keyof typeof MODEL_IDS;
export const MODEL_ALIASES = Object.keys(MODEL_IDS) as ModelAlias[];
/** A full model id as Claude Code takes one ("claude-haiku-5-5", "claude-haiku-4-5-20251001"). */
export const MODEL_ID = /^claude-[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * What an alias resolves to in every Claude process the app starts, where Claude Code's own table would pick another
 * model. The Agent SDK this app pins (0.3.284, Claude Code 2.1.284) maps `haiku` to claude-haiku-4-5-20251001, for the
 * alias and for its own background calls alike (measured 2026-10-12); `opus` and `sonnet` already map to the 5.5 ids.
 * Config `modelPins` changes or adds a pin; an empty string removes one.
 */
export const DEFAULT_MODEL_PINS: Partial<Record<ModelAlias, string>> = { haiku: MODEL_IDS.haiku };

/** Claude Code's environment variable for each alias's model. */
const PIN_ENV: Record<ModelAlias, string> = {
  opus: 'ANTHROPIC_DEFAULT_OPUS_MODEL',
  sonnet: 'ANTHROPIC_DEFAULT_SONNET_MODEL',
  haiku: 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
};

/** The pins in force: the defaults with config modelPins over them. */
export function modelPins(cfg: Pick<Config, 'modelPins'>): Partial<Record<ModelAlias, string>> {
  const out: Partial<Record<ModelAlias, string>> = { ...DEFAULT_MODEL_PINS };
  for (const [alias, id] of Object.entries(cfg.modelPins ?? {}) as [ModelAlias, string | undefined][]) {
    if (!(alias in PIN_ENV)) continue;
    if (id) out[alias] = id;
    else delete out[alias];
  }
  return out;
}

/** The environment that carries the pins. Laid under config claudeEnv, so an entry there still wins. */
export function modelEnv(cfg: Pick<Config, 'modelPins'>): Record<string, string> {
  return Object.fromEntries(Object.entries(modelPins(cfg)).map(([alias, id]) => [PIN_ENV[alias as ModelAlias], id!]));
}

/** A worker's subagents, by role. */
export type SubagentRole = 'planner' | 'reviewer' | 'scout';
export const SUBAGENT_ROLES: SubagentRole[] = ['planner', 'reviewer', 'scout'];

/** Their models: Opus plans and checks, Haiku fetches. Config worker.subagentModels overrides one; "off" drops it. */
export const DEFAULT_SUBAGENT_MODELS: Record<SubagentRole, string> = { planner: 'opus', reviewer: 'opus', scout: 'haiku' };

const SUBAGENTS: Record<SubagentRole, Omit<AgentDefinition, 'model'>> = {
  planner: {
    description:
      'Plans before you build: give it the goal, the constraints and where the code lives, and it reads the code and returns a concrete step-by-step plan (files, order, risks, how to verify). Use it before a change that spans several files or systems, an architectural or API decision, or whenever the approach is unclear. It does not edit files.',
    prompt:
      'You are the planner. Read the code and docs the request points to, weigh the approaches that matter, and return one concrete plan: the steps in order, the files each touches, the risks and open questions, and how the result will be verified. Say what each claim rests on (read in code, measured, or a guess). Never edit files or run commands that change anything.',
    disallowedTools: ['Edit', 'Write', 'NotebookEdit'],
  },
  reviewer: {
    description:
      'Independent review and verification of finished, important work before it merges, ships or is reported done: a pull request, a release step, tests another agent wrote, a fix that must be right. Give it the diff or PR, what the change is for and how it was verified; it returns findings, most severe first, each with where and why. It does not edit files.',
    prompt:
      'You are the reviewer: an independent check of finished work. Read the change and what it is for, then look for what is wrong or missing: correctness bugs, unhandled cases, a test that does not test the claim, a requirement not met, a risk to data or security. Run read-only checks (tests, typecheck, git diff) when they settle a question. Return findings most severe first, each with file:line, the concrete failure, and how sure you are; say plainly when you find nothing that blocks. Never edit files.',
    disallowedTools: ['Edit', 'Write', 'NotebookEdit'],
  },
  scout: {
    description:
      'Cheap, fast help for well-specified small jobs: find where something is defined or used, look a fact up in the code, docs or the web, summarise a file, log or transcript, or make a mechanical edit that the instruction spells out exactly. Not for design decisions, reviews or anything that needs judgement.',
    prompt:
      'You are the scout: do exactly the small job asked, quickly, and report back briefly with the answer and where it came from (file:line or URL). For an edit, make only the change spelled out and say what you changed. If the job needs a judgement call or turns out bigger than described, stop and say so instead of guessing.',
  },
};

/** The worker's model for a role, after config: undefined when it is switched off. */
export function subagentModel(cfg: Pick<Config, 'worker'>, role: SubagentRole): string | undefined {
  const m = (cfg.worker.subagentModels?.[role] ?? DEFAULT_SUBAGENT_MODELS[role]).trim();
  return m && m !== 'off' ? m : undefined;
}

/** The subagents every worker session gets (the SDK's `agents` option). */
export function workerAgents(cfg: Pick<Config, 'worker'>): Record<string, AgentDefinition> {
  const out: Record<string, AgentDefinition> = {};
  for (const role of SUBAGENT_ROLES) {
    const model = subagentModel(cfg, role);
    if (model) out[role] = { ...SUBAGENTS[role], model };
  }
  return out;
}

/** How a model name reads in a brief: "Opus 5.5" for an alias, the id otherwise. */
export function modelName(m: string): string {
  const alias = m.trim().toLowerCase();
  if (alias in MODEL_IDS) return `${alias[0].toUpperCase()}${alias.slice(1)} 5.5`;
  return m;
}

/** The "Models" section of a worker's brief: what it runs on and when to hand a step to which subagent. */
export function workerModelBrief(cfg: Pick<Config, 'worker'>, model: string | undefined): string {
  const roles = SUBAGENT_ROLES.filter((r) => subagentModel(cfg, r));
  const lines = [`## Models`, `You run on ${modelName(model ?? 'sonnet')}. The factory's tokens are limited, so spend the expensive model only where it decides the outcome:`];
  if (roles.includes('scout')) lines.push(`- Lookups, code and doc searches, summaries of long files, logs or transcripts, and mechanical edits you can spell out exactly: hand them to the \`scout\` subagent (${modelName(subagentModel(cfg, 'scout')!)}) with the Agent tool, rather than reading everything yourself.`);
  if (roles.includes('planner')) lines.push(`- Before a change that spans several files or systems, an architectural or API decision, or when the approach is unclear: ask the \`planner\` subagent (${modelName(subagentModel(cfg, 'planner')!)}) for the plan, then carry it out yourself.`);
  if (roles.includes('reviewer')) lines.push(`- Before important work merges, ships or is reported done (a PR into an integration branch, a release step, tests you wrote for someone else's change): have the \`reviewer\` subagent (${modelName(subagentModel(cfg, 'reviewer')!)}) check it, and fix what it finds. Skip it for trivial or test-only changes.`);
  lines.push('- A one-line answer you already know or a two-file read is not worth a subagent: delegation has a cost of its own. The repository may define its own agent roles with their own models; when one fits the job better, use it.');
  return lines.join('\n');
}

/**
 * The model rule the dispatcher (and a person's orchestrator, when it suggests one) follows when it starts work:
 * Sonnet implements, Opus plans and verifies, Haiku does lookups.
 */
export function dispatchModelRule(cfg: Pick<Config, 'defaultModel'>): string {
  return `Models (Ben's policy, w33): start_agent without a model runs ${modelName(cfg.defaultModel)}, the implementer, and that is right for most requests. Pass model "opus" for a request that is itself planning or design (a plan, a spec, an architecture decision, no code yet) or review and verification of important work (a PR review, a final check before a merge or a release, a release gate, an independent review of tests another agent wrote). Pass model "haiku" for a request that is only a lookup, a search, a summary or a mechanical edit spelled out in full. Every worker can also hand single steps to its own planner and reviewer (Opus) and scout (Haiku) subagents, so an implementation request does not need Opus for its planning or final check. When you pick a model other than the default, say which and why where you report the start.`;
}
