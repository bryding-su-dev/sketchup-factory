import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type http from 'node:http';
import { EventEmitter } from 'node:events';
import { Identity, actingFor, claudeEnvFor, userToken } from './identity.ts';
import { Auth } from './auth.ts';
import { setAppConfig } from './appConfig.ts';
import { SessionManager, promptText, setQueryForTesting } from './sessions.ts';
import { StandingAgents, type SessionPort } from './standing.ts';
import { Store } from './store.ts';
import { buildAccounts, sessionSource, tokenKey } from './usage.ts';
import { redactSecrets } from './secrets.ts';
import { fakeQuery } from '../e2e/fakeAgent.ts';
import { resumeMessage } from './restart.ts';
import type { Config } from './config.ts';
import type { Requester, Sandbox, SessionInfo, TranscriptEvent, UserInfo } from '../shared/types.ts';

/** Per-user identity and attribution (docs/identity.md): who asked, and whose account pays. */

const BEN: UserInfo = { userId: 'ben', displayName: 'Ben', role: 'owner' };
const LOTH: UserInfo = { userId: 'lothsahn', displayName: 'Lothsahn', role: 'member' };
const r = (u: UserInfo): Requester => ({ userId: u.userId, displayName: u.displayName });
const TOKEN_BEN = 'sk-ant-oat01-' + 'B'.repeat(60) + 'bbbb';
const TOKEN_LOTH = 'sk-ant-oat01-' + 'L'.repeat(60) + 'llll';
/** A scratch folder, removed after the test; `before` (a Store's flush) runs first, so nothing writes into it after. */
const tmpDir = (t: { after: (fn: () => void | Promise<void>) => void }, prefix: string, before?: () => void | Promise<void>) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(async () => {
    await before?.();
    fs.rmSync(d, { recursive: true, force: true, maxRetries: 3 });
  });
  return d;
};

test('identity: the owner, and the system payer (config systemPayer, else the owner; a stale id falls back)', () => {
  const users = [LOTH, BEN];
  assert.deepEqual(new Identity({}, () => users).owner(), r(BEN), 'the first login with the owner role');
  assert.deepEqual(new Identity({}, () => users).systemPayer(), r(BEN));
  assert.deepEqual(new Identity({ systemPayer: 'LOTHSAHN' }, () => users).systemPayer(), r(LOTH), 'user ids match case-insensitively');
  assert.deepEqual(new Identity({ systemPayer: 'gone' }, () => users).systemPayer(), r(BEN), 'a systemPayer that names no login is the owner');
  assert.deepEqual(new Identity({ ownerName: 'Ben R' }, () => []).owner(), { userId: 'owner', displayName: 'Ben R' }, 'no logins yet');
  assert.deepEqual(new Identity({}, () => [LOTH]).owner(), r(LOTH), 'no owner role: the first login');
  assert.equal(new Identity({}, () => users).requester('nobody'), undefined);
  // A users file that cannot be read is no users, not a crash in a tool call.
  assert.deepEqual(new Identity({}, () => { throw new Error('EACCES'); }).list(), []);
});

test('acting for: the latest person by default; for_user only names someone the conversation shows asking', () => {
  const ev = (by: UserInfo, from: 'human' | 'system' = 'human'): TranscriptEvent => ({ seq: 1, t: '', kind: 'user', text: 'x', from, requestedBy: r(by) });
  assert.deepEqual(actingFor([], r(LOTH), undefined, r(BEN)), r(LOTH));
  assert.deepEqual(actingFor([], undefined, undefined, r(BEN)), r(BEN), 'nobody wrote yet: the fallback (the owner)');
  // Ben asked earlier, Lothsahn wrote last: the orchestrator can still act on Ben's request.
  assert.deepEqual(actingFor([ev(BEN)], r(LOTH), 'ben', r(BEN)), r(BEN));
  assert.deepEqual(actingFor([ev(BEN)], r(LOTH), ' Ben ', r(BEN)), r(BEN), 'trimmed, any case');
  // A [worker update] about Lothsahn's worker names him too.
  assert.deepEqual(actingFor([ev(LOTH, 'system')], r(BEN), 'lothsahn', r(BEN)), r(LOTH));
  assert.throws(() => actingFor([ev(BEN)], r(BEN), 'lothsahn', r(BEN)), /for_user "lothsahn" has not asked for anything.*it can be ben/);
  assert.throws(() => actingFor([], undefined, 'mallory', r(BEN)), /has not asked/);
});

