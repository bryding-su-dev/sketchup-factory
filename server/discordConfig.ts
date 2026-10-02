// Where Max's bot token and channel ids already live on this host: the "discord" section of the ffbox config
// (~/.config/ffbox/config.json), read the way the ffdiscord CLI reads it. The token is best the NAME of a
// secrets.env variable (`"app_token": "DISCORD_TOKEN"`), looked up in the environment and then in secrets.env next
// to the config. SketchUp Factory copies it nowhere: it reads the file when it needs the token, keeps it in this
// process only, and never sends it to a page, an agent or a log (docs/max.md).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** A secrets.env variable name: capitals, digits and underscores, with at least one underscore (as the CLI's SECRET_NAME). */
const SECRET_NAME = /^[A-Z][A-Z0-9]*_[A-Z0-9_]*$/;

export interface DiscordConfig {
  token?: string;
  /** Where the token came from, for the page: a variable name and file, never the value. */
  source: string;
  problem?: string;
  guildId?: string;
  /** alias -> channel id (blank ids are left out). */
  channels: Record<string, string>;
}

export function ffboxConfigDir(override?: string, env: NodeJS.ProcessEnv = process.env) {
  const dir = override || env.FFBOX_CONFIG_DIR || path.join(os.homedir(), '.config', 'ffbox');
  return dir.startsWith('~') ? path.join(os.homedir(), dir.slice(1)) : dir;
}

/** One variable out of a secrets.env: KEY=value, an optional `export `, matching quotes stripped. Nothing is executed. */
export function readSecret(file: string, name: string): string {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    let key = line.slice(0, eq).trim();
    if (key.startsWith('export ')) key = key.slice(7).trim();
    if (key !== name) continue;
    let v = line.slice(eq + 1).trim();
    if (v.length >= 2 && v[0] === v[v.length - 1] && (v[0] === '"' || v[0] === "'")) v = v.slice(1, -1);
    return v;
  }
  return '';
}

/** Read the discord section now (it is small; callers cache what they need). */
export function readDiscordConfig(dirOverride?: string, env: NodeJS.ProcessEnv = process.env): DiscordConfig {
  const dir = ffboxConfigDir(dirOverride, env);
  const file = path.join(dir, 'config.json');
  const secrets = env.FFBOX_SECRETS || path.join(dir, 'secrets.env');
  let section: Record<string, unknown> = {};
  let problem: string | undefined;
  try {
    const whole = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    if (whole.discord && typeof whole.discord === 'object') section = whole.discord as Record<string, unknown>;
    else problem = `${file} has no "discord" section`;
  } catch (e) {
    problem = (e as NodeJS.ErrnoException).code === 'ENOENT' ? `no ${file}` : `${file} is not valid JSON`;
  }
  const channels: Record<string, string> = {};
  if (section.channels && typeof section.channels === 'object') {
    for (const [k, v] of Object.entries(section.channels as Record<string, unknown>)) if (typeof v === 'string' && /^\d{5,25}$/.test(v)) channels[k] = v;
  }
  const guildId = env.FFDISCORD_SERVER_ID || (typeof section.server_id === 'string' && /^\d{5,25}$/.test(section.server_id) ? section.server_id : undefined);

  let token: string | undefined;
  let source: string;
  const named = typeof section.app_token === 'string' ? section.app_token.trim() : '';
  if (env.FFDISCORD_APP_TOKEN) {
    token = env.FFDISCORD_APP_TOKEN;
    source = 'FFDISCORD_APP_TOKEN (environment)';
  } else if (SECRET_NAME.test(named)) {
    token = env[named] || readSecret(secrets, named) || undefined;
    source = `${named} in ${env[named] ? 'the environment' : secrets}`;
    if (!token) problem = `${named} is not set in the environment or in ${secrets}`;
  } else if (named) {
    token = named;
    source = `app_token in ${file}`;
  } else {
    source = file;
    problem ??= `no app_token in the "discord" section of ${file}`;
  }
  return { token, source, problem: token ? undefined : problem, guildId, channels };
}
