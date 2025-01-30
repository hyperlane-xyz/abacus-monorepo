import {
  chainsToDeploy,
  getRenzoEZETHWarpConfigGenerator,
} from './getRenzoEZETHWarpConfig.js';

// TODO: Deploy xERC20
const xERC20: Record<(typeof chainsToDeploy)[number], string> = {
  arbitrum: '0x2416092f143378750bb29b79eD961ab195CcEea5',
  optimism: '0x2416092f143378750bb29b79eD961ab195CcEea5',
  base: '0x2416092f143378750bb29b79eD961ab195CcEea5',
  blast: '0x2416092f143378750bb29b79eD961ab195CcEea5',
  bsc: '0x2416092f143378750bb29b79eD961ab195CcEea5',
  mode: '0x2416092f143378750bb29b79eD961ab195CcEea5',
  linea: '0x2416092f143378750bb29b79eD961ab195CcEea5',
  ethereum: '0x2416092f143378750bb29b79eD961ab195CcEea5',
  fraxtal: '0x2416092f143378750bb29b79eD961ab195CcEea5',
  zircuit: '0x2416092f143378750bb29b79eD961ab195CcEea5',
  taiko: '0x2416092f143378750bb29b79eD961ab195CcEea5',
  sei: '0x6DCfbF4729890043DFd34A93A2694E5303BA2703', // redEth
  swell: '0x2416092f143378750bb29b79eD961ab195CcEea5',
};

export const ezEthSafes: Record<string, string> = {
  arbitrum: '0xA9421c6F339eC414b7e77449986bE9C2Ae430C25',
  optimism: '0xA9421c6F339eC414b7e77449986bE9C2Ae430C25',
  base: '0xA9421c6F339eC414b7e77449986bE9C2Ae430C25',
  blast: '0xA9421c6F339eC414b7e77449986bE9C2Ae430C25',
  bsc: '0xA9421c6F339eC414b7e77449986bE9C2Ae430C25',
  mode: '0xf40b75fb85C3bEc70D75A1B45ef08FC48Db61115',
  linea: '0xA9421c6F339eC414b7e77449986bE9C2Ae430C25',
  ethereum: '0xA9421c6F339eC414b7e77449986bE9C2Ae430C25',
  fraxtal: '0xf40b75fb85C3bEc70D75A1B45ef08FC48Db61115',
  zircuit: '0xf40b75fb85C3bEc70D75A1B45ef08FC48Db61115',
  taiko: '0x31FF35F84ADB120DbE089D190F03Ac74731Ae83F',
  sei: '0xa30FF77d30Eb2d785f574344B4D11CAAe1949807',
  swell: '0xf40b75fb85C3bEc70D75A1B45ef08FC48Db61115',
};

export const getRenzoEZETHWarpStagingConfig = getRenzoEZETHWarpConfigGenerator(
  ezEthSafes,
  xERC20,
);
