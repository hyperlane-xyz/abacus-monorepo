import { getMultiProviderForRole } from '../../../scripts/utils';
import { KEY_ROLE_ENUM } from '../../../src/agents/roles';
import { CoreEnvironmentConfig } from '../../../src/config';
import { Contexts } from '../../contexts';

import { agents } from './agent';
import {
  MainnetChains,
  environment as environmentName,
  mainnetConfigs,
} from './chains';
import { core } from './core';
import { keyFunderConfig } from './funding';
import { helloWorld } from './helloworld';
import { infrastructure } from './infrastructure';

export const environment: CoreEnvironmentConfig<MainnetChains> = {
  environment: environmentName,
  transactionConfigs: mainnetConfigs,
  getMultiProvider: (context?: Contexts, role?: KEY_ROLE_ENUM) =>
    getMultiProviderForRole(
      mainnetConfigs,
      environmentName,
      context ?? Contexts.Abacus,
      role ?? KEY_ROLE_ENUM.Deployer,
    ),
  agents,
  core,
  infra: infrastructure,
  helloWorld,
  keyFunderConfig,
};
