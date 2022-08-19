import { HelloWorldConfig } from '../../../src/config';
import { HelloWorldKathyRunMode } from '../../../src/config/helloworld';
import { Contexts } from '../../contexts';

import { MainnetChains, environment } from './chains';
import abacusAddresses from './helloworld/abacus/addresses.json';
import rcAddresses from './helloworld/rc/addresses.json';

export const abacus: HelloWorldConfig<MainnetChains> = {
  addresses: abacusAddresses,
  kathy: {
    docker: {
      repo: 'gcr.io/abacus-labs-dev/abacus-monorepo',
      tag: 'sha-8b8fdde',
    },
    chainsToSkip: [],
    runEnv: environment,
    namespace: environment,
    runConfig: {
      mode: HelloWorldKathyRunMode.Service,
      fullCycleTime: 1000 * 60 * 60 * 6, // every 6 hours
    },
    messageSendTimeout: 1000 * 60 * 8, // 8 min
    messageReceiptTimeout: 1000 * 60 * 20, // 20 min
  },
};

export const releaseCandidate: HelloWorldConfig<MainnetChains> = {
  addresses: rcAddresses,
  kathy: {
    docker: {
      repo: 'gcr.io/abacus-labs-dev/abacus-monorepo',
      tag: 'sha-8b8fdde',
    },
    chainsToSkip: [],
    runEnv: environment,
    namespace: environment,
    runConfig: {
      mode: HelloWorldKathyRunMode.CycleOnce,
    },
    messageSendTimeout: 1000 * 60 * 8, // 8 min
    messageReceiptTimeout: 1000 * 60 * 20, // 20 min
  },
};

export const helloWorld = {
  [Contexts.Abacus]: abacus,
  [Contexts.ReleaseCandidate]: releaseCandidate,
};
