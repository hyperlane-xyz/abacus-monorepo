import { ethers } from 'ethers';

import {
  ChainMap,
  OwnableConfig,
  TokenRouterConfig,
  TokenType,
} from '@hyperlane-xyz/sdk';

import { getOwnerConfigForAddress } from '../../../../../src/config/environment.js';
import {
  RouterConfigWithoutOwner,
  tokens,
} from '../../../../../src/config/warp.js';

// MEV Capital
const arbitrumOwner = '0x008615770B588633265cB01Abd19740fAe67d0B9';
const ethereumOwner = '0x008615770B588633265cB01Abd19740fAe67d0B9';
const zircuitOwner = '0xD0673e7F3FB4037CA79F53d2d311D0e017d39963';

export const getArbitrumEthereumZircuitAmphrETHWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
  _abacusWorksEnvOwnerConfig: ChainMap<OwnableConfig>,
): Promise<ChainMap<TokenRouterConfig>> => {
  const arbitrum: TokenRouterConfig = {
    ...routerConfig.arbitrum,
    ...getOwnerConfigForAddress(arbitrumOwner),
    type: TokenType.synthetic,
    interchainSecurityModule: ethers.constants.AddressZero,
  };

  const ethereum: TokenRouterConfig = {
    ...routerConfig.ethereum,
    ...getOwnerConfigForAddress(ethereumOwner),
    type: TokenType.collateral,
    token: tokens.ethereum.amphrETH,
    owner: ethereumOwner,
    interchainSecurityModule: ethers.constants.AddressZero,
    ownerOverrides: {
      proxyAdmin: ethereumOwner,
    },
  };

  const zircuit: TokenRouterConfig = {
    ...routerConfig.zircuit,
    ...getOwnerConfigForAddress(zircuitOwner),
    type: TokenType.synthetic,
    interchainSecurityModule: ethers.constants.AddressZero,
  };

  return {
    arbitrum,
    ethereum,
    zircuit,
  };
};
