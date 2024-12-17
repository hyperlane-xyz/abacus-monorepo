import { ethers } from 'ethers';

import {
  ChainMap,
  HypTokenRouterConfig,
  IsmConfig,
  TokenType,
} from '@hyperlane-xyz/sdk';
import { Address } from '@hyperlane-xyz/utils';

import {
  RouterConfigWithoutOwner,
  tokens,
} from '../../../../../src/config/warp.js';

const safeOwners: ChainMap<Address> = {
  bsquared: '0x7A363efD42305BeDBA307d25351F8ea157b69A1A',
  swell: '0xC11e22A31787394950B31e2DEb1d2b5546689B65',
  boba: '0x207FfFa7325fC5d0362aB01605D84B268b61888f',
};

const proxyAdmin: ChainMap<Address> = {
  bsquared: '0x0bC57AdFD8f7Ba507DB761Bf1fbd7855de38A3E1',
  swell: '0xa8ab7DF354DD5d4bCE5856b2b4E0863A3AaeEb44',
  boba: '0xa8ab7DF354DD5d4bCE5856b2b4E0863A3AaeEb44',
};

export const getBobaBsquaredSwellUBTCWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  const ISM_CONFIG: IsmConfig = ethers.constants.AddressZero; // Use the default ISM

  const boba: HypTokenRouterConfig = {
    mailbox: routerConfig.boba.mailbox,
    owner: safeOwners.boba,
    proxyAdmin: {
      address: proxyAdmin.boba,
      owner: safeOwners.boba,
    },
    type: TokenType.synthetic,
    interchainSecurityModule: ISM_CONFIG,
  };

  const bsquared: HypTokenRouterConfig = {
    mailbox: routerConfig.bsquared.mailbox,
    owner: safeOwners.bsquared,
    proxyAdmin: {
      address: proxyAdmin.bsquared,
      owner: safeOwners.bsquared,
    },
    type: TokenType.collateral,
    token: tokens.bsquared.uBTC,
    interchainSecurityModule: ISM_CONFIG,
  };

  const swell: HypTokenRouterConfig = {
    mailbox: routerConfig.swell.mailbox,
    owner: safeOwners.swell,
    proxyAdmin: {
      address: proxyAdmin.swell,
      owner: safeOwners.swell,
    },
    type: TokenType.synthetic,
    interchainSecurityModule: ISM_CONFIG,
  };

  return {
    boba,
    bsquared,
    swell,
  };
};
