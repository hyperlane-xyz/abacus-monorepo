import { stringify as yamlStringify } from 'yaml';

import { ChainName, CoreConfig, EvmCoreModule } from '@hyperlane-xyz/sdk';

import { MINIMUM_CORE_DEPLOY_GAS } from '../consts.js';
import { WriteCommandContext } from '../context/types.js';
import { log, logBlue, logGreen } from '../logger.js';
import { runSingleChainSelectionStep } from '../utils/chains.js';
import { indentYamlOrJson } from '../utils/files.js';

import {
  completeDeploy,
  prepareDeploy,
  runDeployPlanStep,
  runPreflightChecksForChains,
} from './utils.js';

interface DeployParams {
  context: WriteCommandContext;
  chain: ChainName;
  config: CoreConfig;
}
/**
 * Executes the core deploy command.
 */
export async function runCoreDeploy({
  context,
  chain,
  config,
}: {
  context: WriteCommandContext;
  chain: ChainName;
  config: CoreConfig;
}) {
  const {
    signer,
    isDryRun,
    chainMetadata,
    dryRunChain,
    registry,
    skipConfirmation,
  } = context;

  // Select a dry-run chain if it's not supplied
  if (dryRunChain) {
    chain = dryRunChain;
  } else if (!chain) {
    if (skipConfirmation) throw new Error('No chain provided');
    chain = await runSingleChainSelectionStep(
      chainMetadata,
      'Select chain to connect:',
    );
  }
  const deploymentParams: DeployParams = {
    context,
    chain,
    config,
  };

  await runDeployPlanStep(deploymentParams);
  await runPreflightChecksForChains({
    ...deploymentParams,
    chains: [chain],
    minGas: MINIMUM_CORE_DEPLOY_GAS,
  });

  const userAddress = await signer.getAddress();

  const initialBalances = await prepareDeploy(context, userAddress, [chain]);

  logBlue('All systems ready, captain! Beginning deployment...');
  const evmCoreModule = await EvmCoreModule.create({
    chain,
    config,
    multiProvider: context.multiProvider,
  });

  await completeDeploy(context, 'core', initialBalances, userAddress, [chain]);
  const deployedAddresses = evmCoreModule.serialize();

  if (!isDryRun) {
    await registry.updateChain({
      chainName: chain,
      addresses: deployedAddresses,
    });
  }

  logGreen('✅ Core contract deployments complete:\n');
  log(indentYamlOrJson(yamlStringify(deployedAddresses, null, 2), 4));
}
