import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_CLEANUP, DEFAULT_USAGE_POLL_MINUTES, ROOT, VOICE_DEFAULTS, type ClaudeAccount, type Config, type HostRole } from './config.ts';
import { OAUTH_TOKEN, SECRET_KEYS, hostLoginProblem, maskSecret } from './secrets.ts';
import { PROVIDER_TOKEN, tokenSha256 } from './providerProtocol.ts';
import { USER_ID } from './identity.ts';
import { writeFileDurable } from './durable.ts';
import { AUTO_COMPACT_LIMITS } from './autoCompact.ts';

/**
 * The config.json keys an agent may change (the set_app_config tool). Only cosmetic ones, plus the public
 * commit identity (which names the identity to use; noreply addresses are always accepted): nothing that
 * touches paths, permissions, models or the network (the capacity limits below are bounded). Each applies to the running server at once
 * (the config object is shared; guards read it when a session starts) and is written to config.json.
 */
export const SETTABLE_KEYS = [
  'ownerName',
  'voice.vocabulary',
  'voice.ttsVoice',
  'publicGitIdentity.name',
  'publicGitIdentity.email',
  // The host guard's housekeeping (docs/self-recovery.md), so it can be tuned without anyone at the desk.
  'hostGuard.devDriveVhdx',
  'hostGuard.cleanup.ageRules',
  // The continuous clean-up's pace and soft threshold, on this host and on the machines (optional `machine`).
  'hostGuard.cleanup.everyMinutes',
  'hostGuard.cleanup.softFreeGB',
  'machines.cleanup.everyMinutes',
  'machines.cleanup.softFreeGB',
  // How often every Claude account's plan usage is polled, here and by the machines' daemons (the endpoint rate-limits).
  'usagePollMinutes',
  // How many Unity editors may run at once on this host (each takes ~8-12 GB of RAM).
  'limits.maxUnity',
  // How many sandboxes may exist (each holds a worktree and a ~70 GB Library), and live agents on this host.
  'limits.maxSandboxes',
  'limits.maxSessions',
  // The address machines and the outside watchdog reach this portal at (the Tailscale Funnel URL).
  'publicUrl',
  // The Claude account the agents run on (claude setup-token): write-only, never shown (server/secrets.ts).
  'claudeEnv.CLAUDE_CODE_OAUTH_TOKEN',
  // A person's own Claude account, for agents working for them (docs/identity.md): write-only, needs `user`.
  'userClaudeEnv.CLAUDE_CODE_OAUTH_TOKEN',
  // Which account this host's agents run on, per role: "token" (claudeEnv's) or "login" (this host's stored
  // claude.ai login), and whether a Mac's agents take the host token (optional `machine`). docs/accounts.md.
  'claudeAccounts.orchestrator',
  'claudeAccounts.workers',
  'claudeAccounts.standing',
  'machines.useHostClaudeEnv',
  // Who automatic work (scheduled standing runs, intake-triggered FFBox work) is attributed and billed to.
  'systemPayer',
  // Files people attach to messages (docs/attachments.md): the largest one, and how long one nobody sends on is kept.
  'attachments.maxMB',
  'attachments.retentionDays',
  // FFBox's connector (docs/ffbox-integration.md): whether it may connect (default off), and its token,
  // write-only: only its SHA-256 is stored, as providers.ffbox.tokenSha256.
  'providers.ffbox.enabled',
  'providers.ffbox.token',
  // When the orchestrators compact their conversations by themselves (w535, server/autoCompact.ts): the context in
  // tokens, and a turn's cost in USD. 0 turns either trigger off.
  'orchestrator.compactAtTokens',
  'orchestrator.compactAtTurnUsd',
] as const;
export type SettableKey = (typeof SETTABLE_KEYS)[number];

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

