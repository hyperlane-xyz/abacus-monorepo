import { getRegistry } from '../../config/registry.js';
import { getWarpConfig, warpConfigGetterMap } from '../../config/warp.js';
import { getArgs, withOutputFile } from '../agent-utils.js';
import { getEnvironmentConfig, getHyperlaneCore } from '../core-utils.js';

async function main() {
  const { environment } = await withOutputFile(getArgs()).argv;
  const { multiProvider } = await getHyperlaneCore(environment);
  const envConfig = getEnvironmentConfig(environment);
  const registry = getRegistry();

  const warpIdsToCheck = Object.keys(warpConfigGetterMap);
  for (const warpRouteId of warpIdsToCheck) {
    console.log(`Generating Warp config for ${warpRouteId}`);

    const warpConfig = await getWarpConfig(
      multiProvider,
      envConfig,
      warpRouteId,
    );

    const configFileName = `${warpRouteId}-deploy-config.yaml`;
    registry.addWarpRouteConfig(warpConfig, configFileName);
    console.log(
      `Warp config successfully created at ${registry.getUri()}/${registry.getWarpRoutesPath()}/${configFileName}`,
    );
  }
}

main().catch((err) => console.error('Error:', err));
