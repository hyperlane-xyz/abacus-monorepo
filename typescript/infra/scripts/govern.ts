import {
  AbacusCore,
  AbacusCoreChecker,
  CoreViolationType,
} from '@abacus-network/sdk';

import { AbacusCoreGovernor } from '../src/core/govern';

import { getCoreEnvironmentConfig, getEnvironment } from './utils';

async function check() {
  const environment = await getEnvironment();
  const config = getCoreEnvironmentConfig(environment);

  const multiProvider = await config.getMultiProvider();

  // environments union doesn't work well with typescript
  const core = AbacusCore.fromEnvironment(environment, multiProvider as any);

  const coreChecker = new AbacusCoreChecker<any>(
    multiProvider,
    core,
    config.core,
  );
  await coreChecker.check();
  // One threshold violation per VM per chain
  // One validator violation per VM per chain (add zk and zp)
  await coreChecker.expectViolations(
    [CoreViolationType.ValidatorManager],
    [2 * 7 * 7],
  );

  const governor = new AbacusCoreGovernor(coreChecker);
  await governor.govern();
}

check().then(console.log).catch(console.error);
