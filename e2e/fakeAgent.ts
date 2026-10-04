/**
 * A scripted stand-in for the Agent SDK's query(), for the E2E server and unit tests: no Claude, no
 * CLI process. It reads the same streaming input AgentSession writes and answers each user message
 * with the SDK messages a real session would send (init, state changes, text deltas, assistant
 * blocks, tool calls, a result), chosen by a tag in the message:
 *
 *   "#perm"        asks canUseTool for a Bash call, then reports whether it was allowed
 *   "#long"        a reply of 60 paragraphs (for scrolling and jump-to-latest)
 *   "#screenshot"  a tool result carrying a PNG (an inline image)
 *   "#slow"        streams for a few seconds (for the running state and interrupts)
 *   "#fail"        ends the turn with an error result
 *   "#die"         the agent process ends mid-turn (as when the server's process tree is stopped)
 *   "#bg"          starts a background task (a background command, a watcher) and ends the turn
 *   "#whoami"      says the sender line the message came with: "Sender: [from …]", or "Sender: none" (w389)
 *   "#tool <name> <json>"  (one per line) calls that tool of the session's in-process MCP server (an orchestrator's
 *                  belt) with those arguments, and says what it answered: "Called <name>: <answer>". Only in a
 *                  person's own message (the "[from <name>]" line), so a notice quoting the tag never sets it off.
 *   anything else  "Echo: <text>" (and how many images came with it)
 */
