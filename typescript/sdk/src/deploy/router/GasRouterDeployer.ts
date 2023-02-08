import { debug } from 'debug';

import { GasRouter } from '@hyperlane-xyz/core';

import { DomainIdToChainName } from '../../domains';
import { MultiProvider } from '../../providers/MultiProvider';
import { RouterContracts, RouterFactories } from '../../router';
import { ChainMap, ChainName } from '../../types';
import { DeployerOptions } from '../HyperlaneDeployer';

import { HyperlaneRouterDeployer } from './HyperlaneRouterDeployer';
import { GasRouterConfig } from './types';

export abstract class GasRouterDeployer<
  Chain extends ChainName,
  Config extends GasRouterConfig,
  Contracts extends RouterContracts<GasRouter>,
  Factories extends RouterFactories<GasRouter>,
> extends HyperlaneRouterDeployer<Chain, Config, Contracts, Factories> {
  constructor(
    multiProvider: MultiProvider<Chain>,
    configMap: ChainMap<Chain, Config>,
    factories: Factories,
    options?: DeployerOptions,
  ) {
    super(multiProvider, configMap, factories, {
      logger: debug('hyperlane:GasRouterDeployer'),
      ...options,
    });
  }

  async enrollRemoteRouters(
    contractsMap: ChainMap<Chain, Contracts>,
  ): Promise<void> {
    await super.enrollRemoteRouters(contractsMap);

    this.logger(`Setting enrolled router destination gas...`);
    for (const [chain, contracts] of Object.entries<Contracts>(contractsMap)) {
      const local = chain as Chain;

      const remoteDomains = await contracts.router.domains();
      const remoteChains = remoteDomains.map(
        (domain) => DomainIdToChainName[domain] as Chain,
      );
      const currentConfigs = await Promise.all(
        remoteDomains.map((domain) => contracts.router.destinationGas(domain)),
      );
      const remoteConfigs = remoteDomains
        .map((domain, i) => ({
          domain,
          gas: this.configMap[remoteChains[i]].gas,
        }))
        .filter(({ gas }, index) => !currentConfigs[index].eq(gas));
      if (remoteConfigs.length == 0) {
        continue;
      }

      this.logger(`Set destination gas on ${local} for ${remoteChains}`);
      const chainConnection = this.multiProvider.getChainConnection(local);
      await chainConnection.handleTx(
        contracts.router.setDestinationGas(remoteConfigs),
      );
    }
  }
}
