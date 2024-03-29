import { RpcConsensusType } from '@hyperlane-xyz/sdk';

import { KeyFunderConfig } from '../../../src/config/funding';
import { Role } from '../../../src/roles';
import { Contexts } from '../../contexts';

import { environment } from './chains';

export const keyFunderConfig: KeyFunderConfig = {
  docker: {
    repo: 'gcr.io/abacus-labs-dev/hyperlane-monorepo',
    tag: '7d1f975-20240312-113049',
  },
  // We're currently using the same deployer key as testnet2.
  // To minimize nonce clobbering we offset the key funder cron
  // schedule by 30 minutes.
  cronSchedule: '15 * * * *', // Every hour at the 15-minute mark
  namespace: environment,
  prometheusPushGateway:
    'http://prometheus-pushgateway.monitoring.svc.cluster.local:9091',
  contextFundingFrom: Contexts.Hyperlane,
  contextsAndRolesToFund: {
    [Contexts.Hyperlane]: [Role.Relayer, Role.Kathy],
    [Contexts.ReleaseCandidate]: [Role.Relayer, Role.Kathy],
  },
  connectionType: RpcConsensusType.Quorum,
  // desired balance config
  desiredBalancePerChain: {
    alfajores: '5',
    bsctestnet: '5',
    fuji: '5',
    plumetestnet: '0.2',
    sepolia: '5',
    // Funder boosts itself upto 5x balance on L2 before dispersing funds
    scrollsepolia: '1',
  },
  desiredKathyBalancePerChain: {
    plumetestnet: '0.05',
  },
};