import type { McpServerConfig, Options, PermissionResult, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

/** A 16x16 red PNG. */
export const RED_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR4nGO4o6FBEmIY1TCqYfhqAAAyBCwQhvh37QAAAABJRU5ErkJggg==';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let counter = 0;

export interface FakeOptions {
  /** Pause between streamed pieces, ms (default 40). */
  stepMs?: number;
}

export function fakeQuery(fake: FakeOptions = {}) {
  const step = fake.stepMs ?? 40;
  return ({ prompt, options }: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }): Query => {
    const sessionId = options?.resume ?? `fake-${process.pid}-${++counter}`;
    const abort = options?.abortController ?? new AbortController();
    let interrupted = false;
    let msgId = 0;

    const text = (t: string): SDKMessage =>
      ({ type: 'assistant', parent_tool_use_id: null, uuid: `a${++msgId}`, session_id: sessionId, message: { id: `m${msgId}`, role: 'assistant', content: [{ type: 'text', text: t }] } }) as never;
    const delta = (t: string): SDKMessage =>
      ({ type: 'stream_event', parent_tool_use_id: null, uuid: `d${++msgId}`, session_id: sessionId, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } } }) as never;
    const state = (s: 'running' | 'idle' | 'requires_action'): SDKMessage => ({ type: 'system', subtype: 'session_state_changed', state: s, session_id: sessionId, uuid: `s${++msgId}` }) as never;
    const toolUse = (id: string, name: string, input: unknown): SDKMessage =>
      ({ type: 'assistant', parent_tool_use_id: null, uuid: `t${++msgId}`, session_id: sessionId, message: { id: `m${msgId}`, role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } }) as never;
    const toolResult = (id: string, content: unknown, isError = false): SDKMessage =>
      ({ type: 'user', parent_tool_use_id: null, uuid: `r${++msgId}`, session_id: sessionId, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] } }) as never;
    const result = (uuid: string, ok: boolean, t: string): SDKMessage =>
      ({
        type: 'result',
        subtype: ok ? 'success' : 'error_during_execution',
        is_error: !ok,
        result: t,
        total_cost_usd: 0.01 * msgId,
        num_turns: 1,
        duration_ms: 1234,
        user_message_uuids: [uuid],
        session_id: sessionId,
        uuid: `x${++msgId}`,
      }) as never;

    // The session's in-process MCP servers (createSdkMcpServer), reached through an in-memory MCP client, once.
    const clients = new Map<string, Promise<Client>>();
    const client = (name: string, server: McpServerConfig & { instance: { connect(t: unknown): Promise<void> } }) => {
      let c = clients.get(name);
      if (!c) {
        c = (async () => {
          const [mine, theirs] = InMemoryTransport.createLinkedPair();
          await server.instance.connect(theirs);
          const cl = new Client({ name: 'fake-agent', version: '1.0.0' });
          await cl.connect(mine);
          return cl;
        })();
        clients.set(name, c);
      }
      return c;
    };
    async function callTool(name: string, args: Record<string, unknown>): Promise<{ server: string; text: string; isError: boolean }> {
      for (const [serverName, cfg] of Object.entries(options?.mcpServers ?? {})) {
        if (cfg.type !== 'sdk' || !('instance' in cfg)) continue;
        const c = await client(serverName, cfg as never);
        const { tools } = await c.listTools();
        if (!tools.some((t) => t.name === name)) continue;
        const r = (await c.callTool({ name, arguments: args })) as { content?: { type: string; text?: string }[]; isError?: boolean };
        return { server: serverName, text: (r.content ?? []).map((b) => b.text ?? '').join('\n'), isError: !!r.isError };
      }
      return { server: 'none', text: `no tool "${name}" in this session`, isError: true };
    }

    async function* stream(): AsyncGenerator<SDKMessage, void> {
      yield { type: 'system', subtype: 'init', session_id: sessionId, model: options?.model ?? 'fake-model', uuid: 'init' } as never;
      if (typeof prompt === 'string') return;
      for await (const m of prompt) {
        if (abort.signal.aborted) return;
        const content = m.message.content;
        const said = (typeof content === 'string' ? content : content.map((b) => (b.type === 'text' ? b.text : '')).join(' ')).trimStart();
        const images = typeof content === 'string' ? 0 : content.filter((b) => b.type === 'image').length;
        const uuid = m.uuid ?? '';
        yield state('running');
        // The harness's "[from the orchestrator]" / "[from <person>]" line (server/sessions.ts, promptText) is not the message.
        const words = said.replace(/^\[from [^\]\n]*\]\n/, '');
        const byPerson = /^\[from (?!the orchestrator)[^\]\n]*\]\n/.test(said);
        const calls = byPerson ? [...words.matchAll(/^#tool\s+([\w-]+)\s+(\{.*\})\s*$/gm)] : [];
        if (calls.length) {
          const answers: string[] = [];
          for (const [, name, json] of calls) {
            const toolId = `tool-${++msgId}`;
            let args: Record<string, unknown> = {};
            try {
              args = JSON.parse(json);
            } catch {
              answers.push(`${name}: bad JSON`);
              continue;
            }
            const r = await callTool(name, args);
            yield toolUse(toolId, `mcp__${r.server}__${name}`, args);
            yield toolResult(toolId, r.text, r.isError);
            answers.push(`Called ${name}: ${r.text}`);
          }
          yield text(answers.join('\n\n'));
          yield result(uuid, true, answers.join('\n\n'));
        } else if (/#perm\b/i.test(words)) {
          const toolId = `tool-${++msgId}`;
          const input = { command: 'rm -rf build', description: 'Clean the build folder' };
          yield toolUse(toolId, 'Bash', input);
          yield state('requires_action');
          const decision: PermissionResult = (options?.canUseTool
            ? await options.canUseTool('Bash', input, { signal: abort.signal, toolUseID: toolId } as never)
            : { behavior: 'allow', updatedInput: input }) ?? { behavior: 'deny', message: 'no answer' };
          yield state('running');
          if (decision.behavior === 'allow') {
            yield toolResult(toolId, 'removed build/');
            yield text('Allowed: I cleaned the build folder.');
          } else {
            yield toolResult(toolId, `Permission denied: ${decision.message}`, true);
            yield text('Denied: I left the build folder alone.');
          }
          yield result(uuid, true, decision.behavior === 'allow' ? 'allowed' : 'denied');
        } else if (/#long\b/i.test(words)) {
          for (let i = 1; i <= 60; i++) yield text(`Paragraph ${i} of a long answer. ${'Lorem ipsum dolor sit amet. '.repeat(3)}`);
          yield text('The end of the long answer.');
          yield result(uuid, true, 'long answer done');
        } else if (/#screenshot\b/i.test(words)) {
          const toolId = `tool-${++msgId}`;
          yield toolUse(toolId, 'Read', { file_path: 'Screenshots/proof.png' });
          yield toolResult(toolId, [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: RED_PNG } }]);
          yield text('Here is the screenshot.');
          yield result(uuid, true, 'screenshot shown');
        } else if (/#die\b/i.test(words)) {
          yield text('Working on it...');
          throw new Error('Claude Code process exited with code 1');
        } else if (/#whoami\b/i.test(words)) {
          const line = /^\[from [^\]\n]*\]/.exec(said)?.[0] ?? 'none';
          yield text(`Sender: ${line}`);
          yield result(uuid, true, `Sender: ${line}`);
        } else if (/#bg\b/i.test(words)) {
          yield { type: 'system', subtype: 'background_tasks_changed', tasks: [{ id: `bg-${++msgId}`, ambient: false }], session_id: sessionId, uuid: `b${msgId}` } as never;
          yield text('Started the build in the background; it will wake me.');
          yield result(uuid, true, 'waiting on the background build');
        } else if (/#fail\b/i.test(words)) {
          yield text('Something went wrong.');
          yield result(uuid, false, 'failed');
        } else {
          const reply = `Echo: ${words.trim()}${images ? ` (${images} image${images > 1 ? 's' : ''})` : ''}`;
          const pieces = /#slow\b/i.test(words) ? 40 : 3;
          const size = Math.ceil(reply.length / pieces);
          for (let i = 0; i < reply.length && !interrupted; i += size) {
            yield delta(reply.slice(i, i + size));
            await sleep(/#slow\b/i.test(words) ? 100 : step);
          }
          if (interrupted) {
            // The interrupt ends this turn (an interrupt that came before it started ends it too).
            interrupted = false;
            continue;
          }
          yield text(reply);
          yield result(uuid, true, reply);
        }
        interrupted = false;
        yield state('idle');
      }
    }

    const gen = stream();
    const q = Object.assign(gen, {
      async interrupt() {
        interrupted = true;
      },
      async setPermissionMode() {},
      async setModel() {},
      close() {
        abort.abort();
      },
    });
    return q as unknown as Query;
  };
}
