// The Plan / Bedrock / Auto switch as a script (w38, docs/bedrock.md): plain code, no agent and no model, so it works
// when the plan has no tokens left. scripts/backend.ts is its command line. With the server up it asks the server
// (GET /api/backend, POST /api/backend/mode, with a key minted --scope backend), which applies the mode to the very next
// message; with the server down it edits config.json, and the mode holds from the next start.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BACKEND_MODES, type BackendMode } from './bedrock.ts';
import type { BackendStatus } from '../shared/types.ts';

export type SwitchCommand = 'status' | BackendMode;
export const SWITCH_COMMANDS: readonly SwitchCommand[] = ['status', ...BACKEND_MODES];
export const DEFAULT_KEY_FILE = path.join(os.homedir(), '.sketchup-factory-backend-key');

export interface SwitchArgs {
  command: SwitchCommand;
  url?: string;
  keyFile?: string;
}

export const USAGE = `usage: node scripts/backend.ts <status|plan|bedrock|auto> [--url http://127.0.0.1:8790] [--key-file ${DEFAULT_KEY_FILE}]
  plan     always your Claude plan          bedrock  always Amazon Bedrock (SketchUp's money, capped per day)
  auto     Bedrock only when the plan's 5-hour usage reaches the threshold
  status   what runs where now, and today's Bedrock spend
The key: FF_BACKEND_KEY, or the key file (mint one with: node server/apikey.ts <name> --scope backend).`;

/** The command line's meaning, or the problem. */
export function parseSwitchArgs(argv: readonly string[], env: Record<string, string | undefined> = process.env): SwitchArgs | { error: string } {
  const rest = [...argv];
  let url = env.FF_URL;
  let keyFile = env.FF_BACKEND_KEY_FILE;
  let command: SwitchCommand | undefined;
  while (rest.length) {
    const a = rest.shift()!;
    if (a === '--url' || a === '--key-file') {
      const v = rest.shift();
      if (!v) return { error: `${a} needs a value` };
      if (a === '--url') url = v;
      else keyFile = v;
    } else if (SWITCH_COMMANDS.includes(a as SwitchCommand) && !command) command = a as SwitchCommand;
    else return { error: `unexpected argument "${a}"` };
  }
  if (!command) return { error: 'say what to do: status, plan, bedrock or auto' };
  return { command, ...(url ? { url: url.replace(/\/+$/, '') } : {}), ...(keyFile ? { keyFile } : {}) };
}

/** The key from FF_BACKEND_KEY or the key file; never printed anywhere. */
export function readKey(args: Pick<SwitchArgs, 'keyFile'>, env: Record<string, string | undefined> = process.env): string | undefined {
  const fromEnv = env.FF_BACKEND_KEY?.trim();
  if (fromEnv) return fromEnv;
  try {
    return fs.readFileSync(args.keyFile ?? DEFAULT_KEY_FILE, 'utf8').trim() || undefined;
  } catch {
    return undefined;
  }
}

/** One line of what runs where, from the server's status. */
export function describeBackend(b: BackendStatus): string {
  const where = b.active === 'blocked' ? 'WAITING (cap spent, plan full)' : b.active === 'bedrock' ? 'BEDROCK' : 'your Claude PLAN';
  const spend = `Bedrock today $${b.spend.todayUsd.toFixed(2)} of $${b.spend.dailyBudgetUsd}, this week $${b.spend.weekUsd.toFixed(2)}`;
  return [`Agents run on ${where} (mode ${b.mode}): ${b.reason}.`, spend + '.', ...(b.problem ? [`Bedrock cannot be used: ${b.problem}`] : []), ...(b.configured ? [] : ['Bedrock is not set up (config bedrock.profile).'])].join('\n');
}

export interface SwitchDeps {
  fetch: typeof fetch;
  /** Server down: set bedrock.mode in config.json (undefined: this host cannot). */
  offlineSet?: (mode: BackendMode) => void;
}

/** Do the command; returns the lines to print, or throws with what went wrong (never containing the key). */
export async function runSwitch(args: SwitchArgs, key: string | undefined, deps: SwitchDeps): Promise<string[]> {
  const base = args.url;
  if (!base) throw new Error('no server URL: pass --url or set FF_URL');
  const headers: Record<string, string> = { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) };
  const call = async (method: 'GET' | 'POST', route: string, body?: unknown) => {
    const res = await deps.fetch(`${base}${route}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15_000) });
    const text = await res.text();
    let json: { backend?: BackendStatus; error?: string } & Partial<BackendStatus> = {};
    try {
      json = JSON.parse(text);
    } catch {
      // not JSON: reported below by status
    }
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) throw new Error(`the server refused the key (${res.status}): ${json.error ?? 'mint one with node server/apikey.ts <name> --scope backend'}`);
      throw new Error(`the server answered ${res.status}: ${json.error ?? text.slice(0, 200)}`);
    }
    return (json.backend ?? json) as BackendStatus;
  };
  const down = (e: unknown) => /fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|timed out|aborted|TimeoutError/i.test(`${(e as Error).message} ${(e as { cause?: { code?: string } }).cause?.code ?? ''}`);
  if (!key && args.command === 'status') throw new Error('no key: set FF_BACKEND_KEY or put one in the key file (node server/apikey.ts <name> --scope backend)');
  try {
    if (args.command === 'status') return [describeBackend(await call('GET', '/api/backend'))];
    if (!key) throw new Error('no key: set FF_BACKEND_KEY or put one in the key file (node server/apikey.ts <name> --scope backend)');
    const b = await call('POST', '/api/backend/mode', { mode: args.command });
    return [`Mode is now ${b.mode}.`, describeBackend(b), 'Running agents finish their turn where they are; the next message to each uses it.'];
  } catch (e) {
    if (!down(e) || args.command === 'status') throw down(e) ? new Error(`the server at ${base} does not answer (${(e as Error).message})`) : e;
    if (!deps.offlineSet) throw e;
    deps.offlineSet(args.command as BackendMode);
    return [`The server at ${base} does not answer, so bedrock.mode is set to "${args.command}" in config.json only.`, 'It holds from the next start of the server.'];
  }
}