test("local billing: an agent runs on its person's own token when they have one, else on the owner's", () => {
  const cfg = { userClaudeEnv: { Lothsahn: { CLAUDE_CODE_OAUTH_TOKEN: TOKEN_LOTH } } };
  const base = { CLAUDE_CODE_OAUTH_TOKEN: TOKEN_BEN, OTHER: '1' };
  assert.deepEqual(claudeEnvFor(cfg, r(LOTH), base), { CLAUDE_CODE_OAUTH_TOKEN: TOKEN_LOTH, OTHER: '1' });
  assert.deepEqual(claudeEnvFor(cfg, r(BEN), base), base, "no entry: the owner's account");
  assert.deepEqual(claudeEnvFor(cfg, undefined, base), base, 'nobody: the owner');
  assert.deepEqual(claudeEnvFor({}, r(LOTH), {}), {}, "a Mac on its own login stays on it when the person has no token");
  assert.deepEqual(claudeEnvFor(cfg, r(LOTH), {}), { CLAUDE_CODE_OAUTH_TOKEN: TOKEN_LOTH }, 'a Mac on its own login: the person brings theirs');
  assert.deepEqual(claudeEnvFor({ userClaudeEnv: { lothsahn: {} } }, r(LOTH), base), base, 'an empty entry changes nothing');
  assert.equal(userToken(cfg, 'lothsahn'), TOKEN_LOTH);
  assert.equal(userToken(cfg, 'ben'), undefined);
  assert.equal(userToken(cfg, undefined), undefined);
});

test('accounts: a session for a person with their own token counts on that token, shown with their name', () => {
  const cfg = { userClaudeEnv: { lothsahn: { CLAUDE_CODE_OAUTH_TOKEN: TOKEN_LOTH } } };
  const person = (id: string) => userToken(cfg, id);
  const machine = () => TOKEN_BEN;
  assert.equal(sessionSource({ requestedBy: r(LOTH) }, TOKEN_BEN, machine, person), tokenKey(TOKEN_LOTH));
  assert.equal(sessionSource({ requestedBy: r(LOTH), machineId: 'm3' }, TOKEN_BEN, machine, person), tokenKey(TOKEN_LOTH), 'on a Mac too');
  assert.equal(sessionSource({ requestedBy: r(BEN) }, TOKEN_BEN, machine, person), tokenKey(TOKEN_BEN));
  assert.equal(sessionSource({ requestedBy: r(LOTH) }, TOKEN_BEN, machine), tokenKey(TOKEN_BEN), 'without the lookup: as before');
  const accounts = buildAccounts(new Map(), {
    hostName: 'BEAST',
    token: { key: tokenKey(TOKEN_BEN), label: 'host token …bbbb' },
    people: [{ key: tokenKey(TOKEN_LOTH), label: "Lothsahn's token …llll", displayName: 'Lothsahn' }],
    machines: [],
    sessions: [
      { id: 'w1', source: tokenKey(TOKEN_LOTH), live: true },
      { id: 'w2', source: tokenKey(TOKEN_BEN) },
    ],
  });
  const loth = accounts.find((a) => a.id === tokenKey(TOKEN_LOTH))!;
  assert.equal(loth.label, "Lothsahn's token …llll");
  assert.deepEqual(loth.where, ['agents working for Lothsahn']);
  assert.deepEqual(loth.sessionIds, ['w1']);
  assert.deepEqual(accounts.find((a) => a.id === tokenKey(TOKEN_BEN))!.sessionIds, ['w2']);
  // A person whose token is the host's own is one account, not two.
  const same = buildAccounts(new Map(), { hostName: 'BEAST', token: { key: tokenKey(TOKEN_BEN), label: 'host token …bbbb' }, people: [{ key: tokenKey(TOKEN_BEN), label: "Ben's token …bbbb", displayName: 'Ben' }], machines: [], sessions: [] });
  assert.equal(same.filter((a) => a.kind === 'token').length, 1);
});