// Windows paths ("C:/x", "\\\\server\\x") are judged as Windows paths on any OS (CI runs on Linux too).
const P = (p: string) => (/^[a-zA-Z]:[\\/]|^\\\\/.test(p) ? path.win32 : path);
const normPath = (p: string) => P(p).resolve(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
const inside = (p: string, root: string) => normPath(p) === normPath(root) || normPath(p).startsWith(normPath(root) + '/');

/**
 * Age rules delete old entries in a folder, so the folder must be a specific one: absolute, not a drive root
 * or the home folder itself, and not overlapping this app, its data, the sandboxes, the game's base clone or
 * any protected path.
 */
export function checkAgeRules(value: unknown, cfg?: Pick<Config, 'protectedPaths' | 'sandboxRoot' | 'standingRoot' | 'dataDir' | 'repo'>): { path: string; olderThanDays: number }[] {
  const list = typeof value === 'string' ? JSON.parse(value) : value;
  if (!Array.isArray(list) || list.length > 20) throw new Error('hostGuard.cleanup.ageRules is a list (at most 20) of { "path": "C:/abs/folder", "olderThanDays": 14 }');
  const off = cfg ? [...cfg.protectedPaths, cfg.sandboxRoot, cfg.standingRoot, cfg.dataDir, cfg.repo.basePath, ROOT] : [ROOT];
  return list.map((r) => {
    const p = typeof r?.path === 'string' ? r.path.trim() : '';
    const days = Number(r?.olderThanDays);
    if (!P(p).isAbsolute(p)) throw new Error(`age rule path "${p}" must be absolute`);
    if (normPath(p) === normPath(P(p).parse(P(p).resolve(p)).root) || normPath(p) === normPath(os.homedir())) throw new Error(`age rule path "${p}" is too broad`);
    const clash = off.find((o) => o && (inside(p, o) || inside(o, p)));
    if (clash) throw new Error(`age rule path "${p}" overlaps ${clash}, which clean-up never touches`);
    if (!Number.isFinite(days) || days < 3) throw new Error(`age rule for "${p}": olderThanDays must be at least 3`);
    return { path: p, olderThanDays: Math.round(days) };
  });
}

/** The value to store for `key`, or throws with what is wrong. `null` removes the key (back to the default). */
export function normalizeSetting(key: SettableKey, value: unknown, cfg?: Config): unknown {
  if (value === null || value === undefined) return undefined;
  switch (key) {
    case 'ownerName': {
      if (typeof value !== 'string') throw new Error('ownerName is a string');
      const v = oneLine(value);
      if (!v || v.length > 60 || /[<>`{}$\\]/.test(v)) throw new Error('ownerName: 1-60 characters, one line, no <>`{}$\\');
      return v;
    }
    case 'voice.vocabulary': {
      const list = typeof value === 'string' ? value.split(',') : value;
      if (!Array.isArray(list) || list.some((w) => typeof w !== 'string')) throw new Error('voice.vocabulary is a list of words (or one comma-separated string)');
      const words = [...new Set(list.map((w) => oneLine(w as string)).filter(Boolean))];
      if (words.length > 60 || words.some((w) => w.length > 40)) throw new Error('voice.vocabulary: at most 60 words of up to 40 characters');
      return words;
    }
    case 'publicGitIdentity.name': {
      if (typeof value !== 'string') throw new Error('publicGitIdentity.name is a string');
      const v = oneLine(value);
      if (!v || v.length > 60 || /[<>`{}$\\"]/.test(v)) throw new Error('publicGitIdentity.name: 1-60 characters, one line, no <>`{}$\\"');
      return v;
    }
    case 'publicGitIdentity.email': {
      if (typeof value !== 'string' || !/^[\w.+-]+@[\w-]+(\.[\w-]+)+$/.test(value.trim())) throw new Error('publicGitIdentity.email is an email address, e.g. 12345+you@users.noreply.github.com');
      return value.trim();
    }
    case 'claudeEnv.CLAUDE_CODE_OAUTH_TOKEN':
    case 'userClaudeEnv.CLAUDE_CODE_OAUTH_TOKEN': {
      // Never echo the value, not even in the error.
      if (typeof value !== 'string' || !OAUTH_TOKEN.test(value.trim())) throw new Error(`${key} must be a Claude OAuth token (sk-ant-oat01-…, from \`claude setup-token\`); the value given is not one (not shown)`);
      return value.trim();
    }
    case 'claudeAccounts.orchestrator':
    case 'claudeAccounts.workers':
    case 'claudeAccounts.standing': {
      const v = typeof value === 'string' ? value.trim() : value;
      if (v !== 'login' && v !== 'token') throw new Error(`${key} is "login" (this host's stored claude.ai login) or "token" (config claudeEnv's)`);
      // Refuse a switch that would leave the role unable to start: the stored login must be there and alive.
      const problem = v === 'login' && cfg ? hostLoginProblem(cfg) : undefined;
      if (problem) throw new Error(`${key} cannot be "login": ${problem}`);
      return v;
    }
    case 'machines.useHostClaudeEnv': {
      if (value === true || value === 'true') return true;
      if (value === false || value === 'false') return false;
      throw new Error('machines.useHostClaudeEnv is true (the host token) or false (the Mac\'s own login)');
    }
    case 'systemPayer': {
      if (typeof value !== 'string' || !USER_ID.test(value.trim())) throw new Error('systemPayer is a user id (a login name, e.g. "ben")');
      return value.trim();
    }
    case 'publicUrl': {
      if (typeof value !== 'string' || !/^https?:\/\/[^/\s]+\/?$/.test(value.trim())) throw new Error("publicUrl is the portal's base URL, e.g. https://<host>.<tailnet>.ts.net");
      return value.trim().replace(/\/+$/, '');
    }
    case 'limits.maxSandboxes':
    case 'limits.maxSessions': {
      const max = key === 'limits.maxSandboxes' ? 8 : 12;
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1 || n > max) throw new Error(`${key} is a whole number from 1 to ${max}`);
      return n;
    }
    case 'usagePollMinutes': {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 5 || n > 240) throw new Error('usagePollMinutes is a whole number of minutes from 5 to 240');
      return n;
    }
    case 'attachments.maxMB': {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1 || n > 4096) throw new Error('attachments.maxMB is a whole number of megabytes from 1 to 4096');
      return n;
    }
    case 'orchestrator.compactAtTokens': {
      const n = Number(value);
      if (!Number.isInteger(n) || (n !== 0 && (n < AUTO_COMPACT_LIMITS.minTokens || n > AUTO_COMPACT_LIMITS.maxTokens))) throw new Error(`orchestrator.compactAtTokens is 0 (off) or a whole number of tokens from ${AUTO_COMPACT_LIMITS.minTokens.toLocaleString('en-US')} to ${AUTO_COMPACT_LIMITS.maxTokens.toLocaleString('en-US')}`);
      return n;
    }
    case 'orchestrator.compactAtTurnUsd': {
      const n = Number(value);
      if (!Number.isFinite(n) || (n !== 0 && (n < AUTO_COMPACT_LIMITS.minTurnUsd || n > AUTO_COMPACT_LIMITS.maxTurnUsd))) throw new Error(`orchestrator.compactAtTurnUsd is 0 (off) or a cost in USD from ${AUTO_COMPACT_LIMITS.minTurnUsd} to ${AUTO_COMPACT_LIMITS.maxTurnUsd}`);
      return n;
    }
    case 'attachments.retentionDays': {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1 || n > 3650) throw new Error('attachments.retentionDays is a whole number of days from 1 to 3650');
      return n;
    }
    case 'limits.maxUnity': {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1 || n > 8) throw new Error('limits.maxUnity is a whole number of editors from 1 to 8');
      return n;
    }
    case 'hostGuard.devDriveVhdx': {
      if (typeof value !== 'string' || !P(value.trim()).isAbsolute(value.trim()) || !/\.vhdx?$/i.test(value.trim())) throw new Error('hostGuard.devDriveVhdx is the absolute path of a .vhdx file');
      return value.trim();
    }
    case 'hostGuard.cleanup.ageRules':
      return checkAgeRules(value, cfg);
    case 'hostGuard.cleanup.everyMinutes':
    case 'machines.cleanup.everyMinutes': {
      const n = Number(value);
      if (!Number.isInteger(n) || (n !== 0 && (n < 15 || n > 1440))) throw new Error(`${key} is 0 (only when disk space is low) or a whole number of minutes from 15 to 1440`);
      return n;
    }
    case 'hostGuard.cleanup.softFreeGB':
    case 'machines.cleanup.softFreeGB': {
      const n = Number(value);
      const floor = key === 'hostGuard.cleanup.softFreeGB' && cfg ? cfg.hostGuard.warnFreeGB + 1 : 10;
      if (!Number.isInteger(n) || n < floor || n > 2000) throw new Error(`${key} is a whole number of GB from ${floor} to 2000${floor > 10 ? ' (above hostGuard.warnFreeGB, where new work is refused)' : ''}`);
      return n;
    }
    case 'providers.ffbox.enabled': {
      if (value === true || value === 'true') return true;
      if (value === false || value === 'false') return false;
      throw new Error('providers.ffbox.enabled is true or false');
    }
    case 'providers.ffbox.token': {
      // Never echo the value, not even in the error. Stored as its hash (STORED_AS).
      if (typeof value !== 'string' || !PROVIDER_TOKEN.test(value.trim())) throw new Error('providers.ffbox.token must be a connector token (ffpv1_ and 43 characters, from `node server/providerToken.ts`); the value given is not one (not shown)');
      return tokenSha256(value.trim());
    }
    case 'voice.ttsVoice': {
      if (typeof value !== 'string' || !/^[a-z]{2}_[a-z]+$/.test(value.trim())) throw new Error('voice.ttsVoice is a Kokoro voice name such as "af_heart" or "bm_george"');
      return value.trim();
    }
  }
}

