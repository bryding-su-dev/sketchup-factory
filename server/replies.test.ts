import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from './store.ts';
import { SessionManager, setQueryForTesting } from './sessions.ts';
import { MachineManager } from './machines.ts';
import { SandboxManager } from './sandboxes.ts';
import { Agents } from './agents.ts';
import { Identity } from './identity.ts';
import { EXCERPT_CHARS, REACTION_PALETTE, REPLY_MARK, excerptOf, isEmoji, parseReaction, reactionRemovedText, reactionText, reactionsByMessage, replyText, splitReply, type Quoted } from '../shared/replies.ts';
import { fakeQuery } from '../e2e/fakeAgent.ts';
import type { Config } from './config.ts';
import type { Requester, SessionInfo, UserInfo, WorkItem } from '../shared/types.ts';

/** w866: replying to a message and reacting to it in a person's orchestrator chat (shared/replies.ts, Orchestrators.quoteOf/react). */

/** What the orchestrator's model was handed, message by message: the text the SDK's input stream carried. */
const input: string[] = [];
const fake = fakeQuery({ stepMs: 1 });
setQueryForTesting(((args: { prompt: AsyncIterable<{ message: { content: unknown } }>; options: never }) => {
  const prompt = (async function* () {
    for await (const m of args.prompt) {
      const c = m.message.content;
      input.push(typeof c === 'string' ? c : (c as { type: string; text?: string }[]).map((b) => b.text ?? '').join(' '));
      yield m;
    }
  })();
  return fake({ ...args, prompt } as never);
}) as never);

const BEN: Requester = { userId: 'ben', displayName: 'Ben' };
const LOTH: Requester = { userId: 'lothsahn', displayName: 'Lothsahn' };
const PEOPLE: UserInfo[] = [
  { ...BEN, role: 'owner' },
  { ...LOTH, role: 'member' },
];
const T0 = new Date().toISOString();