test('logins: the first is the owner, later ones members; names and roles are kept across password changes', async (t) => {
  const auth = new Auth(tmpDir(t, 'ffsb-ident-'), { trustProxy: false });
  await auth.setUser('ben', 'correct horse battery');
  await auth.setUser('lothsahn', 'another long password', { displayName: 'Lothsahn' });
  assert.deepEqual(auth.userInfos(), [
    { userId: 'ben', displayName: 'ben', role: 'owner' },
    { userId: 'lothsahn', displayName: 'Lothsahn', role: 'member' },
  ]);
  await auth.setUser('lothsahn', 'a third long password');
  assert.deepEqual(auth.userInfo('lothsahn'), { userId: 'lothsahn', displayName: 'Lothsahn', role: 'member' }, 'a new password keeps the profile');
  auth.setProfile('ben', { displayName: '  Ben   Ryding ' });
  assert.equal(auth.userInfo('ben')!.displayName, 'Ben Ryding');
  auth.setProfile('lothsahn', { role: 'owner' });
  assert.equal(auth.userInfo('lothsahn')!.role, 'owner');
  assert.throws(() => auth.setProfile('ben', { displayName: '[from Mallory]' }), /display name/, 'a name cannot fake the orchestrator prefix');
  assert.throws(() => auth.setProfile('ben', { displayName: 'x'.repeat(41) }), /display name/);
  assert.throws(() => auth.setProfile('ben', { role: 'admin' as never }), /role/);
  assert.throws(() => auth.setProfile('nobody', { role: 'member' }), /no login/);
  assert.equal(auth.userInfo(undefined), undefined);
});

test('logins: a users file from before roles reads every login as the owner', (t) => {
  const dir = tmpDir(t, 'ffsb-ident-');
  fs.writeFileSync(path.join(dir, 'users.json'), JSON.stringify([{ username: 'ben', hash: 'scrypt$x' }, { username: 'ben-phone', hash: 'scrypt$y' }]));
  const auth = new Auth(dir, { trustProxy: false });
  assert.deepEqual(auth.userInfos().map((u) => [u.userId, u.displayName, u.role]), [
    ['ben', 'ben', 'owner'],
    ['ben-phone', 'ben-phone', 'owner'],
  ]);
});

test('API keys: bound to a login, the key says whom it acts for; an unknown login is refused', async (t) => {
  const auth = new Auth(tmpDir(t, 'ffsb-ident-'), { trustProxy: false });
  await auth.setUser('ben', 'correct horse battery');
  await auth.setUser('lothsahn', 'another long password');
  const req = (key: string) => ({ headers: { authorization: `Bearer ${key}` }, socket: { remoteAddress: '10.0.0.9' } }) as unknown as http.IncomingMessage;
  const bound = auth.createApiKey('loth-laptop', 'lothsahn');
  const plain = auth.createApiKey('ben-laptop');
  assert.deepEqual(auth.bearer(req(bound)), { ok: true, name: 'loth-laptop', user: 'lothsahn' });
  assert.deepEqual(auth.bearer(req(plain)), { ok: true, name: 'ben-laptop' }, 'an unbound key: the server takes it as the owner');
  assert.throws(() => auth.createApiKey('x-key', 'mallory'), /no login "mallory"/);
});

test('set_app_config: a person\'s own Claude token is write-only, per user, and needs the user; systemPayer is a user id', (t) => {
  const dir = tmpDir(t, 'ffsb-ident-');
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ claudeEnv: { CLAUDE_CODE_OAUTH_TOKEN: TOKEN_BEN } }));
  const cfg = { claudeEnv: { CLAUDE_CODE_OAUTH_TOKEN: TOKEN_BEN } } as unknown as Config;
  const r1 = setAppConfig(file, cfg, 'userClaudeEnv.CLAUDE_CODE_OAUTH_TOKEN', TOKEN_LOTH, { user: 'lothsahn' });
  assert.deepEqual(r1, { before: 'not set', after: 'set (…llll)' }, 'never shown back');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).userClaudeEnv, { lothsahn: { CLAUDE_CODE_OAUTH_TOKEN: TOKEN_LOTH } });
  assert.equal(cfg.userClaudeEnv?.lothsahn.CLAUDE_CODE_OAUTH_TOKEN, TOKEN_LOTH, 'live');
  assert.equal(cfg.claudeEnv?.CLAUDE_CODE_OAUTH_TOKEN, TOKEN_BEN, "the owner's stays");
  assert.throws(() => setAppConfig(file, cfg, 'userClaudeEnv.CLAUDE_CODE_OAUTH_TOKEN', TOKEN_LOTH), /needs user/);
  assert.throws(() => setAppConfig(file, cfg, 'userClaudeEnv.CLAUDE_CODE_OAUTH_TOKEN', TOKEN_LOTH, { user: 'a.b' }), /needs user/, 'no dots: it is a key path');
  assert.throws(() => setAppConfig(file, cfg, 'userClaudeEnv.CLAUDE_CODE_OAUTH_TOKEN', 'hunter2', { user: 'lothsahn' }), (e: Error) => !e.message.includes('hunter2') && /OAuth token/.test(e.message));
  setAppConfig(file, cfg, 'userClaudeEnv.CLAUDE_CODE_OAUTH_TOKEN', null, { user: 'lothsahn' });
  assert.equal(cfg.userClaudeEnv?.lothsahn, undefined, 'removed, entry and all');
  assert.equal(redactSecrets(`token ${TOKEN_LOTH}`).includes(TOKEN_LOTH), false, 'and redacted wherever it shows up');

  assert.deepEqual(setAppConfig(file, cfg, 'systemPayer', 'ben'), { before: undefined, after: 'ben' });
  assert.equal(cfg.systemPayer, 'ben');
  assert.throws(() => setAppConfig(file, cfg, 'systemPayer', 'not a login!'), /user id/);
});

