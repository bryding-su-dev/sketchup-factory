// Which model answers a coordinator's turn (w1158, docs/orchestrators.md "Which model answers a turn"). lothsahn, w1158:
// "2) Do it, use sonnet": turns no person started run on the routine model, turns a person's own message started on the
// coordinator's own model. One session switches per turn with the SDK's setModel (measured: each turn was answered by the
// model asked for). Prompt caches are per model, so every switch writes what the other model has not seen yet: a routine
// turn shortly after a person's stays on the person's model (routineAfterMinutes), and the quiet hours go to the routine one.
import type { Config } from './config.ts';
import type { SessionInfo } from '../shared/types.ts';

/** The routine model by default (lothsahn, w1158: "use sonnet"). config orchestrator.routineModel "off" keeps every turn on the coordinator's own. */
export const ROUTINE_MODEL_DEFAULT = 'claude-sonnet-5-5';

/**
 * How long after a turn on the coordinator's own model its routine turns stay on it (config
 * orchestrator.routineAfterMinutes). Within it a switch would write the conversation to the other model's cache and back.
 */
export const ROUTINE_AFTER_MINUTES_DEFAULT = 60;

/**
 * Harness messages that still get the coordinator's own model: the dispatcher's placement and dispatch decisions, and a
 * person's click (a 👍 on a question of its own counts as the person's words, w1039). The decisions by evidence (w1158's
 * replay, docs/orchestrators.md "Which model answers a turn"): on 10 of 11 kinds of decision Sonnet decided as Opus did,
 * but with a gate open and Ben's note "Unblock this one, go ahead." it started the gated work with override_gate in 3 runs
 * of 3, the mistake of w754; Opus asked Ben in 3 of 3.
 */
export const OWN_MODEL_TAGS: Readonly<Record<'dispatcher' | 'personal', readonly string[]>> = {
  dispatcher: ['work request', 'work update', 'ledger'],
  personal: ['reaction'],
};

export type TurnKind = 'person' | 'own' | 'routine';

/** A harness message's tag, lower case: "[work request] …" → "work request", "[timer t-1 "x"] …" → "timer t-1", "[from FFBox, Lothsahn] …" → "from ffbox". */
export function messageTag(text: string): string | undefined {
  const m = /^\s*\[([^\]\n]{1,80})\]/.exec(text);
  return m ? m[1].split(/[,:"]/)[0].trim().toLowerCase() : undefined;
}

/** What kind of turn a message opens: a person's own words, a harness message the coordinator's own model keeps, or routine. */
export function turnKind(role: 'dispatcher' | 'personal', from: 'human' | 'orchestrator' | 'system', text: string): TurnKind {
  if (from === 'human') return 'person';
  const tag = messageTag(text);
  return tag && OWN_MODEL_TAGS[role].includes(tag) ? 'own' : 'routine';
}

/** The settings in effect: the coordinator's own model, the routine one (undefined: off) and the window after an own turn. */
export function turnModelSettings(cfg: Pick<Config, 'orchestrator'>): { routine?: string; afterMs: number } {
  const r = cfg.orchestrator.routineModel;
  const routine = r === null || r === '' || r === 'off' ? undefined : (r ?? ROUTINE_MODEL_DEFAULT);
  return { routine, afterMs: (cfg.orchestrator.routineAfterMinutes ?? ROUTINE_AFTER_MINUTES_DEFAULT) * 60_000 };
}

/**
 * The per-turn choice for the coordinators' sessions (SessionManager.turnModel). Workers, standing agents and the ops
 * worker are never touched (lothsahn, w1158: "5) Do not do this" to Sonnet for workers).
 */
export class TurnModels {
  /** When each coordinator last ran a turn on its own model (ms), and whether it has run one since its process started. */
  private readonly lastOwn = new Map<string, number>();

  private readonly cfg: () => Pick<Config, 'orchestrator'>;
  private readonly now: () => number;

  constructor(cfg: () => Pick<Config, 'orchestrator'>, now: () => number = Date.now) {
    this.cfg = cfg;
    this.now = now;
  }

  /**
   * The model for the message being sent, or undefined to leave the session's model as it is. `opens`: it starts a turn
   * (a message joining a running turn changes nothing, except a person's, which moves the rest of the turn to the own model).
   */
  pick(info: Pick<SessionInfo, 'id' | 'kind' | 'orchestratorRole'>, from: 'human' | 'orchestrator' | 'system', text: string, opens: boolean): { model: string; kind: TurnKind } | undefined {
    if (info.kind !== 'orchestrator') return undefined;
    const cfg = this.cfg();
    // Its own model is the config's (every coordinator is created on it): info.model follows the live process (its init
    // message), so after a routine turn it names the routine model.
    const own = cfg.orchestrator.model;
    const role = info.orchestratorRole === 'dispatcher' ? 'dispatcher' : 'personal';
    const kind = turnKind(role, from, text);
    const { routine, afterMs } = turnModelSettings(cfg);
    if (kind !== 'routine') {
      if (!opens && kind !== 'person') return undefined;
      this.lastOwn.set(info.id, this.now());
      return { model: own, kind };
    }
    if (!opens) return undefined;
    if (!routine) return { model: own, kind };
    const last = this.lastOwn.get(info.id);
    // Shortly after a turn on its own model, a routine turn stays there: its cache holds the conversation already.
    if (last !== undefined && this.now() - last < afterMs) return { model: own, kind };
    return { model: routine, kind };
  }
}
