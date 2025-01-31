import { expect } from 'chai';

import { MultiProvider } from '@hyperlane-xyz/sdk';
import { diffObjMerge } from '@hyperlane-xyz/utils';

import { getGithubRegistry } from '../config/registry.js';
import { getWarpConfig, warpConfigGetterMap } from '../config/warp.js';
import {
  getEnvironmentConfig,
  getHyperlaneCore,
} from '../scripts/core-utils.js';

const DEFAULT_TIMEOUT = 60000;
describe('Warp Configs', async function () {
  this.timeout(DEFAULT_TIMEOUT);
  const ENV = 'mainnet3';
  const warpIdsToCheck = Object.keys(warpConfigGetterMap);
  let multiProvider: MultiProvider;
  let configsFromGithub;

  before(async function () {
    multiProvider = (await getHyperlaneCore(ENV)).multiProvider;
    configsFromGithub = await getGithubRegistry().getWarpDeployConfigs();
  });

  const envConfig = getEnvironmentConfig(ENV);

  for (const warpRouteId of warpIdsToCheck) {
    it(`should match Github Registry configs for ${warpRouteId}`, async function () {
      const warpConfig = await getWarpConfig(
        multiProvider,
        envConfig,
        warpRouteId,
      );
      const { mergedObject, isInvalid } = diffObjMerge(
        warpConfig,
        configsFromGithub![warpRouteId],
      );

      if (isInvalid) {
        console.log('Differences', JSON.stringify(mergedObject, null, 2));
      }

      expect(
        isInvalid,
        `Registry config does not match Getter for ${warpRouteId}`,
      ).to.be.false;
    });
  }

  it('should throw if warpRouteId is not found in either Getter nor Registry', async function () {
    const invalidWarpIds = '1111bla-bla-bla111';
    try {
      await getWarpConfig(multiProvider, envConfig, invalidWarpIds);
    } catch (e: any) {
      expect(e.message).to.equal(
        `Warp route Config not found for ${invalidWarpIds}`,
      );
    }
  });
});