test("prompts: every person's message names its sender, in every kind of session; the orchestrator's names whom it is for", () => {
  assert.equal(promptText('orchestrator', 'start spec 98', 'human', r(LOTH)), '[from Lothsahn]\nstart spec 98');
  assert.equal(promptText('orchestrator', '[worker update] …', 'system', r(LOTH)), '[worker update] …', 'harness text is never dressed as a person');
  assert.equal(promptText('worker', 'fix it', 'orchestrator', r(LOTH)), '[from the orchestrator, for Lothsahn]\nfix it');
  // w389: Lothsahn typed "Undo the release hold" in a worker's chat; it arrived bare, and the worker wrote Ben's name on it.
  assert.equal(promptText('worker', 'Undo the release hold', 'human', r(LOTH)), '[from Lothsahn]\nUndo the release hold', 'a person typing to a worker: named');
  assert.equal(promptText('standing', 'run now', 'human', r(LOTH)), '[from Lothsahn]\nrun now');
  // Nobody known: said so, never left bare (a bare message reads as the portal owner's).
  assert.equal(promptText('worker', 'fix it', 'orchestrator'), '[from the orchestrator, for no named person]\nfix it');
  assert.equal(promptText('worker', 'fix it', 'human'), '[from a person the portal did not name]\nfix it');
  assert.equal(promptText('orchestrator', 'start spec 98', 'human'), '[from a person the portal did not name]\nstart spec 98');
});

test('w389: a worker reads who sent each message, typed in its chat, from an orchestrator, queued behind busy slots, or listed after a restart', async (t) => {
  setQueryForTesting(fakeQuery({ stepMs: 1 }) as never);
  const dir = tmpDir(t, 'ffsb-ident-', async () => {
    sessions.stopAll();
    await new Promise((res) => setTimeout(res, 50));
    store.flush();
  });
  const store = new Store(dir);
  const sessions = new SessionManager({ limits: { maxSessions: 1 } } as Config, store);
  const make = () => sessions.create({ kind: 'worker', title: 'w', permissionMode: 'bypassPermissions', options: () => ({}), requestedBy: r(BEN) });
  const said = (id: string) => store.readTranscript(id).filter((e) => e.kind === 'assistant').map((e) => (e as { text?: string }).text ?? JSON.stringify(e)).join('\n');
  const until = async (what: string, ok: () => boolean) => {
    for (const end = Date.now() + 15_000; !ok(); ) {
      if (Date.now() > end) throw new Error(`timed out: ${what}`);
      await new Promise((res) => setTimeout(res, 20));
    }
  };
  const w = make();
  // Typed by Lothsahn in the worker's chat (POST /api/sessions/:id/message: 'human', requestedBy the login).
  sessions.send(w.info.id, 'Undo the release hold #whoami', 'human', undefined, { requestedBy: r(LOTH) });
  await until('answered', () => /Sender: \[from Lothsahn\]/.test(said(w.info.id)));
  sessions.send(w.info.id, 'status? #whoami', 'orchestrator', undefined, { requestedBy: r(LOTH) });
  await until('answered', () => /Sender: \[from the orchestrator, for Lothsahn\]/.test(said(w.info.id)));
  // Queued while the only slot is busy (w384's send queue), then delivered: the sender rides along.
  const busy = make();
  sessions.send(busy.info.id, '#slow busy', 'human', undefined, { requestedBy: r(BEN) });
  const uuid = sessions.send(w.info.id, 'hold it #whoami', 'human', undefined, { requestedBy: r(LOTH) });
  assert.equal(sessions.isQueued(uuid), true, 'queued');
  await until('delivered later', () => (said(w.info.id).match(/Sender: \[from Lothsahn\]/g) ?? []).length === 2);
  // After a restart, the unanswered list names whose each message was.
  assert.match(resumeMessage({ id: 'a', kind: 'worker', title: 'a', why: 'mid-turn', unanswered: [{ text: 'Undo the release hold', from: 'human', requestedBy: r(LOTH) }], lastFrom: 'human' }, { reason: 'restart', at: '2026-10-04T18:00:00Z' }), /^- \(from Lothsahn\) Undo the release hold$/m);
});

