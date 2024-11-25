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
import { DEPLOYER } from '../../owners.js';

const ethereumOwner = '0x58C3FB862a4F5f038C24F8506BE378e9415c5B6C';
const ethereumOwnerConfig = getOwnerConfigForAddress(ethereumOwner);

const flowOwner = '0xa507DFccA02727B46cBdC600C57E89b2b55E5330';
const flowOwnerConfig = getOwnerConfigForAddress(flowOwner);

export const getEthereumFlowCbBTCWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
  _abacusWorksEnvOwnerConfig: ChainMap<OwnableConfig>,
): Promise<ChainMap<TokenRouterConfig>> => {
  const ethereum: TokenRouterConfig = {
    ...routerConfig.ethereum,
    ...ethereumOwnerConfig,
    type: TokenType.collateral,
    token: tokens.ethereum.cbBTC,
    interchainSecurityModule: ethers.constants.AddressZero,
  };

  const flowmainnet: TokenRouterConfig = {
    ...routerConfig.flowmainnet,
    ...flowOwnerConfig,
    type: TokenType.synthetic,
    interchainSecurityModule: ethers.constants.AddressZero,
  };

  return {
    ethereum,
    flowmainnet,
  };
};