async function until(what: string, cond: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

function setup(t: { after: (fn: () => void | Promise<void>) => void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-replies-'));
  const cfg = {
    dataDir: dir,
    sandboxRoot: dir,
    standingRoot: path.join(dir, '_agents'),
    repo: { url: path.join(dir, 'base'), basePath: path.join(dir, 'base') },
    defaultBase: 'develop',
    models: ['opus', 'sonnet'],
    defaultModel: 'opus',
    protectedPaths: [],
    limits: { maxSessions: 30, maxUnity: 2, maxSandboxes: 4, minFreeGB: 0, minFreeRamGB: 0 },
    orchestrator: { model: 'opus', effort: 'low', notifyOnWorkerEvents: true },
    worker: { permissionMode: 'bypassPermissions', effort: 'low' },
    unity: {},
    intake: {},
  } as unknown as Config;
  const store = new Store(dir);
  const sessions = new SessionManager(cfg, store);
  const sandboxes = new SandboxManager(cfg, store);
  const machines = new MachineManager(cfg, store, sessions);
  const agents = new Agents(cfg, store, sandboxes, sessions, machines, new Identity(cfg, () => PEOPLE));
  agents.boot();
  const o = agents.orchestrators;
  t.after(async () => {
    o.close();
    sessions.stopAll();
    await new Promise((r) => setTimeout(r, 60));
    store.flush();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  const call = async (info: SessionInfo, name: string, args: Record<string, unknown>) => {
    const tool = agents.orchestratorBelt(info).find((x) => x.name === name);
    if (!tool) throw new Error(`${info.title} has no ${name}`);
    const r = await tool.handler(args);
    return { text: r.content.map((c) => c.text).join('\n'), isError: !!r.isError };
  };
  return { store, o, agents, sessions, call };
}

const quoted = (over: Partial<Quoted> = {}): Quoted => ({ seq: 42, from: 'the orchestrator', at: '2026-10-10T08:31:09.000Z', excerpt: 'Shall I start w900 on slot2?', ...over });

// ---------------------------------------------------------------- the text

test('w866: a reply is the words, FF Factory\'s mark, then the quoted message; the page and the gates read it back', () => {
  const text = replyText('yes, slot2', quoted({ excerpt: 'Shall I start w900?\nIt needs\n\nan editor.' }));
  assert.equal(text, `yes, slot2\n\n${REPLY_MARK}\n#42 · the orchestrator · 2026-10-10 08:31 UTC\n> Shall I start w900?\n> It needs\n> \n> an editor.`);
  const back = splitReply(text);
  assert.equal(back.words, 'yes, slot2');
  assert.deepEqual(back.quote, { seq: 42, from: 'the orchestrator', at: '2026-10-10T08:31:00.000Z', excerpt: 'Shall I start w900?\nIt needs\n\nan editor.' });
  // No words (an image alone): the quote stands alone; no quote: the text is its own words.
  assert.equal(splitReply(replyText('', quoted())).words, '');
  assert.deepEqual(splitReply('just words'), { words: 'just words' });
  // A note the harness adds after the reply ends the quote and stays with the words' side of the message.
  const held = `${text}\n\n[held]\nCalls a gate refused…`;
  const both = splitReply(held, '[held]');
  assert.equal(both.quote?.excerpt, 'Shall I start w900?\nIt needs\n\nan editor.');
  assert.match(both.words, /^yes, slot2\n\n\[held\]/);
});

test('w866: the excerpt is the message\'s own words, clipped, with no earlier quote or FF Factory note inside it', () => {
  assert.equal(excerptOf('  hello  '), 'hello');
  assert.equal(excerptOf(replyText('my words', quoted({ excerpt: 'older' }))), 'my words');
  assert.equal(excerptOf('my words\n\n[held]\nheld stuff', '[held]'), 'my words');
  const long = excerptOf('x'.repeat(EXCERPT_CHARS + 50));
  assert.equal(long, `${'x'.repeat(EXCERPT_CHARS)}… (50 more characters)`);
});

test('w866: an emoji is one emoji: a pictograph with its modifiers, a flag, a keycap; not text, not two', () => {
  for (const e of REACTION_PALETTE) assert.equal(isEmoji(e), true, e);
  for (const e of ['❤️', '👍🏽', '🇸🇪', '1️⃣', '👨‍👩‍👧', '🫡']) assert.equal(isEmoji(e), true, e);
  for (const e of ['', 'a', '1', '👍👍', '👍 ', 'ok 👍', '<b>', '\n']) assert.equal(isEmoji(e), false, JSON.stringify(e));
});

test('w866: reactions replay in order: on, off, on again; one per emoji and message', () => {
  const on = (emoji: string, seq: number) => ({ text: reactionText('Ben', emoji, quoted({ seq })) });
  const off = (emoji: string, seq: number) => ({ text: reactionRemovedText(emoji, seq) });
  assert.deepEqual(parseReaction(on('👍', 42).text), { to: 42, emoji: '👍', on: true });
  assert.deepEqual(parseReaction(off('👍', 42).text), { to: 42, emoji: '👍', on: false });
  assert.equal(parseReaction('[worker update] agent "x" finished'), undefined);
  assert.equal(parseReaction('[reaction] it was nice'), undefined);
  const m = reactionsByMessage([on('👍', 42), on('🎉', 42), on('👍', 42), on('❓', 7), off('🎉', 42), { text: 'unrelated' }, off('❓', 7), off('👀', 9)]);
  assert.deepEqual([...m], [[42, ['👍']]]);
});

// ---------------------------------------------------------------- the orchestrator's input

/** A personal orchestrator for Lothsahn with a chat to reply to: [its answer, a relayed worker update, his own message]. */
function chat(t: Parameters<typeof setup>[0]) {
  const env = setup(t);
  const loth = env.o.personalFor(LOTH);
  const { store } = env;
  const id = loth.info.id;
  const answer = store.append(id, { kind: 'assistant', text: 'Shall I start w900 on slot2?\nIt needs an editor.' });
  const update = store.append(id, { kind: 'user', from: 'system', uuid: 'wu1', text: '[worker update] agent "w900: fix the belts" (session s-1) finished a turn. Its final message:\n\nDone: PR #12 is up.', requestedBy: LOTH });
  const mine = store.append(id, { kind: 'user', from: 'human', uuid: 'h1', text: 'Close w811 as a duplicate once 1314 is merged', requestedBy: LOTH });
  const tool = store.append(id, { kind: 'tool_use', toolUseId: 'tu1', name: 'list_work', input: {} });
  return { ...env, loth, id, answer, update, mine, tool };
}

const sentAfter = (n: number) => input.slice(n);

test('w866 reply: the orchestrator\'s input carries the message replied to, quoted after the person\'s words, for the orchestrator\'s answer, a relayed worker update and their own message', async (t) => {
  const { agents, o, id, answer, update, mine, sessions } = chat(t);
  for (const [target, from, excerpt] of [
    [answer, 'the orchestrator', 'Shall I start w900 on slot2?\n> It needs an editor.'],
    [update, 'a [worker update] line', 'finished a turn. Its final message:\n> \n> Done: PR #12 is up.'],
    [mine, 'Lothsahn', 'Close w811 as a duplicate once 1314 is merged'],
  ] as const) {
    const before = input.length;
    await agents.sendWithAttachments(id, o.replyWords(id, 'yes, slot2', target.seq), 'human', { requestedBy: LOTH });
    await until('the orchestrator was handed the reply', () => sentAfter(before).length === 1);
    const seen = sentAfter(before)[0];
    assert.match(seen, new RegExp(`^\\[from Lothsahn\\]\\nyes, slot2\\n\\n${REPLY_MARK.replace(/[[\]]/g, '\\$&')}\\n#${target.seq} · ${from.replace(/[[\]]/g, '\\$&')} · \\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d UTC\\n> `), seen);
    assert.ok(seen.includes(excerpt) || seen.includes(excerpt.replace(/\n> /g, '\n> ')), `${seen}\n--- should hold ---\n${excerpt}`);
    await until('the turn ends', () => sessions.get(id).info.status === 'idle');
  }
});

test('w866 reply: only a message of this chat can be replied to (not a tool call, not one that is not there); the dispatcher and workers have no replies', async (t) => {
  const { o, id, tool, sessions } = chat(t);
  assert.throws(() => o.replyWords(id, 'x', tool.seq), /is not a message of this chat/);
  assert.throws(() => o.replyWords(id, 'x', 9999), /is not a message of this chat/);
  assert.throws(() => o.replyWords(id, 'x', -1), /the number of a message/);
  assert.equal(o.replyWords(id, 'plain', undefined), 'plain');
  const worker = sessions.create({ kind: 'worker', title: 'w', permissionMode: 'bypassPermissions', options: () => ({ model: 'opus' }) });
  assert.throws(() => o.replyWords(worker.info.id, 'x', 1), /person's own orchestrator chat/);
  const dispatcher = sessions.get(o.dispatcherId!);
  assert.throws(() => o.quoteOf(dispatcher.info.id, 1), /person's own orchestrator chat/);
});

test('w866 reply: a reply is the person\'s turn, and their words are only what they typed before the quote', async (t) => {
  const { agents, o, id, store, loth, sessions } = chat(t);
  const said = store.append(id, { kind: 'assistant', text: 'Do you want me to cancel w811?' });
  const before = input.length;
  await agents.sendWithAttachments(id, o.replyWords(id, 'yes please', said.seq), 'human', { requestedBy: LOTH });
  await until('handed', () => sentAfter(before).length === 1);
  await until('the turn ends', () => sessions.get(id).info.status === 'idle');
  assert.equal(loth.turnFrom, 'human', 'a reply is typed by the person');
  const back = splitReply(sentAfter(before)[0].replace(/^\[from Lothsahn\]\n/, ''));
  assert.equal(back.words, 'yes please');
  assert.match(back.quote!.excerpt, /cancel w811/);
});

test('w866 reaction: the orchestrator\'s input carries the emoji and the message it is on; it is a harness message, no turn of the person\'s, so nothing that needs their words passes on it', async (t) => {
  const { o, id, store, call, loth, answer, update, sessions } = chat(t);
  const w = { id: 'w811', title: 'Dup', brief: 'x', priority: 'normal', keys: [], requestedBy: LOTH, requesters: [LOTH], humanAsked: true, status: 'new', createdAt: T0, updatedAt: T0, sessionIds: [], overlaps: [], asks: 0, log: [] } as unknown as WorkItem;
  store.putWork(w);
  store.workSeq = 811;
  const before = input.length;
  assert.equal(o.react(id, answer.seq, '👍', true, LOTH), true);
  await until('handed', () => sentAfter(before).length === 1);
  const seen = sentAfter(before)[0];
  assert.match(seen, new RegExp(`^\\[reaction\\] Lothsahn reacted 👍 to a message in this chat:\\n#${answer.seq} · the orchestrator · \\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d UTC\\n> Shall I start w900 on slot2\\?\\n> It needs an editor\\.\\n\\n`), seen);
  assert.match(seen, /👍 or ✅ = yes, go ahead/);
  assert.match(seen, /It is a click, not Lothsahn's own words, so what needs their own words \(approving or declining a request, deleting, settings, deploys, a release\) still needs them to say it/);
  assert.ok(!seen.startsWith('[from'), 'a harness message, not dressed as a person');
  await until('the turn ends', () => sessions.get(id).info.status === 'idle');
  // Its turn is the harness's: the gates that need the person's own turn refuse, as they do for a timer.
  assert.equal(loth.turnFrom, 'system');
  // The person's budgets do not start again for a click (personWrote), and a click on a relayed line works the same.
  const before2 = input.length;
  o.react(id, update.seq, '❓', true, LOTH);
  await until('handed', () => sentAfter(before2).length === 1);
  assert.match(sentAfter(before2)[0], /reacted ❓ to a message in this chat:\n#\d+ · a \[worker update\] line · .*\n> \[worker update\] agent "w900: fix the belts"/);
});

test('w866 reaction: one per emoji and message; taking it back is recorded and not sent; bad targets and bad emoji are refused', async (t) => {
  const { o, id, store, answer, tool, sessions } = chat(t);
  await (async () => {
    const before = input.length;
    assert.equal(o.react(id, answer.seq, '👍', true, LOTH), true);
    assert.equal(o.react(id, answer.seq, '👍', true, LOTH), false, 'already there: nothing sent twice');
    await until('handed', () => sentAfter(before).length === 1);
    await until('the turn ends', () => sessions.get(id).info.status === 'idle');
    assert.equal(sentAfter(before).length, 1);
  })();
  const n = input.length;
  assert.equal(o.react(id, answer.seq, '👍', false, LOTH), true);
  assert.equal(o.react(id, answer.seq, '👍', false, LOTH), false, 'not there any more');
  assert.equal(o.react(id, answer.seq, '🎉', false, LOTH), false, 'never was');
  assert.equal(input.length, n, 'taking one back tells the orchestrator nothing');
  const marks = reactionsByMessage(store.readTranscript(id).flatMap((e) => (e.kind === 'user' || e.kind === 'system' ? [e] : [])));
  assert.equal(marks.size, 0, 'the chat shows none');
  assert.ok(store.readTranscript(id).some((e) => e.kind === 'system' && e.text === reactionRemovedText('👍', answer.seq)));
  assert.throws(() => o.react(id, answer.seq, 'thumbs up', true, LOTH), /one emoji/);
  assert.throws(() => o.react(id, answer.seq, '👍👍', true, LOTH), /one emoji/);
  assert.throws(() => o.react(id, tool.seq, '👍', true, LOTH), /is not a message of this chat/);
});