test('sessions: each message records its person; a person (not the harness) sets whom the session last worked for', async (t) => {
  setQueryForTesting(fakeQuery({ stepMs: 1 }) as never);
  const dir = tmpDir(t, 'ffsb-ident-', async () => {
    sessions.stopAll();
    await new Promise((res) => setTimeout(res, 50));
    store.flush();
  });
  const store = new Store(dir);
  const sessions = new SessionManager({ limits: { maxSessions: 6 } } as Config, store);
  const w = sessions.create({ kind: 'worker', title: 'w', permissionMode: 'bypassPermissions', options: () => ({}), requestedBy: r(LOTH) });
  assert.deepEqual(w.info.requestedBy, r(LOTH), 'created for Lothsahn');
  sessions.send(w.info.id, 'hello', 'human', undefined, { requestedBy: r(BEN) });
  sessions.send(w.info.id, '[worker update] something', 'system', undefined, { requestedBy: r(LOTH) });
  const users = store.readTranscript(w.info.id).filter((e) => e.kind === 'user');
  assert.deepEqual(
    users.map((e) => e.kind === 'user' && [e.from, e.requestedBy?.userId]),
    [
      ['human', 'ben'],
      ['system', 'lothsahn'],
    ],
  );
  assert.deepEqual(w.info.lastRequestedBy, r(BEN), 'the harness message did not change it');
  assert.deepEqual(w.info.requestedBy, r(LOTH), 'who it works for stays who started it');
});

// ---------------------------------------------------------------- standing agents and delegations

class Port implements SessionPort {
  readonly events = new EventEmitter();
  readonly all = new Map<string, { info: SessionInfo; live: boolean; stop(): void; sent: { text: string; by?: Requester }[] }>();
  private n = 0;
  create(opts: Parameters<SessionPort['create']>[0]) {
    const info = { id: `s${++this.n}`, kind: opts.kind, standingId: opts.standingId, title: opts.title, status: 'stopped', permissionMode: opts.permissionMode, createdAt: '', lastActivityAt: '', turns: 0, costUsd: 0, pendingPermissions: [] } as SessionInfo;
    const s = { info, live: false, sent: [] as { text: string; by?: Requester }[], stop() { s.live = false; } };
    this.all.set(info.id, s);
    return s;
  }
  get(id: string) {
    return this.all.get(id)!;
  }
  send(id: string, text: string, _from: string, _i?: undefined, opts?: { requestedBy?: Requester }) {
    const s = this.get(id);
    s.live = true;
    s.sent.push({ text, by: opts?.requestedBy });
    return 'u';
  }
  liveAgents() {
    return 0;
  }
  remove(id: string) {
    this.all.delete(id);
  }
}

