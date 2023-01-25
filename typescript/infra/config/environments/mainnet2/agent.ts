import { ALL_KEY_ROLES } from '../../../src/agents/roles';
import { AgentConfig } from '../../../src/config';
import {
  ConnectionType,
  GasPaymentEnforcementPolicyType,
} from '../../../src/config/agent';
import { Contexts } from '../../contexts';

import { MainnetChains, chainNames, environment } from './chains';
// import { helloWorld } from './helloworld';
import { validators } from './validators';

export const hyperlane: AgentConfig<MainnetChains> = {
  environment,
  namespace: environment,
  runEnv: environment,
  context: Contexts.Hyperlane,
  docker: {
    repo: 'gcr.io/abacus-labs-dev/hyperlane-agent',
    tag: 'sha-c163fce',
  },
  aws: {
    region: 'us-east-1',
  },
  environmentChainNames: chainNames,
  contextChainNames: chainNames,
  gelato: {
    enabledChains: [],
  },
  connectionType: ConnectionType.HttpQuorum,
  validators,
  relayer: {
    default: {
      blacklist: [
        {
          sourceDomain: '137',
          destinationAddress: '0xBC3cFeca7Df5A45d61BC60E7898E63670e1654aE',
        },
      ],
      gasPaymentEnforcementPolicy: {
        type: GasPaymentEnforcementPolicyType.None,
      },
    },
  },
  rolesWithKeys: ALL_KEY_ROLES,
};

export const agents = {
  [Contexts.Hyperlane]: hyperlane,
};
