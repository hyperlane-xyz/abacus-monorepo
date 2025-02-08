import {
  chainsToDeploy,
  getRenzoEZETHWarpConfigGenerator,
  getRenzoGnosisSafeBuilderStrategyConfigGenerator,
} from './getRenzoEZETHWarpConfig.js';

const xERC20: Record<(typeof chainsToDeploy)[number], string> = {
  arbitrum: '0x585afea249031Ea4168A379F664e91dFc5F77E7D',
  optimism: '0x585afea249031Ea4168A379F664e91dFc5F77E7D',
  base: '0x585afea249031Ea4168A379F664e91dFc5F77E7D',
  blast: '0x585afea249031Ea4168A379F664e91dFc5F77E7D',
  bsc: '0x585afea249031Ea4168A379F664e91dFc5F77E7D',
  mode: '0x585afea249031Ea4168A379F664e91dFc5F77E7D',
  linea: '0x5EA461E19ba6C002b7024E4A2e9CeFe79a47d3bB',
  ethereum: '0x585afea249031Ea4168A379F664e91dFc5F77E7D',
  fraxtal: '0x585afea249031Ea4168A379F664e91dFc5F77E7D',
  zircuit: '0x585afea249031Ea4168A379F664e91dFc5F77E7D',
  taiko: '0x585afea249031Ea4168A379F664e91dFc5F77E7D',
  sei: '0x585afea249031Ea4168A379F664e91dFc5F77E7D',
  swell: '0x585afea249031Ea4168A379F664e91dFc5F77E7D',
  // unichain: '0x585afea249031Ea4168A379F664e91dFc5F77E7D',
  // berachain: '0x585afea249031Ea4168A379F664e91dFc5F77E7D',
};

export const ezEthSafes: Record<(typeof chainsToDeploy)[number], string> = {
  arbitrum: '0xA9421c6F339eC414b7e77449986bE9C2Ae430C25',
  optimism: '0xA9421c6F339eC414b7e77449986bE9C2Ae430C25',
  base: '0xA9421c6F339eC414b7e77449986bE9C2Ae430C25',
  blast: '0xA9421c6F339eC414b7e77449986bE9C2Ae430C25',
  bsc: '0xA9421c6F339eC414b7e77449986bE9C2Ae430C25',
  mode: '0xf40b75fb85C3bEc70D75A1B45ef08FC48Db61115',
  linea: '0xA9421c6F339eC414b7e77449986bE9C2Ae430C25',
  ethereum: '0xA9421c6F339eC414b7e77449986bE9C2Ae430C25',
  fraxtal: '0x5B44eE67E7F880071FbB28Ec4e84B8ee3fEc1Ecf',
  zircuit: '0xf40b75fb85C3bEc70D75A1B45ef08FC48Db61115',
  taiko: '0x31FF35F84ADB120DbE089D190F03Ac74731Ae83F',
  sei: '0xa30FF77d30Eb2d785f574344B4D11CAAe1949807',
  swell: '0xf40b75fb85C3bEc70D75A1B45ef08FC48Db61115',
  // unichain: '0xa7eccdb9be08178f896c26b7bbd8c3d4e844d9ba',
  // berachain: '0xf013c8Be28421b050cca5bD95cc57Af49568e8be',
};

const xERC20StagingLockbox = '0x74c8290836612e6251E49e8f3198fdD80C4DbEB8';
export const getRenzoEZETHSTAGEWarpConfig = getRenzoEZETHWarpConfigGenerator(
  ezEthSafes,
  xERC20,
  xERC20StagingLockbox,
);

export const getRenzoGnosisSafeBuilderStagingStrategyConfig =
  getRenzoGnosisSafeBuilderStrategyConfigGenerator(ezEthSafes);
