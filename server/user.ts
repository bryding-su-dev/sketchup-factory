// Create a login, change its password, or change its profile (docs/identity.md):
//   node server/user.ts <username> [--name "Display Name"] [--role owner|member]
//   node server/user.ts <username> --name "Display Name" --role member --keep-password
// Prompts for the password (or reads FFSB_PASSWORD); --keep-password changes only the name or role. The first
// login is the owner, later ones members, unless --role says otherwise. Run it on the host; it writes data/users.json.
import fs from 'node:fs';
import readline from 'node:readline';
import { parseArgs } from 'node:util';
import { loadConfig } from './config.ts';
import { Auth } from './auth.ts';
import type { UserRole } from '../shared/types.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { name: { type: 'string' }, role: { type: 'string' }, 'keep-password': { type: 'boolean' } },
});
const username = positionals[0];
if (!username || (values.role !== undefined && values.role !== 'owner' && values.role !== 'member')) {
  console.error('usage: node server/user.ts <username> [--name "Display Name"] [--role owner|member] [--keep-password]');
  process.exit(2);
}
const profile = { displayName: values.name, role: values.role as UserRole | undefined };
const cfg = loadConfig();
// The README creates the first login before the server has ever run, so the data folder may not exist yet.
fs.mkdirSync(cfg.dataDir, { recursive: true });
const auth = new Auth(cfg.dataDir, { trustProxy: false });
if (values['keep-password']) {
  auth.setProfile(username, profile);
  const u = auth.userInfo(username)!;
  console.log(`saved ${username}: "${u.displayName}", ${u.role}; password and sessions unchanged`);
} else {
  let password = process.env.FFSB_PASSWORD;
  if (!password) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    password = await new Promise<string>((r) => rl.question(`Password for ${username} (12+ chars): `, r));
    rl.close();
  }
  await auth.setUser(username, password, profile);
  const u = auth.userInfo(username)!;
  console.log(`saved ${username} ("${u.displayName}", ${u.role}); their existing sessions were signed out`);
}
