import { ethers } from 'ethers';

import { ChainMap, TokenRouterConfig, TokenType } from '@hyperlane-xyz/sdk';

import { tokens } from '../../../../../src/config/warp.js';
import { getRegistry as getMainnet3Registry } from '../../chains.js';
import { DEPLOYER } from '../../owners.js';

export const getEclipseEthereumWBTCWarpConfig = async (): Promise<
  ChainMap<TokenRouterConfig>
> => {
  const registry = await getMainnet3Registry();

  // @ts-ignore - foreignDeployment configs don't conform to the TokenRouterConfig
  const eclipsemainnet: TokenRouterConfig = {
    type: TokenType.synthetic,
    foreignDeployment: 'A7EGCDYFw5R7Jfm6cYtKvY8dmkrYMgwRCJFkyQwpHTYu',
    gas: 300_000,
    mailbox: (await registry.getChainAddresses('eclipsemainnet'))!.mailbox,
    owner: '9bRSUPjfS3xS6n5EfkJzHFTRDa4AHLda8BU2pP4HoWnf',
    interchainSecurityModule: ethers.constants.AddressZero,
  };
  let ethereum: TokenRouterConfig = {
    isNft: false,
    type: TokenType.collateral,
    token: tokens.ethereum.WBTC,
    owner: DEPLOYER,
    gas: 300_000,
    mailbox: (await registry.getChainAddresses('ethereum'))!.mailbox,
    interchainSecurityModule: ethers.constants.AddressZero,
  };

  return {
    eclipsemainnet,
    ethereum,
  };
};
