import { expect } from 'chai';

import {
  AbacusApp,
  ChainName,
  RouterContracts,
  chainMetadata,
} from '@abacus-network/sdk';
import { utils } from '@abacus-network/utils';

import { AbacusAppChecker, Ownable } from '../check';

import { RouterConfig } from './types';

export class AbacusRouterChecker<
  Chain extends ChainName,
  App extends AbacusApp<RouterContracts, Chain>,
  Config extends RouterConfig,
> extends AbacusAppChecker<Chain, App, Config> {
  checkOwnership(chain: Chain) {
    const owner = this.configMap[chain].owner;
    const ownables = this.ownables(chain);
    return AbacusAppChecker.checkOwnership(owner, ownables);
  }

  async checkChain(chain: Chain): Promise<void> {
    await this.checkEnrolledRouters(chain);
    await this.checkOwnership(chain);
    await this.checkAbacusConnectionManager(chain);
  }

  async checkEnrolledRouters(chain: Chain): Promise<void> {
    const router = this.app.getContracts(chain).router;

    await Promise.all(
      this.app.remoteChains(chain).map(async (remoteNetwork) => {
        const remoteRouter = this.app.getContracts(remoteNetwork).router;
        const remoteChainId = chainMetadata[remoteNetwork].id;
        expect(await router.routers(remoteChainId)).to.equal(
          utils.addressToBytes32(remoteRouter.address),
        );
      }),
    );
  }

  ownables(chain: Chain): Ownable[] {
    const contracts = this.app.getContracts(chain);
    const ownables: Ownable[] = [contracts.router];
    const config = this.configMap[chain];
    // If the config specifies that an abacusConnectionManager should have been deployed,
    // it should be owned by the owner.
    if (config.abacusConnectionManager && contracts.abacusConnectionManager) {
      ownables.push(contracts.abacusConnectionManager);
    }
    return ownables;
  }

  async checkAbacusConnectionManager(chain: Chain): Promise<void> {
    const config = this.configMap[chain];
    const contracts = this.app.getContracts(chain);
    if (!config.abacusConnectionManager || !contracts.abacusConnectionManager) {
      return;
    }
    const actual = contracts.abacusConnectionManager.address;
    expect(actual).to.equal(config.abacusConnectionManager);
  }
}
