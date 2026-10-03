import { createSdkMcpServer, tool, type Options } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import os from 'node:os';
import path from 'node:path';
import { sandboxGuard } from './guard.ts';
import { standingGuard } from './standingGuard.ts';
import { publicIdentityEnv } from './publicGit.ts';
import { usageEnv } from './usage.ts';
import type { StandingToolGroup } from '../shared/types.ts';

/**
 * Claude Code leaves its Artifact tools out of every SDK session (its "sdk_default_off" gate) unless this is set.
 * Publishing still needs a claude.ai login, not a setup-token (docs/accounts.md, "Artifacts and claude.ai connectors").
 * Laid under config claudeEnv, so `"CLAUDE_CODE_ARTIFACT": "0"` there turns it off again.
 */
export const ARTIFACT_ENV = { CLAUDE_CODE_ARTIFACT: '1' } as const;

/**
 * The MCP allowlist (settings `allowedMcpServers`) of a session that loads some claude.ai connectors without the
 * user's own MCP servers: its own servers by name, and the connectors whose upstream URL matches one of
 * `connectorUrls`. Claude Code matches a connector by URL only, never by its "claude.ai <name>" name, and with a URL
 * entry present it matches every remote server by URL, so `ownServers` must be stdio or SDK servers.
 */
export function connectorAllowlist(ownServers: string[], connectorUrls: string[]): { serverName?: string; serverUrl?: string }[] {
  return [...ownServers.map((serverName) => ({ serverName })), ...connectorUrls.map((serverUrl) => ({ serverUrl }))];
}

