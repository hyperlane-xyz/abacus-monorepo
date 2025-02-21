import { stringify as yamlStringify } from 'yaml';

import { WarpRouteDeployConfig, normalizeConfig } from '@hyperlane-xyz/sdk';
import { ObjectDiff, diffObjMerge } from '@hyperlane-xyz/utils';

import { log, logGreen } from '../logger.js';
import { formatYamlViolationsOutput } from '../utils/output.js';

export async function runWarpRouteCheck({
  warpRouteConfig,
  onChainWarpConfig,
}: {
  warpRouteConfig: WarpRouteDeployConfig;
  onChainWarpConfig: WarpRouteDeployConfig;
}): Promise<void> {
  // Go through each chain and only add to the output the chains that have mismatches
  const violations: { [key: string]: ObjectDiff } = {}; // Improved: Declared a specific type for violations
  let isInvalid = false; // Improved: Initialized isInvalid separately
     for (const chain of Object.keys(warpRouteConfig)) {
       const { mergedObject, isInvalid: currentIsInvalid } = diffObjMerge(
        normalizeConfig(onChainWarpConfig[chain]),
        normalizeConfig(warpRouteConfig[chain]),
      );

      if (isInvalid) {
        acc[0][chain] = mergedObject;
        acc[1] ||= isInvalid;
      }

      return acc;
    },
    [{}, false] as [{ [index: string]: ObjectDiff }, boolean],
  );

  if (isInvalid) {
    log(formatYamlViolationsOutput(yamlStringify(violations, null, 2)));
    process.exit(1);
  }

  logGreen(`No violations found`);
}
