import { Inbox } from '@abacus-network/core';

import { AbacusApp } from '../app';
import { domains } from '../domains';
import { ChainName, NameOrDomain } from '../types';

import { CoreContractAddresses, CoreContracts } from './contracts';

export class AbacusCore extends AbacusApp<
  CoreContractAddresses,
  CoreContracts
> {
  constructor(addresses: Partial<Record<ChainName, CoreContractAddresses>>) {
    super();
    const chains = Object.keys(addresses) as ChainName[];
    chains.map((chain) => {
      this.registerDomain(domains[chain]);
      const domain = this.resolveDomain(chain);
      this.contracts.set(domain, new CoreContracts(addresses[chain]!));
    });
  }

  mustGetInbox(src: NameOrDomain, dest: NameOrDomain): Inbox {
    const contracts = this.mustGetContracts(dest);
    const srcName = this.mustGetDomain(src).name;
    return contracts.inbox(srcName);
  }
}