/** A stdio MCP server the agent process starts (on a machine: the daemon's Unity MCP server, machine/unityMcp.ts). */
export interface StdioServer {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/**
 * Everything needed to start an agent process, as plain data: the portal builds it and a machine daemon
 * turns it into SDK options (docs/machines.md). Hooks and MCP servers are functions, so they cannot
 * cross the wire; the spec names them and buildOptions() rebuilds them where the process runs.
 */
export interface LaunchSpec {
  cwd: string;
  /** A machine sandbox (docs/machines.md): the daemon checks cwd is its folder and gives the guard its editor state. */
  sandbox?: string;
  model?: string;
  effort?: Options['effort'];
  settingSources: NonNullable<Options['settingSources']>;
  /** Appended to the claude_code system prompt. */
  append: string;
  /** Restrict the built-in tools (undefined: all). */
  tools?: string[];
  disallowedTools?: string[];
  /** Only the MCP servers named here (plus `mcp`); false loads the user's own too. */
  strictMcp: boolean;
  /**
   * Give the agent the machine's Unity MCP server as "UnityMCP", confined to its place's editor (the sandbox's, else
   * the main clone's): the daemon fills in `stdioMcp` from it (machine/unityMcp.ts). An older daemon ignores it.
   */
  unityMcp?: boolean;
  /** Stdio MCP servers the process starts, by name (the daemon's, never the portal's: commands are the machine's). */
  stdioMcp?: Record<string, StdioServer>;
  /** An in-process MCP server whose tool calls are answered by `handlers` (on a machine: the portal). */
  mcp?: { server: string; tools: { name: CatalogTool; description: string }[] };
  maxBudgetUsd?: number;
  guard: {
    /** Unity instance prefix (project folder name) and the agent's own folder. */
    id: string;
    ownPath: string;
    protectedPaths: string[];
    gameRepos: string[];
    ownCheckout?: boolean;
    denyToolPrefixes?: string[];
    standing?: { folder: string; groups: StandingToolGroup[]; offLimits: string[] };
    /** Public repos and their commit identity (config publicGitIdentity). */
    publicIdentity?: { repos: string[]; name?: string; email?: string };
  };
  env?: Record<string, string>;
  /**
   * Run on the computer's stored claude.ai login (docs/accounts.md): credentials in the process environment it
   * starts from are dropped (usage.ts AUTH_ENV), so only a token in `env` (a person's own) can override the login.
   */
  login?: boolean;
  /** Commit as this identity in clones of these public repos ("owner/name"), via publicIdentityEnv on the machine. */
  publicGit?: { name: string; email: string; repos: string[] };
  claudeExecutable?: string;
  /** Created before the process starts: `cwd` itself, and these files (relative to cwd) when missing. */
  init?: { files?: Record<string, string> };
}

/** The tools a spec can ask for, with their input schemas. Descriptions come with the spec. */
export const CATALOG = {
  set_label: { purpose: z.string().describe('One line on what this is being used for now.') },
  request_delegation: {
    title: z.string().describe('Short label, e.g. "Fix null ref in BeltSystem (Discord #412)".'),
    task: z.string().describe('The full brief for the worker.'),
  },
  my_delegations: {},
  wake_me: {
    minutes: z.number().int().min(1).max(1440).describe('How long until you are messaged again.'),
    note: z.string().describe('What to check or do when you wake: this comes back to you word for word.'),
  },
  unity: {
    action: z.enum(['status', 'start', 'stop', 'restart']),
    force: z.boolean().optional().describe('stop/restart: kill the editor at once instead of asking it to quit first (a frozen editor ignores that).'),
  },
  switch_branch: {
    branch: z.string().describe('The branch to switch to, e.g. "spec-098-belts".'),
    create_from: z.string().optional().describe('Base for a branch that exists neither here nor on origin. Default origin/develop.'),
  },
  /** docs/attachments.md. On a machine the daemon answers it itself: the portal gives the record, the daemon fetches the file. */
  fetch_attachment: {
    id: z.string().describe('The attachment id, e.g. "att_k2m9x0q7p3a1" (from an [attachments] list).'),
  },
} satisfies Record<string, z.ZodRawShape>;

export type CatalogTool = keyof typeof CATALOG;
export type ToolHandler = (args: Record<string, unknown>) => Promise<string>;

/** The spec's public-repo identity as git env (public-identity.gitconfig in the machine daemon's folder, FF_APP_DIR). */
function publicGitEnvFor(spec: LaunchSpec, baseEnv: NodeJS.ProcessEnv): Record<string, string> {
  if (!spec.publicGit?.repos.length) return {};
  try {
    return publicIdentityEnv(spec.publicGit, spec.publicGit.repos, path.join(baseEnv.FF_APP_DIR || path.join(os.homedir(), '.ff-factory'), 'public-identity.gitconfig'), baseEnv);
  } catch (e) {
    console.warn('public git identity:', (e as Error).message);
    return {};
  }
}

/**
 * SDK options for a spec. `handlers` answers the spec's MCP tools; `processEnv` is the environment to start from (without its
 * credentials for spec.login); `editorRunning`, for a machine sandbox, says whether its editor is up (raw branch switches are
 * refused then).
 */
export function buildOptions(spec: LaunchSpec, handlers: Partial<Record<CatalogTool, ToolHandler>>, processEnv: NodeJS.ProcessEnv = process.env, editorRunning?: () => boolean): Options {
  const baseEnv = spec.login ? usageEnv(processEnv) : processEnv;
  const g = spec.guard;
  const hooks = [
    sandboxGuard({
      sandboxId: g.id,
      sandboxPath: g.ownPath,
      protectedPaths: g.protectedPaths,
      gameRepos: g.gameRepos,
      ownCheckout: g.ownCheckout ? {} : undefined,
      denyToolPrefixes: g.denyToolPrefixes,
      publicIdentity: g.publicIdentity,
      editorRunning,
    }),
    ...(g.standing ? [standingGuard(g.standing)] : []),
  ];
  const mcpServers: NonNullable<Options['mcpServers']> = {};
  for (const [name, srv] of Object.entries(spec.stdioMcp ?? {})) mcpServers[name] = { type: 'stdio', command: srv.command, args: srv.args, ...(srv.env ? { env: srv.env } : {}) };
  if (spec.mcp) {
    mcpServers[spec.mcp.server] = createSdkMcpServer({
      name: spec.mcp.server,
      version: '1.0.0',
      // A tool this code does not know (a newer portal talking to an older daemon) is left out, not fatal.
      tools: spec.mcp.tools.filter((t) => (t.name in CATALOG ? true : (console.warn(`launch: no tool "${t.name}" in this version; left out`), false))).map((t) =>
        tool(t.name, t.description, CATALOG[t.name], async (args: Record<string, unknown>) => {
          const h = handlers[t.name];
          try {
            if (!h) throw new Error(`${t.name} is not available here`);
            return { content: [{ type: 'text' as const, text: await h(args) }] };
          } catch (e) {
            return { content: [{ type: 'text' as const, text: `ERROR: ${(e as Error).message}` }], isError: true };
          }
        }),
      ),
    });
  }
  return {
    cwd: spec.cwd,
    model: spec.model,
    effort: spec.effort,
    settingSources: spec.settingSources,
    systemPrompt: { type: 'preset', preset: 'claude_code', append: spec.append },
    ...(spec.tools ? { tools: spec.tools } : {}),
    ...(spec.disallowedTools ? { disallowedTools: spec.disallowedTools } : {}),
    strictMcpConfig: spec.strictMcp,
    mcpServers,
    ...(spec.maxBudgetUsd !== undefined ? { maxBudgetUsd: spec.maxBudgetUsd } : {}),
    hooks: { PreToolUse: [{ hooks }] },
    // Git fails fast instead of waiting on a credential prompt nobody will answer.
    env: { MCP_TIMEOUT: '120000', ...baseEnv, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', ...publicGitEnvFor(spec, baseEnv), ...spec.env },
    ...(spec.claudeExecutable ? { pathToClaudeCodeExecutable: spec.claudeExecutable } : {}),
  };
}
