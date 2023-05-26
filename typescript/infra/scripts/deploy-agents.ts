import { ValidatorHelmManager } from '../src/agents';
import { HelmCommand } from '../src/utils/helm';

import {
  assertCorrectKubeContext,
  getContextAgentConfig,
  getEnvironment,
  getEnvironmentConfig,
} from './utils';

async function deploy() {
  const environment = await getEnvironment();
  const config = getEnvironmentConfig(environment);

  const agentConfig = await getContextAgentConfig(config);

  await assertCorrectKubeContext(config);

  // Note the create-keys script should be ran prior to running this script.
  // At the moment, `runAgentHelmCommand` has the side effect of creating keys / users
  // if they do not exist. It's possible for a race condition to occur where creation of
  // a key / user that is used by multiple deployments (like Kathy),
  // whose keys / users are not chain-specific) will be attempted multiple times.
  // While this function still has these side effects, the workaround is to just
  // run the create-keys script first.

  // TODO: we need to have each agent type decide whether to run for each chain or just once for all
  await Promise.all(
    agentConfig.contextChainNames.map(async (name: string) => {
      await new ValidatorHelmManager(agentConfig, name).runHelmCommand(
        HelmCommand.InstallOrUpgrade,
      );
    }),
  );
}

deploy().then(console.log).catch(console.error);
