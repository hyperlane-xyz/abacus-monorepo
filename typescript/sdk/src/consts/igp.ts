import { ethers } from 'ethers';

export const TOKEN_EXCHANGE_RATE_DECIMALS_ETHEREUM = 10;

export const TOKEN_EXCHANGE_RATE_SCALE_ETHEREUM = ethers.utils.parseUnits(
  '1',
  TOKEN_EXCHANGE_RATE_DECIMALS_ETHEREUM,
);

export const TOKEN_EXCHANGE_RATE_DECIMALS_SEALEVEL = 19;

export const TOKEN_EXCHANGE_RATE_SCALE_SEALEVEL = ethers.utils.parseUnits(
  '1',
  TOKEN_EXCHANGE_RATE_DECIMALS_SEALEVEL,
);