function standing(t: { after: (fn: () => void | Promise<void>) => void }) {
  let store: Store | undefined;
  const tmp = tmpDir(t, 'ffsb-ident-st-', () => store?.flush());
  const cfg = {
    dataDir: path.join(tmp, 'data'),
    sandboxRoot: path.join(tmp, 'sb'),
    standingRoot: path.join(tmp, 'sb', '_agents'),
    protectedPaths: [],
    repo: { url: 'x', basePath: path.join(tmp, 'sb', '_base') },
    limits: { maxSessions: 6 },
    models: ['opus'],
    defaultModel: 'opus',
    worker: { permissionMode: 'bypassPermissions', effort: 'high' },
    userClaudeEnv: { lothsahn: { CLAUDE_CODE_OAUTH_TOKEN: TOKEN_LOTH } },
  } as unknown as Config;
  store = new Store(cfg.dataDir);
  const port = new Port();
  const started: { requestedBy?: Requester }[] = [];
  const notes: { text: string; by?: Requester }[] = [];
  const sandboxes: Sandbox[] = [{ id: 'sb1', purpose: 'unused', status: 'ready', sessionIds: [] } as unknown as Sandbox];
  const clock = { now: new Date('2026-09-27T10:00:00') };
  const st = new StandingAgents({
    cfg,
    store,
    sessions: port,
    systemPayer: () => r(BEN),
    notify: (text, by) => notes.push({ text, by }),
    sandboxes: { list: () => sandboxes, setPurpose: (_id, p) => Object.assign(sandboxes[0], { purpose: p }) },
    startWorker: (req) => {
      started.push({ requestedBy: req.requestedBy });
      return { info: { id: `w${started.length}`, status: 'running' } as SessionInfo };
    },
    now: () => clock.now,
  });
  return { st, port, started, notes, sandboxes, clock };
}

test('standing runs: a run by hand is its person\'s (on their token), a scheduled one the system payer\'s', (t) => {
  const { st, port, clock } = standing(t);
  const a = st.create({ name: 'Triager', charter: 'Triage.', trigger: { kind: 'interval', minutes: 30 }, tools: ['delegate'] });
  st.runNow(a.id, 'message', 'look at #640', r(LOTH));
  const s = port.get(a.sessionId);
  const run = st.require(a.id).runs.at(-1)!;
  assert.deepEqual(run.requestedBy, r(LOTH));
  assert.deepEqual(s.info.requestedBy, r(LOTH), 'the session works for the run\'s person');
  assert.deepEqual(s.sent[0].by, r(LOTH));
  assert.match(s.sent[0].text, /started by a message from Lothsahn/);
  assert.match(s.sent[0].text, /Lothsahn says:\nlook at #640/, 'no longer hard-wired to one name');
  assert.equal(st.options(s.info).env?.CLAUDE_CODE_OAUTH_TOKEN, TOKEN_LOTH, "the run's process runs on Lothsahn's token");

  // A delegation filed in that run is for Lothsahn; Ben approves it, so its worker is Ben's.
  const d = st.requestDelegation(a.id, 'Fix #640', 'Fix the belt.');
  assert.deepEqual(d.requestedBy, r(LOTH));
  assert.equal(d.status, 'pending');
  st.approveDelegation(d.id, { approvedBy: r(BEN) });
  assert.deepEqual(st.require(a.id) && d.approvedBy, r(BEN));
  assert.match(d.log!.join('\n'), /approved by Ben: worker w1/);

  // The run ends; the next scheduled one is the system payer's.
  s.live = false;
  port.events.emit('ended', s);
  clock.now = new Date(clock.now.getTime() + 31 * 60_000);
  st.tick();
  const next = st.require(a.id).runs.at(-1)!;
  assert.equal(next.trigger, 'schedule');
  assert.deepEqual(next.requestedBy, r(BEN));
  assert.equal(st.options(s.info).env?.CLAUDE_CODE_OAUTH_TOKEN, undefined, "Ben has no own token: the host's (none in this test)");
});

test('delegations: an auto-approved worker is requested by whoever the filing run was for', (t) => {
  const { st, started, notes } = standing(t);
  const a = st.create({ name: 'Sentry', charter: 'Watch.', trigger: { kind: 'manual' }, tools: ['delegate'], autoApprove: { enabled: true, exclude: [] } });
  st.runNow(a.id, 'manual', undefined, r(LOTH));
  const d = st.requestDelegation(a.id, 'Verify', 'Check it.');
  assert.equal(d.autoApproved, true);
  assert.equal(d.approvedBy, undefined, 'nobody approved it');
  assert.deepEqual(started.at(-1)!.requestedBy, r(LOTH));
  assert.deepEqual(notes.at(-1)!.by, r(LOTH), 'the orchestrator hears whom it is for');
  assert.match(st.require(a.id).runs.at(-1)!.requestedBy!.displayName, /Lothsahn/);
});
