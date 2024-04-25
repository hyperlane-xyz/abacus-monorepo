import { confirm, input } from '@inquirer/prompts';
import { ethers } from 'ethers';

import {
  TokenType,
  WarpRouteDeployConfig,
  WarpRouteDeployConfigSchema,
} from '@hyperlane-xyz/sdk';

import { errorRed, logBlue, logGreen } from '../logger.js';
import {
  runMultiChainSelectionStep,
  runSingleChainSelectionStep,
} from '../utils/chains.js';
import { FileFormat, readYamlOrJson, writeYamlOrJson } from '../utils/files.js';

import { readChainConfigsIfExists } from './chain.js';

export function readWarpRouteDeployConfig(filePath: string) {
  const config = readYamlOrJson(filePath);
  if (!config)
    throw new Error(`No warp route deploy config found at ${filePath}`);
  const result = WarpRouteDeployConfigSchema.safeParse(config);
  if (!result.success) {
    const firstIssue = result.error.issues[0];
    throw new Error(
      `Invalid warp config: ${firstIssue.path} => ${firstIssue.message}`,
    );
  }
  return result.data;
}

export function isValidWarpRouteDeployConfig(config: any) {
  return WarpRouteDeployConfigSchema.safeParse(config).success;
}

export async function createWarpRouteDeployConfig({
  format,
  outPath,
  chainConfigPath,
}: {
  format: FileFormat;
  outPath: string;
  chainConfigPath: string;
}) {
  logBlue('Creating a new warp route deployment config');
  const customChains = readChainConfigsIfExists(chainConfigPath);
  const baseChain = await runSingleChainSelectionStep(
    customChains,
    'Select base chain with the original token to warp',
  );

  const isNative = await confirm({
    message:
      'Are you creating a route for the native token of the base chain (e.g. Ether on Ethereum)?',
  });

  const isNft = isNative
    ? false
    : await confirm({ message: 'Is this an NFT (i.e. ERC-721)?' });
  const isYieldBearing =
    isNative || isNft
      ? false
      : await confirm({
          message:
            'Do you want this warp route to be yield-bearing (i.e. deposits into ERC-4626 vault)?',
        });

  const addressMessage = `Enter the ${
    isYieldBearing ? 'ERC-4626 vault' : 'collateral token'
  } address`;
  const baseAddress = isNative
    ? ethers.constants.AddressZero
    : await input({ message: addressMessage });

  const syntheticChains = await runMultiChainSelectionStep(
    customChains,
    'Select chains to which the base token will be connected',
  );

  // TODO add more prompts here to support customizing the token metadata
  let result: WarpRouteDeployConfig;
  if (isNative) {
    result = {
      [baseChain]: {
        type: TokenType.native,
      },
    };
  } else {
    result = {
      [baseChain]: {
        type: isYieldBearing ? TokenType.collateralVault : TokenType.collateral,
        token: baseAddress,
        isNft,
      },
    };
  }

  syntheticChains.map((chain) => {
    result[chain] = {
      type: TokenType.synthetic,
    };
  });

  if (isValidWarpRouteDeployConfig(result)) {
    logGreen(`Warp Route config is valid, writing to file ${outPath}`);
    writeYamlOrJson(outPath, result, format);
  } else {
    errorRed(
      `Warp route deployment config is invalid, please see https://github.com/hyperlane-xyz/hyperlane-monorepo/blob/main/typescript/cli/examples/warp-route-deployment.yaml for an example`,
    );
    throw new Error('Invalid multisig config');
  }
}
