import { runHelloworldKathyHelmCommand } from '../../src/helloworld/kathy';
import { HelmCommand } from '../../src/utils/helm';
import { assertCorrectKubeContext, getConfigsBasedOnArgs } from '../utils';

import { getHelloWorldConfig } from './utils';

async function main() {
  const { agentConfig, envConfig } = await getConfigsBasedOnArgs();
  await assertCorrectKubeContext(envConfig);
  const kathyConfig = getHelloWorldConfig(envConfig, agentConfig.context).kathy;

  await runHelloworldKathyHelmCommand(
    HelmCommand.InstallOrUpgrade,
    agentConfig,
    kathyConfig,
  );
}

main()
  .then(() => console.log('Deploy successful!'))
  .catch(console.error);
