import debug from 'debug';

import { objMap } from '@hyperlane-xyz/utils';

import { connectContracts, serializeContracts } from '../contracts/contracts';
import {
  HyperlaneAddresses,
  HyperlaneContracts,
  HyperlaneContractsMap,
  HyperlaneFactories,
} from '../contracts/types';
import { MultiProvider } from '../providers/MultiProvider';
import { ChainName } from '../types';
import { MultiGeneric } from '../utils/MultiGeneric';

export class HyperlaneApp<
  Factories extends HyperlaneFactories,
> extends MultiGeneric<HyperlaneContracts<Factories>> {
  public readonly contractsMap: HyperlaneContractsMap<Factories>;

  constructor(
    contractsMap: HyperlaneContractsMap<Factories>,
    public readonly multiProvider: MultiProvider,
    supportedChainNames?: string[],
    public readonly logger = debug('hyperlane:App'),
  ) {
    const connectedContractsMap = objMap(contractsMap, (chain, contracts) =>
      connectContracts(contracts, multiProvider.getSignerOrProvider(chain)),
    );
    super(connectedContractsMap, supportedChainNames);
    this.contractsMap = connectedContractsMap;
  }

  getContracts(chain: ChainName): HyperlaneContracts<Factories> {
    return this.get(chain);
  }

  getAddresses(chain: ChainName): HyperlaneAddresses<Factories> {
    return serializeContracts(this.get(chain));
  }
}
