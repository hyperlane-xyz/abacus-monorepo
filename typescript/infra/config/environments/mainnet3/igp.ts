import { ChainMap, HookType, IgpConfig } from '@hyperlane-xyz/sdk';
import { exclude, objMap } from '@hyperlane-xyz/utils';

import {
  AllStorageGasOracleConfigs,
  getAllStorageGasOracleConfigs,
  getTokenExchangeRateFromValues,
  remoteOverhead,
} from '../../../src/config/gas-oracle.js';

import { ethereumChainNames } from './chains.js';
import gasPrices from './gasPrices.json';
import { DEPLOYER, ethereumChainOwners } from './owners.js';
import { supportedChainNames } from './supportedChainNames.js';
import rawTokenPrices from './tokenPrices.json';

const tokenPrices: ChainMap<string> = rawTokenPrices;

const storageGasOracleConfig: AllStorageGasOracleConfigs =
  getAllStorageGasOracleConfigs(
    supportedChainNames,
    gasPrices,
    (local, remote) =>
      getTokenExchangeRateFromValues(local, remote, tokenPrices),
    (local) => parseFloat(tokenPrices[local]),
    (local) => remoteOverhead(local, ethereumChainNames),
  );

export const igp: ChainMap<IgpConfig> = objMap(
  ethereumChainOwners,
  (local, owner): IgpConfig => ({
    type: HookType.INTERCHAIN_GAS_PAYMASTER,
    ...owner,
    ownerOverrides: {
      ...owner.ownerOverrides,
      interchainGasPaymaster: DEPLOYER,
      storageGasOracle: DEPLOYER,
    },
    oracleKey: DEPLOYER,
    beneficiary: DEPLOYER,
    overhead: Object.fromEntries(
      exclude(local, supportedChainNames).map((remote) => [
        remote,
        remoteOverhead(remote, ethereumChainNames),
      ]),
    ),
    oracleConfig: storageGasOracleConfig[local],
  }),
);
