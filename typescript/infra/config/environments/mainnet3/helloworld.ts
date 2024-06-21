import {
  HelloWorldConfig,
  HelloWorldKathyRunMode,
} from '../../../src/config/helloworld/types.js';
import { Contexts } from '../../contexts.js';

import { environment, ethereumChainNames } from './chains.js';
import hyperlaneAddresses from './helloworld/hyperlane/addresses.json';
import rcAddresses from './helloworld/rc/addresses.json';

export const hyperlane: HelloWorldConfig = {
  addresses: hyperlaneAddresses,
  kathy: {
    docker: {
      repo: 'gcr.io/abacus-labs-dev/hyperlane-monorepo',
      tag: 'b22a0f4-20240523-140812',
    },
    chainsToSkip: [],
    runEnv: environment,
    namespace: environment,
    runConfig: {
      mode: HelloWorldKathyRunMode.Service,
      fullCycleTime: 1000 * 60 * 60 * 24 * 7, // every 7 days, 15 * 14 messages = 210 messages is every ~45 mins
    },
    messageSendTimeout: 1000 * 60 * 8, // 8 min
    messageReceiptTimeout: 1000 * 60 * 20, // 20 min
    cyclesBetweenEthereumMessages: 1, // Skip 1 cycle of Ethereum, i.e. send/receive Ethereum messages every 5 days (not great since we still send like 12 in that cycle)
  },
};

export const releaseCandidate: HelloWorldConfig = {
  addresses: rcAddresses,
  kathy: {
    docker: {
      repo: 'gcr.io/abacus-labs-dev/hyperlane-monorepo',
      tag: 'b22a0f4-20240523-140812',
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
  [Contexts.Hyperlane]: hyperlane,
  [Contexts.ReleaseCandidate]: releaseCandidate,
  [Contexts.Neutron]: undefined,
};
