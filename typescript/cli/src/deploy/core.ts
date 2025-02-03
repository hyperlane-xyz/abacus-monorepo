import { stringify as yamlStringify } from 'yaml';
import { z } from 'zod';

import { buildArtifact as coreBuildArtifact } from '@hyperlane-xyz/core/buildArtifact.js';
import {
  ChainMap,
  ChainName,
  ContractVerifier,
  CoreConfig,
  DeployedCoreAddresses,
  EvmCoreModule,
  ExplorerLicenseType,
} from '@hyperlane-xyz/sdk';
import { DeployedCoreAddressesSchema } from '@hyperlane-xyz/sdk';

import { MINIMUM_CORE_DEPLOY_GAS } from '../consts.js';
import { requestAndSaveApiKeys } from '../context/context.js';
import { WriteCommandContext } from '../context/types.js';
import { log, logBlue, logGray, logGreen } from '../logger.js';
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
  fix?: boolean;
  deploymentPlan?: Record<keyof DeployedCoreAddresses, boolean>;
}

interface ApplyParams extends DeployParams {
  deployedCoreAddresses: DeployedCoreAddresses;
}

/**
 * Executes the core deploy command.
 */
export async function runCoreDeploy(params: DeployParams) {
  const { context, config, fix } = params;
  let { chain } = params;

  const {
    isDryRun,
    chainMetadata,
    dryRunChain,
    registry,
    skipConfirmation,
    multiProvider,
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
  let apiKeys: ChainMap<string> = {};
  if (!skipConfirmation)
    apiKeys = await requestAndSaveApiKeys([chain], chainMetadata, registry);

  let existingAddresses: DeployedCoreAddresses | undefined;
  let deploymentPlan: Record<keyof DeployedCoreAddresses, boolean> | undefined;

  if (fix) {
    existingAddresses = (await registry.getChainAddresses(
      chain,
    )) as DeployedCoreAddresses;
    if (existingAddresses) {
      // Get required fields from the schema (those that are z.string() without .optional())
      const requiredContracts = Object.entries(
        DeployedCoreAddressesSchema.shape,
      )
        .filter(
          ([_, schema]) =>
            schema instanceof z.ZodString && !schema.isOptional(),
        )
        .map(([key]) => key) as Array<keyof DeployedCoreAddresses>;

      const missingContracts = requiredContracts.filter(
        (contract) => !existingAddresses?.[contract],
      );

      if (missingContracts.length === 0) {
        logGreen('All core contracts already deployed, nothing to do');
        process.exit(0);
      }

      // Create a deployment plan indicating which contracts need to be deployed
      deploymentPlan = Object.fromEntries(
        requiredContracts.map((contract) => [
          contract,
          !existingAddresses?.[contract], // true means needs deployment
        ]),
      ) as Record<keyof DeployedCoreAddresses, boolean>;

      logBlue(
        `Found existing core contracts, will deploy missing ones: ${missingContracts.join(
          ', ',
        )}`,
      );
    }
  }

  const signer = multiProvider.getSigner(chain);

  const deploymentParams: DeployParams = {
    context: { ...context, signer },
    chain,
    config,
    fix,
    deploymentPlan,
  };

  await runDeployPlanStep(deploymentParams);
  await runPreflightChecksForChains({
    ...deploymentParams,
    chains: [chain],
    minGas: MINIMUM_CORE_DEPLOY_GAS,
  });

  const userAddress = await signer.getAddress();

  const initialBalances = await prepareDeploy(context, userAddress, [chain]);

  const contractVerifier = new ContractVerifier(
    multiProvider,
    apiKeys,
    coreBuildArtifact,
    ExplorerLicenseType.MIT,
  );

  logBlue('🚀 All systems ready, captain! Beginning deployment...');
  const evmCoreModule = await EvmCoreModule.create({
    chain,
    config,
    multiProvider,
    contractVerifier,
    existingAddresses,
    deploymentPlan,
  } as const);

  await completeDeploy(context, 'core', initialBalances, userAddress, [chain]);
  const deployedAddresses = evmCoreModule.serialize();

  if (!isDryRun) {
    await registry.updateChain({
      chainName: chain,
      addresses: {
        ...existingAddresses,
        ...deployedAddresses,
      },
    });
  }

  logGreen('✅ Core contract deployments complete:\n');
  log(indentYamlOrJson(yamlStringify(deployedAddresses, null, 2), 4));
}

export async function runCoreApply(params: ApplyParams) {
  const { context, chain, deployedCoreAddresses, config } = params;
  const { multiProvider } = context;
  const evmCoreModule = new EvmCoreModule(multiProvider, {
    chain,
    config,
    addresses: deployedCoreAddresses,
  });

  const transactions = await evmCoreModule.update(config);

  if (transactions.length) {
    logGray('Updating deployed core contracts');
    for (const transaction of transactions) {
      await multiProvider.sendTransaction(
        // Using the provided chain id because there might be remote chain transactions included in the batch
        transaction.chainId ?? chain,
        transaction,
      );
    }

    logGreen(`Core config updated on ${chain}.`);
  } else {
    logGreen(
      `Core config on ${chain} is the same as target. No updates needed.`,
    );
  }
}
