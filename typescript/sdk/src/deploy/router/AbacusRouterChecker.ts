import { Ownable } from '@abacus-network/core';
import { utils } from '@abacus-network/utils';

import { AbacusApp } from '../../AbacusApp';
import { chainMetadata } from '../../consts/chainMetadata';
import { RouterContracts } from '../../router';
import { ChainName } from '../../types';
import { AbacusAppChecker } from '../AbacusAppChecker';

import { RouterConfig } from './types';

export class AbacusRouterChecker<
  Chain extends ChainName,
  App extends AbacusApp<Contracts, Chain>,
  Config extends RouterConfig,
  Contracts extends RouterContracts,
> extends AbacusAppChecker<Chain, App, Config> {
  checkOwnership(chain: Chain): Promise<void> {
    const owner = this.configMap[chain].owner;
    const ownables = this.ownables(chain);
    return super.checkOwnership(chain, owner, ownables);
  }

  async checkChain(chain: Chain): Promise<void> {
    await this.checkEnrolledRouters(chain);
    await this.checkOwnership(chain);
  }

  async checkEnrolledRouters(chain: Chain): Promise<void> {
    const router = this.app.getContracts(chain).router;

    await Promise.all(
      this.app.remoteChains(chain).map(async (remoteNetwork) => {
        const remoteRouter = this.app.getContracts(remoteNetwork).router;
        const remoteChainId = chainMetadata[remoteNetwork].id;
        const address = await router.routers(remoteChainId);
        utils.assert(address === utils.addressToBytes32(remoteRouter.address));
      }),
    );
  }

  ownables(chain: Chain): Ownable[] {
    return [this.app.getContracts(chain).router];
  }
}
