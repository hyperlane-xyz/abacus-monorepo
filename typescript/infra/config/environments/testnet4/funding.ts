import { RpcConsensusType } from '@hyperlane-xyz/sdk';

import { KeyFunderConfig } from '../../../src/config/funding';
import { Role } from '../../../src/roles';
import { Contexts } from '../../contexts';

import { environment } from './chains';

export const keyFunderConfig: KeyFunderConfig = {
  docker: {
    repo: 'gcr.io/abacus-labs-dev/hyperlane-monorepo',
    tag: '620925c-20240213-171901',
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
    alfajores: '1',
    arbitrumgoerli: '0.5',
    bsctestnet: '1',
    fuji: '1',
    goerli: '0.5',
    mumbai: '0.8',
    optimismgoerli: '0.5',
    plumetestnet: '0.2',
    polygonzkevmtestnet: '0.3',
    scrollsepolia: '0.05',
    sepolia: '0.5',
  },
  desiredKathyBalancePerChain: {
    plumetestnet: '0.05',
  },
};
