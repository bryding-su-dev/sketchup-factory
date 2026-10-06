// Which tools each orchestrator gets (docs/orchestrators.md). Every tool is built once, by Agents.toolSpecs; a role's
// belt is a selection of them. A person's own orchestrator gets an allow-list: looking, its own wake-ups and heartbeat,
// follow-ups to its person's workers, the ledger, and messages to other people. The dispatcher gets the rest. A tool
// added later is the dispatcher's until someone adds it here, which is the safe way round.
import { z } from 'zod';

/** What a tool belt is built from: the shape of Agents.toolSpecs's entries. */
export interface BeltTool {
  name: string;
  description: string;
  schema: z.ZodRawShape;
  handler: (args: Record<string, unknown>) => Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }>;
}

/** A person's own orchestrator: read-only visibility, plus these few. */
export const PERSONAL_TOOLS: ReadonlySet<string> = new Set([
  // looking
  'list_sandboxes',
  'list_machines',
  'list_branches',
  'agent_transcript',
  'search_transcripts',
  'system_status',
  'ffbox_activity',
  'max_activity',
  'list_standing_agents',
  'list_delegation_requests',
  // its own
  'wake_me',
  'compact_conversation',
  'set_heartbeat',
  'set_timer',
  'list_timers',
  'update_timer',
  'cancel_timer',
  // follow-ups to its person's own workers (scoped in the handler)
  'message_agent',
  // the ledger
  'request_work',
  'list_work',
  'update_work',
  // another person's own orchestrator (scoped in the handler)
  'message_person',
]);

/** Tools that need a person's own orchestrator (its chat's budget, its person's requests, its person as the sender). */
const PERSONAL_ONLY: ReadonlySet<string> = new Set(['request_work', 'update_work', 'message_person']);

/** The dispatcher has no heartbeat of its own: each person's wakes their own orchestrator. */
const NOT_DISPATCHER: ReadonlySet<string> = new Set([...PERSONAL_ONLY, 'set_heartbeat']);

/** Tools only the dispatcher has. */
const DISPATCHER_ONLY: ReadonlySet<string> = new Set(['decide_work', 'send_to_ffbox']);

/** Tools for an orchestrator's own conversation (w535), which a remote client does not have. */
const NOT_REMOTE: ReadonlySet<string> = new Set(['compact_conversation']);

/**
 * The dispatcher's destructive and administrative tools, which run only when a person asked. They run in a turn a
 * person started in the dispatcher's own chat, or for a request (work_id) its person filed or last changed in a turn of
 * their own. Recovery tools (host_recovery, machine_daemon) stay free: the dispatcher answers the host's notices alone.
 */
export const USER_ASKED_TOOLS: ReadonlySet<string> = new Set([
  'delete_sandbox',
  'request_app_update',
  'set_app_config',
  'republish_public',
  'add_machine',
  'remove_machine',
  'migrate_host_sandboxes',
  'create_standing_agent',
  'update_standing_agent',
  'delete_standing_agent',
  'approve_delegation',
]);

export type BeltRole = 'dispatcher' | 'personal' | 'remote';

/**
 * The tools of a role. `guard` (dispatcher) is asked before a user_asked tool runs, with the work_id it was given;
 * it answers why not, or undefined. Those tools gain an optional work_id for it.
 */
export function beltFor<T extends BeltTool>(role: BeltRole, all: readonly T[], guard?: (tool: string, workId: string | undefined) => string | undefined): T[] {
  if (role === 'personal') return all.filter((t) => PERSONAL_TOOLS.has(t.name));
  if (role === 'remote') return all.filter((t) => !PERSONAL_ONLY.has(t.name) && !DISPATCHER_ONLY.has(t.name) && !NOT_REMOTE.has(t.name));
  return all
    .filter((t) => !NOT_DISPATCHER.has(t.name))
    .map((t) => {
      if (!USER_ASKED_TOOLS.has(t.name) || !guard) return t;
      return {
        ...t,
        schema: 'work_id' in t.schema ? t.schema : { ...t.schema, work_id: z.string().optional().describe('The request (w12) this serves, when a person asked for it through their orchestrator.') },
        handler: async (args: Record<string, unknown>) => {
          const why = guard(t.name, typeof args.work_id === 'string' ? args.work_id : undefined);
          if (why) return { content: [{ type: 'text' as const, text: `ERROR: ${why}` }], isError: true };
          return t.handler(args);
        },
      };
    });
}