/** Keys stored under another name than the one set: the connector token is kept only as its hash. */
const STORED_AS: Partial<Record<SettableKey, string>> = { 'providers.ffbox.token': 'providers.ffbox.tokenSha256' };

/** Set (or with `undefined`, remove) a dotted key in a plain object. */
function setPath(obj: Record<string, unknown>, key: string, value: unknown) {
  const parts = key.split('.');
  let o = obj;
  for (const p of parts.slice(0, -1)) {
    if (typeof o[p] !== 'object' || o[p] === null || Array.isArray(o[p])) o[p] = {};
    o = o[p] as Record<string, unknown>;
  }
  const last = parts[parts.length - 1];
  if (value === undefined) delete o[last];
  else o[last] = value;
}

function getPath(obj: unknown, key: string): unknown {
  return key.split('.').reduce<unknown>((o, p) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[p] : undefined), obj);
}

/** A machine id as config machines.useHostClaudeEnv and machines.cleanup.* name it (server/machines.ts MACHINE_ID). */
const MACHINE_KEY = /^[a-z0-9][a-z0-9-]{0,23}$/;

/**
 * A per-machine setting (machines.useHostClaudeEnv, machines.cleanup.*) after setting it to `v` (undefined:
 * removing it) for `machine`, or for every machine not named when `machine` is absent. Per-machine entries
 * survive a change of the rest, which is "*" once there are any: { "*": false, "m5": true }. Collapses back to a
 * plain value (or nothing) when it can.
 */
