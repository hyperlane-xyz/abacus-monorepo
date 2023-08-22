import { HelmCommand } from '../../src/utils/helm';

import { runWarpRouteHelmCommand } from './helm';

async function main() {
  await runWarpRouteHelmCommand(HelmCommand.InstallOrUpgrade);
}

main()
  .then(() => console.log('Deploy successful!'))
  .catch(console.error);
