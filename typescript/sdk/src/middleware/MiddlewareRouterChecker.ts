import { HyperlaneRouterChecker } from '../router/HyperlaneRouterChecker';
import { RouterApp } from '../router/RouterApps';
import { RouterConfig, RouterContracts } from '../router/types';
import { ChainName } from '../types';

export abstract class MiddlewareRouterChecker<
  MiddlewareRouterApp extends RouterApp<MiddlewareRouterContracts>,
  MiddlewareRouterConfig extends RouterConfig,
  MiddlewareRouterContracts extends RouterContracts,
> extends HyperlaneRouterChecker<
  MiddlewareRouterApp,
  MiddlewareRouterConfig,
  MiddlewareRouterContracts
> {
  async checkChain(chain: ChainName): Promise<void> {
    await super.checkChain(chain);
    await this.checkProxiedContracts(chain);
  }
}
