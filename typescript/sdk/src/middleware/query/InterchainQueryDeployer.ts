import { InterchainQueryRouter__factory } from '@hyperlane-xyz/core';

import { MultiProvider } from '../../providers/MultiProvider';
import { RouterConfig } from '../../router/types';
import { ChainMap } from '../../types';
import { MiddlewareRouterDeployer } from '../MiddlewareRouterDeployer';

import { interchainQueryFactories } from './contracts';

export type InterchainQueryConfig = RouterConfig;

export class InterchainQueryDeployer extends MiddlewareRouterDeployer<
  InterchainQueryConfig,
  typeof interchainQueryFactories,
  InterchainQueryRouter__factory
> {
  readonly routerContractName = 'interchainQueryRouter';

  constructor(
    multiProvider: MultiProvider,
    configMap: ChainMap<InterchainQueryConfig>,
    create2salt = 'queryrouter2',
  ) {
    super(multiProvider, configMap, interchainQueryFactories, create2salt);
  }
}
