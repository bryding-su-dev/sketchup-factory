// Mint FFBox's connector token (docs/ffbox-connector-contract.md): prints a new token once and keeps only its
// SHA-256 in config.json (providers.ffbox.tokenSha256). A running server picks the new hash up at the next
// connection attempt only after a restart, or set it live with set_app_config providers.ffbox.token instead.
//   node server/providerToken.ts             new token (the old one stops working)
//   node server/providerToken.ts --revoke    no token: the connector is refused
import { configPath, loadConfig } from './config.ts';
import { setAppConfig } from './appConfig.ts';
import { mintProviderToken } from './providerProtocol.ts';

const cfg = loadConfig();
const arg = process.argv[2];
if (arg === '--revoke') {
  setAppConfig(configPath(), cfg, 'providers.ffbox.token', null);
  console.log('FFBox connector token removed: the connector is refused until a new one is set.');
} else if (arg === undefined) {
  const token = mintProviderToken();
  setAppConfig(configPath(), cfg, 'providers.ffbox.token', token);
  console.log(token);
  console.error(
    `\nThat is FFBox's connector token, shown once; config.json keeps only its SHA-256. Give it to the connector's\n` +
      `owner out of band (it goes in FFBox's secrets file). Restart SketchUp Factory, or set it live with set_app_config.\n` +
      `providers.ffbox.enabled is ${cfg.providers?.ffbox?.enabled === true ? 'true' : 'false: the connector is refused until it is true'}.`,
  );
} else {
  console.error('usage: node server/providerToken.ts [--revoke]');
  process.exit(2);
}
