import {
  ChainMap,
  MultiProvider,
  RouterConfig,
  TokenRouterConfig,
} from '@hyperlane-xyz/sdk';

import {
  EnvironmentConfig,
  getRouterConfigsForAllVms,
} from '../src/config/environment.js';

import { getAncient8EthereumUSDCWarpConfig } from './environments/mainnet3/warp/configGetters/getAncient8EthereumUSDCWarpConfig.js';
import { getArbitrumBaseBlastBscEthereumGnosisMantleModeOptimismPolygonScrollZeroNetworkZoraMainnetETHWarpConfig } from './environments/mainnet3/warp/configGetters/getArbitrumBaseBlastBscEthereumGnosisMantleModeOptimismPolygonScrollZeroNetworkZoraMainnetETHWarpConfig.js';
import { getArbitrumBaseEthereumOptimismPolygonZeroNetworkUSDC } from './environments/mainnet3/warp/configGetters/getArbitrumBaseEthereumOptimismPolygonZeroNetworkUSDCWarpConfig.js';
import { getArbitrumBscEthereumMantleModePolygonScrollZeroNetworkUSDTWarpConfig } from './environments/mainnet3/warp/configGetters/getArbitrumBscEthereumMantleModePolygonScrollZeronetworkUSDTWarpConfig.js';
import { getArbitrumEthereumZircuitAmphrETHWarpConfig } from './environments/mainnet3/warp/configGetters/getArbitrumEthereumZircuitAmphrETHWarpConfig.js';
import { getArbitrumNeutronEclipWarpConfig } from './environments/mainnet3/warp/configGetters/getArbitrumNeutronEclipWarpConfig.js';
import { getArbitrumNeutronTiaWarpConfig } from './environments/mainnet3/warp/configGetters/getArbitrumNeutronTiaWarpConfig.js';
import { getBaseZeroNetworkCBBTCWarpConfig } from './environments/mainnet3/warp/configGetters/getBaseZeroNetworkCBBTCWarpConfig.js';
import { getEclipseEthereumSolanaUSDTWarpConfig } from './environments/mainnet3/warp/configGetters/getEclipseEthereumSolanaUSDTWarpConfig.js';
import { getEclipseEthereumWBTCWarpConfig } from './environments/mainnet3/warp/configGetters/getEclipseEthereumWBTCWarpConfig.js';
import { getEclipseEthereumWeEthsWarpConfig } from './environments/mainnet3/warp/configGetters/getEclipseEthereumWeETHsWarpConfig.js';
import { getEclipseStrideTiaWarpConfig } from './environments/mainnet3/warp/configGetters/getEclipseStrideSTTIAWarpConfig.js';
import { getEclipseStrideStTiaWarpConfig } from './environments/mainnet3/warp/configGetters/getEclipseStrideTIAWarpConfig.js';
import { getEthereumBscLUMIAWarpConfig } from './environments/mainnet3/warp/configGetters/getEthereumBscLumiaLUMIAWarpConfig.js';
import { getEthereumInevmUSDCWarpConfig } from './environments/mainnet3/warp/configGetters/getEthereumInevmUSDCWarpConfig.js';
import { getEthereumInevmUSDTWarpConfig } from './environments/mainnet3/warp/configGetters/getEthereumInevmUSDTWarpConfig.js';
import { getEthereumSeiFastUSDWarpConfig } from './environments/mainnet3/warp/configGetters/getEthereumSeiFastUSDWarpConfig.js';
import { getEthereumVictionETHWarpConfig } from './environments/mainnet3/warp/configGetters/getEthereumVictionETHWarpConfig.js';
import { getEthereumVictionUSDCWarpConfig } from './environments/mainnet3/warp/configGetters/getEthereumVictionUSDCWarpConfig.js';
import { getEthereumVictionUSDTWarpConfig } from './environments/mainnet3/warp/configGetters/getEthereumVictionUSDTWarpConfig.js';
import { getInevmInjectiveINJWarpConfig } from './environments/mainnet3/warp/configGetters/getInevmInjectiveINJWarpConfig.js';
import { getMantapacificNeutronTiaWarpConfig } from './environments/mainnet3/warp/configGetters/getMantapacificNeutronTiaWarpConfig.js';
import { getRenzoEZETHWarpConfig } from './environments/mainnet3/warp/configGetters/getRenzoEZETHWarpConfig.js';
import { getRenzoPZETHWarpConfig } from './environments/mainnet3/warp/configGetters/getRenzoPZETHWarpConfig.js';
import { WarpRouteIds } from './environments/mainnet3/warp/warpIds.js';