export function nextPerMachine<T extends boolean | number>(cur: unknown, machine: string | undefined, v: T | undefined): T | Record<string, T> | undefined {
  const obj: Record<string, T> = typeof cur === 'object' && cur !== null ? { ...(cur as Record<string, T>) } : typeof cur === 'boolean' || typeof cur === 'number' ? { '*': cur as T } : {};
  const at = machine ?? '*';
  if (v === undefined) delete obj[at];
  else obj[at] = v;
  const keys = Object.keys(obj);
  if (!keys.length) return undefined;
  if (keys.length === 1 && keys[0] === '*') return obj['*'];
  return obj;
}

/**
 * Change one allowlisted key in the config file (kept as config.json.prev first; written through a temp
 * file) and in the running config. Returns the value before and after. `opts.user`: whose entry, for the
 * per-person keys (userClaudeEnv.*, stored as userClaudeEnv.<user>.*). `opts.machine`: for
 * machines.useHostClaudeEnv, the one machine to set (absent: every machine not named).
 */
export function setAppConfig(file: string, cfg: Config, key: SettableKey, value: unknown, opts: { user?: string; machine?: string } = {}): { before: unknown; after: unknown } {
  if (!SETTABLE_KEYS.includes(key)) throw new Error(`${key} cannot be changed by an agent; allowed: ${SETTABLE_KEYS.join(', ')}`);
  const perUser = key.startsWith('userClaudeEnv.');
  // The user id becomes a key path segment: no dots (edit config.json by hand for such a login).
  if (perUser && !(opts.user && USER_ID.test(opts.user) && !opts.user.includes('.'))) throw new Error(`${key} needs user: the user id (login name, without dots) whose account it is`);
  const perMachine = key === 'machines.useHostClaudeEnv' || key.startsWith('machines.cleanup.');
  if (opts.machine !== undefined && (!perMachine || !MACHINE_KEY.test(opts.machine))) throw new Error(`machine is only for machines.useHostClaudeEnv and machines.cleanup.*, and is a machine id such as "m5"`);
  const v = normalizeSetting(key, value, cfg);
  const text = fs.readFileSync(file, 'utf8');
  const raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as Record<string, unknown>;
  const stored = perUser ? `userClaudeEnv.${opts.user}.${key.slice('userClaudeEnv.'.length)}` : (STORED_AS[key] ?? key);
  const before = getPath(raw, stored);
  const next = perMachine ? nextPerMachine(before, opts.machine, v as boolean | number | undefined) : v;
  setPath(raw, stored, next);
  writeFileDurable(file + '.prev', text, { generations: 0 });
  writeFileDurable(file, JSON.stringify(raw, null, 2) + '\n');
  // Live: the running server reads these through the shared config object.
  if (key === 'ownerName') cfg.ownerName = v as string | undefined;
  else if (key === 'voice.vocabulary') cfg.voice.vocabulary = (v as string[] | undefined) ?? [];
  else if (key === 'voice.ttsVoice') cfg.voice.ttsVoice = (v as string | undefined) ?? VOICE_DEFAULTS.ttsVoice;
  else if (key === 'hostGuard.devDriveVhdx') cfg.hostGuard.devDriveVhdx = (v as string | undefined) ?? '';
  else if (key === 'limits.maxUnity') cfg.limits.maxUnity = (v as number | undefined) ?? 3;
  else if (key === 'limits.maxSandboxes') cfg.limits.maxSandboxes = (v as number | undefined) ?? 4;
  else if (key === 'limits.maxSessions') cfg.limits.maxSessions = (v as number | undefined) ?? 6;
  else if (key === 'publicUrl') cfg.publicUrl = v as string | undefined;
  else if (key === 'attachments.maxMB' || key === 'attachments.retentionDays') {
    const field = key === 'attachments.maxMB' ? 'maxMB' : 'retentionDays';
    const a = { ...cfg.attachments };
    if (v === undefined) delete a[field];
    else a[field] = v as number;
    cfg.attachments = a;
  }
  else if (key === 'claudeEnv.CLAUDE_CODE_OAUTH_TOKEN') {
    const env = { ...cfg.claudeEnv };
    if (v === undefined) delete env.CLAUDE_CODE_OAUTH_TOKEN;
    else env.CLAUDE_CODE_OAUTH_TOKEN = v as string;
    cfg.claudeEnv = env;
  } else if (key === 'userClaudeEnv.CLAUDE_CODE_OAUTH_TOKEN') {
    const all = { ...cfg.userClaudeEnv };
    const env = { ...all[opts.user!] };
    if (v === undefined) delete env.CLAUDE_CODE_OAUTH_TOKEN;
    else env.CLAUDE_CODE_OAUTH_TOKEN = v as string;
    if (Object.keys(env).length) all[opts.user!] = env;
    else delete all[opts.user!];
    cfg.userClaudeEnv = all;
  } else if (key === 'claudeAccounts.orchestrator' || key === 'claudeAccounts.workers' || key === 'claudeAccounts.standing') {
    const accounts = { ...cfg.claudeAccounts };
    const role = key.slice('claudeAccounts.'.length) as HostRole;
    if (v === undefined) delete accounts[role];
    else accounts[role] = v as ClaudeAccount;
    cfg.claudeAccounts = accounts;
  } else if (key === 'machines.useHostClaudeEnv') cfg.machines = { ...cfg.machines, useHostClaudeEnv: next as boolean | Record<string, boolean> | undefined };
  else if (key === 'systemPayer') cfg.systemPayer = v as string | undefined;
  else if (key === 'providers.ffbox.enabled' || key === 'providers.ffbox.token') {
    const ffbox = { ...cfg.providers?.ffbox };
    if (key === 'providers.ffbox.enabled') ffbox.enabled = v as boolean | undefined;
    else ffbox.tokenSha256 = v as string | undefined;
    cfg.providers = { ...cfg.providers, ffbox };
  }
  else if (key === 'hostGuard.cleanup.ageRules') cfg.hostGuard.cleanup.ageRules = (v as { path: string; olderThanDays: number }[] | undefined) ?? [];
  else if (key === 'orchestrator.compactAtTokens') cfg.orchestrator = { ...cfg.orchestrator, compactAtTokens: v as number | undefined };
  else if (key === 'orchestrator.compactAtTurnUsd') cfg.orchestrator = { ...cfg.orchestrator, compactAtTurnUsd: v as number | undefined };
  else if (key === 'usagePollMinutes') cfg.usagePollMinutes = (v as number | undefined) ?? DEFAULT_USAGE_POLL_MINUTES;
  else if (key === 'hostGuard.cleanup.everyMinutes') cfg.hostGuard.cleanup.everyMinutes = (v as number | undefined) ?? DEFAULT_CLEANUP.everyMinutes;
  else if (key === 'hostGuard.cleanup.softFreeGB') cfg.hostGuard.cleanup.softFreeGB = (v as number | undefined) ?? DEFAULT_CLEANUP.softFreeGB;
  else if (key === 'machines.cleanup.everyMinutes' || key === 'machines.cleanup.softFreeGB') {
    const field = key === 'machines.cleanup.everyMinutes' ? 'everyMinutes' : 'softFreeGB';
    cfg.machines = { ...cfg.machines, cleanup: { ...cfg.machines?.cleanup, [field]: next as number | Record<string, number> | undefined } };
  }
  else if (key === 'publicGitIdentity.name' || key === 'publicGitIdentity.email') {
    const field = key === 'publicGitIdentity.name' ? 'name' : 'email';
    cfg.publicGitIdentity = { ...cfg.publicGitIdentity, [field]: v as string | undefined };
  }
  // A write-only secret reads back as "set (…abcd)" only.
  if (SECRET_KEYS.has(key)) return { before: maskSecret(before), after: maskSecret(v) };
  return { before, after: next };
}
