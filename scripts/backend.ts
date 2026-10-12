// Switch the agents between your Claude plan and Amazon Bedrock without asking an agent (w38, docs/bedrock.md).
//   node scripts/backend.ts status | plan | bedrock | auto [--url http://127.0.0.1:8790] [--key-file <file>]
// Deterministic code: no model, no tokens. See server/backendSwitch.ts.
import { configPath, loadConfig } from '../server/config.ts';
import { setAppConfig } from '../server/appConfig.ts';
import { USAGE, parseSwitchArgs, readKey, runSwitch } from '../server/backendSwitch.ts';

const args = parseSwitchArgs(process.argv.slice(2));
if ('error' in args) {
  console.error(`${args.error}\n${USAGE}`);
  process.exit(2);
}
// The URL: --url / FF_URL, else this host's own port from config.json.
let url = args.url;
if (!url) {
  try {
    url = `http://127.0.0.1:${loadConfig().port}`;
  } catch {
    url = 'http://127.0.0.1:8790';
  }
}
try {
  const lines = await runSwitch({ ...args, url }, readKey(args), {
    fetch,
    offlineSet: (mode) => setAppConfig(configPath(), loadConfig(), 'bedrock.mode', mode),
  });
  console.log(lines.join('\n'));
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