type WarpConfigGetterWithConfig = (
  routerConfig: ChainMap<RouterConfig>,
) => Promise<ChainMap<TokenRouterConfig>>;

type WarpConfigGetterWithoutConfig = () => Promise<ChainMap<TokenRouterConfig>>;

export const warpConfigGetterMap: Record<
  string,
  WarpConfigGetterWithConfig | WarpConfigGetterWithoutConfig
> = {
  [WarpRouteIds.Ancient8EthereumUSDC]: getAncient8EthereumUSDCWarpConfig,
  [WarpRouteIds.ArbitrumEthereumZircuitAMPHRETH]:
    getArbitrumEthereumZircuitAmphrETHWarpConfig,
  [WarpRouteIds.EthereumInevmUSDC]: getEthereumInevmUSDCWarpConfig,
  [WarpRouteIds.EthereumInevmUSDT]: getEthereumInevmUSDTWarpConfig,
  [WarpRouteIds.ArbitrumNeutronEclip]: getArbitrumNeutronEclipWarpConfig,
  [WarpRouteIds.ArbitrumNeutronTIA]: getArbitrumNeutronTiaWarpConfig,
  [WarpRouteIds.ArbitrumBaseBlastBscEthereumFraxtalLineaModeOptimismSeiTaikoZircuitEZETH]:
    getRenzoEZETHWarpConfig,
  [WarpRouteIds.InevmInjectiveINJ]: getInevmInjectiveINJWarpConfig,
  [WarpRouteIds.EthereumSeiFastUSD]: getEthereumSeiFastUSDWarpConfig,
  [WarpRouteIds.EthereumVictionETH]: getEthereumVictionETHWarpConfig,
  [WarpRouteIds.EthereumVictionUSDC]: getEthereumVictionUSDCWarpConfig,
  [WarpRouteIds.EthereumVictionUSDT]: getEthereumVictionUSDTWarpConfig,
  [WarpRouteIds.EthereumZircuitPZETH]: getRenzoPZETHWarpConfig,
  [WarpRouteIds.EthereumBscLumiaLUMIA]: getEthereumBscLUMIAWarpConfig,
  [WarpRouteIds.MantapacificNeutronTIA]: getMantapacificNeutronTiaWarpConfig,
  [WarpRouteIds.EclipseStrideTIA]: getEclipseStrideTiaWarpConfig,
  [WarpRouteIds.EclipseStrideSTTIA]: getEclipseStrideStTiaWarpConfig,
  [WarpRouteIds.EclipseEthereumSolanaUSDT]:
    getEclipseEthereumSolanaUSDTWarpConfig,
  [WarpRouteIds.EclipseEthereumWBTC]: getEclipseEthereumWBTCWarpConfig,
  [WarpRouteIds.EclipseEthereumWeETHs]: getEclipseEthereumWeEthsWarpConfig,
  [WarpRouteIds.BaseZeroNetworkCBBTC]: getBaseZeroNetworkCBBTCWarpConfig,
  [WarpRouteIds.ArbitrumBscEthereumMantleModePolygonScrollZeroNetworkUSDT]:
    getArbitrumBscEthereumMantleModePolygonScrollZeroNetworkUSDTWarpConfig,
  [WarpRouteIds.ArbitrumBaseEthereumLiskOptimismPolygonZeroNetworkUSDC]:
    getArbitrumBaseEthereumOptimismPolygonZeroNetworkUSDC,
  [WarpRouteIds.ArbitrumBaseBlastBscEthereumGnosisLiskMantleModeOptimismPolygonScrollZeroNetworkZoraMainnet]:
    getArbitrumBaseBlastBscEthereumGnosisMantleModeOptimismPolygonScrollZeroNetworkZoraMainnetETHWarpConfig,
};

export async function getWarpConfig(
  multiProvider: MultiProvider,
  envConfig: EnvironmentConfig,
  warpRouteId: string,
): Promise<ChainMap<TokenRouterConfig>> {
  const routerConfig = await getRouterConfigsForAllVms(
    envConfig,
    multiProvider,
  );

  const warpConfigGetter = warpConfigGetterMap[warpRouteId];
  if (!warpConfigGetter) {
    throw new Error(
      `Unknown warp route: ${warpRouteId}, must be one of: ${Object.keys(
        warpConfigGetterMap,
      ).join(', ')}`,
    );
  }

  if (warpConfigGetter.length === 1) {
    return warpConfigGetter(routerConfig);
  } else {
    return (warpConfigGetter as WarpConfigGetterWithoutConfig)();
  }
}
