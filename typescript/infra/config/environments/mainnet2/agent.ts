import { ALL_KEY_ROLES, KEY_ROLE_ENUM } from '../../../src/agents/roles';
import { AgentConfig } from '../../../src/config';
import {
  ConnectionType,
  GasPaymentEnforcementPolicyType,
} from '../../../src/config/agent';
import { Contexts } from '../../contexts';
import { helloworldMatchingList } from '../../utils';

import { MainnetChains, chainNames, environment } from './chains';
import { helloWorld } from './helloworld';
import { validators } from './validators';

const releaseCandidateHelloworldMatchingList = helloworldMatchingList(
  helloWorld,
  Contexts.ReleaseCandidate,
);

export const hyperlane: AgentConfig<MainnetChains> = {
  environment,
  namespace: environment,
  runEnv: environment,
  context: Contexts.Hyperlane,
  docker: {
    repo: 'gcr.io/abacus-labs-dev/hyperlane-agent',
    tag: 'sha-d1ad862',
  },
  aws: {
    region: 'us-east-1',
  },
  environmentChainNames: chainNames,
  contextChainNames: chainNames,
  validatorSets: validators,
  gelato: {
    enabledChains: [],
  },
  connectionType: ConnectionType.HttpQuorum,
  validator: {
    default: {
      interval: 5,
      reorgPeriod: 1,
    },
    chainOverrides: {
      celo: {
        reorgPeriod: 0,
      },
      ethereum: {
        reorgPeriod: 14,
      },
      bsc: {
        reorgPeriod: 15,
      },
      optimism: {
        reorgPeriod: 0,
      },
      arbitrum: {
        reorgPeriod: 0,
      },
      avalanche: {
        reorgPeriod: 3,
      },
      polygon: {
        reorgPeriod: 256,
      },
      moonbeam: {
        reorgPeriod: 0,
      },
      gnosis: {
        reorgPeriod: 14,
      },
    },
  },
  relayer: {
    default: {
      blacklist: [
        ...releaseCandidateHelloworldMatchingList,
        {
          originDomain: '137',
          recipientAddress: '0xBC3cFeca7Df5A45d61BC60E7898E63670e1654aE',
        },
      ],
      gasPaymentEnforcementPolicy: {
        type: GasPaymentEnforcementPolicyType.None,
      },
    },
  },
  rolesWithKeys: ALL_KEY_ROLES,
};

export const releaseCandidate: AgentConfig<MainnetChains> = {
  environment,
  namespace: environment,
  runEnv: environment,
  context: Contexts.ReleaseCandidate,
  docker: {
    repo: 'gcr.io/abacus-labs-dev/hyperlane-agent',
    tag: 'sha-0477ee1',
  },
  aws: {
    region: 'us-east-1',
  },
  environmentChainNames: chainNames,
  contextChainNames: chainNames,
  validatorSets: validators,
  gelato: {
    enabledChains: [],
  },
  connectionType: ConnectionType.HttpQuorum,
  relayer: {
    default: {
      whitelist: releaseCandidateHelloworldMatchingList,
      gasPaymentEnforcementPolicy: {
        type: GasPaymentEnforcementPolicyType.None,
      },
    },
  },
  rolesWithKeys: [KEY_ROLE_ENUM.Relayer, KEY_ROLE_ENUM.Kathy],
};

export const agents = {
  [Contexts.Hyperlane]: hyperlane,
  [Contexts.ReleaseCandidate]: releaseCandidate,
};
