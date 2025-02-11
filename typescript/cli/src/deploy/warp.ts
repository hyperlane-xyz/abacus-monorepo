import { confirm } from '@inquirer/prompts';
import { groupBy } from 'lodash-es';
import { stringify as yamlStringify } from 'yaml';

import { ProxyAdmin__factory } from '@hyperlane-xyz/core';
import { buildArtifact as coreBuildArtifact } from '@hyperlane-xyz/core/buildArtifact.js';
import { AddWarpRouteOptions, ChainAddresses } from '@hyperlane-xyz/registry';
import {
  AggregationIsmConfig,
  AnnotatedEV5Transaction,
  ChainMap,
  ChainName,
  ChainSubmissionStrategy,
  ChainSubmissionStrategySchema,
  ContractVerifier,
  DestinationGas,
  EvmERC20WarpModule,
  EvmHookModule,
  EvmIsmModule,
  ExplorerLicenseType,
  HookConfig,
  HypERC20Deployer,
  HypERC20Factories,
  HypERC721Deployer,
  HypERC721Factories,
  HypTokenRouterConfig,
  HyperlaneContracts,
  HyperlaneContractsMap,
  HyperlaneProxyFactoryDeployer,
  IsmConfig,
  IsmType,
  MultiProvider,
  MultisigIsmConfig,
  OpStackIsmConfig,
  PausableIsmConfig,
  RemoteRouters,
  RoutingIsmConfig,
  SubmissionStrategy,
  TOKEN_TYPE_TO_STANDARD,
  TokenFactories,
  TrustedRelayerIsmConfig,
  TxSubmitterBuilder,
  TxSubmitterType,
  WarpCoreConfig,
  WarpCoreConfigSchema,
  WarpRouteDeployConfig,
  WarpRouteDeployConfigSchema,
  attachContractsMap,
  connectContractsMap,
  gasOverhead,
  getTokenConnectionId,
  hypERC20factories,
  isCollateralTokenConfig,
  isTokenMetadata,
} from '@hyperlane-xyz/sdk';
import {
  Address,
  ProtocolType,
  assert,
  objKeys,
  objMap,
  promiseObjAll,
  retryAsync,
} from '@hyperlane-xyz/utils';

import { readWarpRouteDeployConfig } from '../config/warp.js';
import { MINIMUM_WARP_DEPLOY_GAS } from '../consts.js';
import { requestAndSaveApiKeys } from '../context/context.js';
import { WriteCommandContext } from '../context/types.js';
import { log, logBlue, logGray, logGreen, logTable } from '../logger.js';
import { getSubmitterBuilder } from '../submit/submit.js';
import {
  indentYamlOrJson,
  isFile,
  readYamlOrJson,
  runFileSelectionStep,
  writeYamlOrJson,
} from '../utils/files.js';

import {
  completeDeploy,
  prepareDeploy,
  runPreflightChecksForChains,
} from './utils.js';

interface DeployParams {
  context: WriteCommandContext;
  warpDeployConfig: WarpRouteDeployConfig;
}

interface WarpApplyParams extends DeployParams {
  warpCoreConfig: WarpCoreConfig;
  strategyUrl?: string;
  receiptsDir: string;
}

export async function runWarpRouteDeploy({
  context,
  warpRouteDeploymentConfigPath,
}: {
  context: WriteCommandContext;
  warpRouteDeploymentConfigPath?: string;
}) {
  const { skipConfirmation, chainMetadata, registry } = context;

  if (
    !warpRouteDeploymentConfigPath ||
    !isFile(warpRouteDeploymentConfigPath)
  ) {
    if (skipConfirmation)
      throw new Error('Warp route deployment config required');
    warpRouteDeploymentConfigPath = await runFileSelectionStep(
      './configs',
      'Warp route deployment config',
      'warp',
    );
  } else {
    log(
      `Using warp route deployment config at ${warpRouteDeploymentConfigPath}`,
    );
  }
  const warpRouteConfig = await readWarpRouteDeployConfig(
    warpRouteDeploymentConfigPath,
    context,
  );

  const chains = Object.keys(warpRouteConfig);

  let apiKeys: ChainMap<string> = {};
  if (!skipConfirmation)
    apiKeys = await requestAndSaveApiKeys(chains, chainMetadata, registry);

  const deploymentParams = {
    context,
    warpDeployConfig: warpRouteConfig,
  };

  await runDeployPlanStep(deploymentParams);

  // Some of the below functions throw if passed non-EVM chains
  const ethereumChains = chains.filter(
    (chain) => chainMetadata[chain].protocol === ProtocolType.Ethereum,
  );

  await runPreflightChecksForChains({
    context,
    chains: ethereumChains,
    minGas: MINIMUM_WARP_DEPLOY_GAS,
  });

  const initialBalances = await prepareDeploy(context, null, ethereumChains);

  const deployedContracts = await executeDeploy(deploymentParams, apiKeys);

  const { warpCoreConfig, addWarpRouteOptions } = await getWarpCoreConfig(
    deploymentParams,
    deployedContracts,
  );

  await writeDeploymentArtifacts(warpCoreConfig, context, addWarpRouteOptions);

  await completeDeploy(context, 'warp', initialBalances, null, ethereumChains!);
}

async function runDeployPlanStep({ context, warpDeployConfig }: DeployParams) {
  const { skipConfirmation } = context;

  displayWarpDeployPlan(warpDeployConfig);

  if (skipConfirmation || context.isDryRun) return;

  const isConfirmed = await confirm({
    message: 'Is this deployment plan correct?',
  });
  if (!isConfirmed) throw new Error('Deployment cancelled');
}

async function executeDeploy(
  params: DeployParams,
  apiKeys: ChainMap<string>,
): Promise<HyperlaneContractsMap<HypERC20Factories | HypERC721Factories>> {
  logBlue('🚀 All systems ready, captain! Beginning deployment...');

  const {
    warpDeployConfig,
    context: { multiProvider, isDryRun, dryRunChain },
  } = params;

  const deployer = warpDeployConfig.isNft
    ? new HypERC721Deployer(multiProvider)
    : new HypERC20Deployer(multiProvider); // TODO: replace with EvmERC20WarpModule

  const config: WarpRouteDeployConfig =
    isDryRun && dryRunChain
      ? { [dryRunChain]: warpDeployConfig[dryRunChain] }
      : warpDeployConfig;

  const contractVerifier = new ContractVerifier(
    multiProvider,
    apiKeys,
    coreBuildArtifact,
    ExplorerLicenseType.MIT,
  );

  const ismFactoryDeployer = new HyperlaneProxyFactoryDeployer(
    multiProvider,
    contractVerifier,
  );

  // For each chain in WarpRouteConfig, deploy each Ism Factory, if it's not in the registry
  // Then return a modified config with the ism and/or hook address as a string
  const modifiedConfig = await resolveWarpIsmAndHook(
    config,
    params.context,
    ismFactoryDeployer,
    contractVerifier,
  );

  const deployedContracts = await deployer.deploy(modifiedConfig);

  logGreen('✅ Warp contract deployments complete');
  return deployedContracts;
}

async function writeDeploymentArtifacts(
  warpCoreConfig: WarpCoreConfig,
  context: WriteCommandContext,
  addWarpRouteOptions?: AddWarpRouteOptions,
) {
  if (!context.isDryRun) {
    log('Writing deployment artifacts...');
    await context.registry.addWarpRoute(warpCoreConfig, addWarpRouteOptions);
  }
  log(indentYamlOrJson(yamlStringify(warpCoreConfig, null, 2), 4));
}

async function resolveWarpIsmAndHook(
  warpConfig: WarpRouteDeployConfig,
  context: WriteCommandContext,
  ismFactoryDeployer: HyperlaneProxyFactoryDeployer,
  contractVerifier?: ContractVerifier,
): Promise<WarpRouteDeployConfig> {
  return promiseObjAll(
    objMap(warpConfig, async (chain, config) => {
      const chainAddresses = await context.registry.getChainAddresses(chain);

      if (!chainAddresses) {
        throw `Registry factory addresses not found for ${chain}.`;
      }

      config.interchainSecurityModule = await createWarpIsm({
        chain,
        chainAddresses,
        context,
        contractVerifier,
        ismFactoryDeployer,
        warpConfig: config,
      }); // TODO write test

      config.hook = await createWarpHook({
        chain,
        chainAddresses,
        context,
        contractVerifier,
        ismFactoryDeployer,
        warpConfig: config,
      });
      return config;
    }),
  );
}

/**
 * Deploys the Warp ISM for a given config
 *
 * @returns The deployed ism address
 */
async function createWarpIsm({
  chain,
  chainAddresses,
  context,
  contractVerifier,
  warpConfig,
}: {
  chain: string;
  chainAddresses: Record<string, string>;
  context: WriteCommandContext;
  contractVerifier?: ContractVerifier;
  warpConfig: HypTokenRouterConfig;
  ismFactoryDeployer: HyperlaneProxyFactoryDeployer;
}): Promise<IsmConfig | undefined> {
  const { interchainSecurityModule } = warpConfig;
  if (
    !interchainSecurityModule ||
    typeof interchainSecurityModule === 'string'
  ) {
    logGray(
      `Config Ism is ${
        !interchainSecurityModule ? 'empty' : interchainSecurityModule
      }, skipping deployment.`,
    );
    return interchainSecurityModule;
  }

  logBlue(`Loading registry factory addresses for ${chain}...`);

  logGray(
    `Creating ${interchainSecurityModule.type} ISM for token on ${chain} chain...`,
  );

  logGreen(
    `Finished creating ${interchainSecurityModule.type} ISM for token on ${chain} chain.`,
  );

  const {
    mailbox,
    domainRoutingIsmFactory,
    staticAggregationHookFactory,
    staticAggregationIsmFactory,
    staticMerkleRootMultisigIsmFactory,
    staticMessageIdMultisigIsmFactory,
    staticMerkleRootWeightedMultisigIsmFactory,
    staticMessageIdWeightedMultisigIsmFactory,
  } = chainAddresses;
  const evmIsmModule = await EvmIsmModule.create({
    chain,
    mailbox,
    multiProvider: context.multiProvider,
    proxyFactoryFactories: {
      domainRoutingIsmFactory,
      staticAggregationHookFactory,
      staticAggregationIsmFactory,
      staticMerkleRootMultisigIsmFactory,
      staticMessageIdMultisigIsmFactory,
      staticMerkleRootWeightedMultisigIsmFactory,
      staticMessageIdWeightedMultisigIsmFactory,
    },
    config: interchainSecurityModule,
    contractVerifier,
  });
  const { deployedIsm } = evmIsmModule.serialize();
  return deployedIsm;
}

async function createWarpHook({
  chain,
  chainAddresses,
  context,
  contractVerifier,
  warpConfig,
}: {
  chain: string;
  chainAddresses: Record<string, string>;
  context: WriteCommandContext;
  contractVerifier?: ContractVerifier;
  warpConfig: HypTokenRouterConfig;
  ismFactoryDeployer: HyperlaneProxyFactoryDeployer;
}): Promise<HookConfig | undefined> {
  const { hook } = warpConfig;

  if (!hook || typeof hook === 'string') {
    logGray(`Config Hook is ${!hook ? 'empty' : hook}, skipping deployment.`);
    return hook;
  }

  logBlue(`Loading registry factory addresses for ${chain}...`);

  logGray(`Creating ${hook.type} Hook for token on ${chain} chain...`);

  const {
    mailbox,
    domainRoutingIsmFactory,
    staticAggregationHookFactory,
    staticAggregationIsmFactory,
    staticMerkleRootMultisigIsmFactory,
    staticMessageIdMultisigIsmFactory,
    staticMerkleRootWeightedMultisigIsmFactory,
    staticMessageIdWeightedMultisigIsmFactory,
  } = chainAddresses;
  const proxyFactoryFactories = {
    domainRoutingIsmFactory,
    staticAggregationHookFactory,
    staticAggregationIsmFactory,
    staticMerkleRootMultisigIsmFactory,
    staticMessageIdMultisigIsmFactory,
    staticMerkleRootWeightedMultisigIsmFactory,
    staticMessageIdWeightedMultisigIsmFactory,
  };

  // If config.proxyadmin.address exists, then use that. otherwise deploy a new proxyAdmin
  const proxyAdminAddress: Address =
    warpConfig.proxyAdmin?.address ??
    (
      await context.multiProvider.handleDeploy(
        chain,
        new ProxyAdmin__factory(),
        [],
      )
    ).address;

  const evmHookModule = await EvmHookModule.create({
    chain,
    multiProvider: context.multiProvider,
    coreAddresses: {
      mailbox,
      proxyAdmin: proxyAdminAddress,
    },
    config: hook,
    contractVerifier,
    proxyFactoryFactories,
  });
  logGreen(`Finished creating ${hook.type} Hook for token on ${chain} chain.`);
  const { deployedHook } = evmHookModule.serialize();
  return deployedHook;
}

async function getWarpCoreConfig(
  params: DeployParams,
  contracts: HyperlaneContractsMap<TokenFactories>,
): Promise<{
  warpCoreConfig: WarpCoreConfig;
  addWarpRouteOptions?: AddWarpRouteOptions;
}> {
  const warpCoreConfig: WarpCoreConfig = { tokens: [] };

  // TODO: replace with warp read
  const tokenMetadata = await HypERC20Deployer.deriveTokenMetadata(
    params.context.multiProvider,
    params.warpDeployConfig,
  );
  assert(
    tokenMetadata && isTokenMetadata(tokenMetadata),
    'Missing required token metadata',
  );
  const { decimals, symbol, name } = tokenMetadata;
  assert(decimals, 'Missing decimals on token metadata');

  generateTokenConfigs(
    warpCoreConfig,
    params.warpDeployConfig,
    contracts,
    symbol,
    name,
    decimals,
  );

  fullyConnectTokens(warpCoreConfig);

  return { warpCoreConfig, addWarpRouteOptions: { symbol } };
}

/**
 * Creates token configs.
 */
function generateTokenConfigs(
  warpCoreConfig: WarpCoreConfig,
  warpDeployConfig: WarpRouteDeployConfig,
  contracts: HyperlaneContractsMap<TokenFactories>,
  symbol: string,
  name: string,
  decimals: number,
): void {
  for (const [chainName, contract] of Object.entries(contracts)) {
    const config = warpDeployConfig[chainName];
    const collateralAddressOrDenom = isCollateralTokenConfig(config)
      ? config.token // gets set in the above deriveTokenMetadata()
      : undefined;

    warpCoreConfig.tokens.push({
      chainName,
      standard: TOKEN_TYPE_TO_STANDARD[config.type],
      decimals,
      symbol: config.symbol || symbol,
      name,
      addressOrDenom:
        contract[warpDeployConfig[chainName].type as keyof TokenFactories]
          .address,
      collateralAddressOrDenom,
    });
  }
}

/**
 * Adds connections between tokens.
 *
 * Assumes full interconnectivity between all tokens for now b.c. that's
 * what the deployers do by default.
 */
function fullyConnectTokens(warpCoreConfig: WarpCoreConfig): void {
  for (const token1 of warpCoreConfig.tokens) {
    for (const token2 of warpCoreConfig.tokens) {
      if (
        token1.chainName === token2.chainName &&
        token1.addressOrDenom === token2.addressOrDenom
      )
        continue;
      token1.connections ||= [];
      token1.connections.push({
        token: getTokenConnectionId(
          ProtocolType.Ethereum,
          token2.chainName,
          token2.addressOrDenom!,
        ),
      });
    }
  }
}

export async function runWarpRouteApply(
  params: WarpApplyParams,
): Promise<void> {
  const { warpDeployConfig, warpCoreConfig, context } = params;
  const { chainMetadata, skipConfirmation } = context;

  WarpRouteDeployConfigSchema.parse(warpDeployConfig);
  WarpCoreConfigSchema.parse(warpCoreConfig);

  const warpCoreConfigByChain = Object.fromEntries(
    warpCoreConfig.tokens.map((token) => [token.chainName, token]),
  );

  const chains = Object.keys(warpDeployConfig);

  let apiKeys: ChainMap<string> = {};
  if (!skipConfirmation)
    apiKeys = await requestAndSaveApiKeys(
      chains,
      chainMetadata,
      context.registry,
    );

  const { updatedWarpDeployConfig, updatedWarpCoreConfigByChain } =
    await extendWarpRoute(params, apiKeys, warpCoreConfigByChain);

  // Then create and submit update transactions
  const transactions: AnnotatedEV5Transaction[] = await updateExistingWarpRoute(
    params,
    apiKeys,
    updatedWarpDeployConfig,
    updatedWarpCoreConfigByChain,
  );

  if (transactions.length == 0)
    return logGreen(`Warp config is the same as target. No updates needed.`);
  await submitWarpApplyTransactions(params, groupBy(transactions, 'chainId'));
}

/**
 * Splits warp deploy config into existing and extended configurations based on warp core chains
 * for the warp apply process.
 */
function splitWarpApplyConfig(
  warpDeployConfig: WarpRouteDeployConfig,
  warpCoreChains: string[],
): [WarpRouteDeployConfig, WarpRouteDeployConfig] {
  return Object.entries(warpDeployConfig).reduce<
    [WarpRouteDeployConfig, WarpRouteDeployConfig]
  >(
    ([existing, extended], [chain, config]) => {
      if (warpCoreChains.includes(chain)) {
        existing[chain] = config;
      } else {
        extended[chain] = config;
      }
      return [existing, extended];
    },
    [{}, {}],
  );
}

/**
 * Handles the deployment and configuration of new contracts for extending a Warp route.
 * This function performs several key steps:
 * 1. Derives metadata from existing contracts and applies it to new configurations
 * 2. Deploys new contracts using the derived configurations
 * 3. Merges existing and new router configurations
 * 4. Generates an updated Warp core configuration
 */
async function deployWarpExtensionContracts(
  params: WarpApplyParams,
  apiKeys: ChainMap<string>,
  existingConfigs: WarpRouteDeployConfig,
  initialExtendedConfigs: WarpRouteDeployConfig,
  warpCoreConfigByChain: ChainMap<WarpCoreConfig['tokens'][number]>,
) {
  // Deploy new contracts with derived metadata
  const extendedConfigs = await deriveMetadataFromExisting(
    params.context.multiProvider,
    existingConfigs,
    initialExtendedConfigs,
  );

  const newDeployedContracts = await executeDeploy(
    {
      context: params.context,
      warpDeployConfig: extendedConfigs,
    },
    apiKeys,
  );

  // Merge existing and new routers
  const mergedRouters = mergeAllRouters(
    params.context.multiProvider,
    existingConfigs,
    newDeployedContracts,
    warpCoreConfigByChain,
  );

  // Get the updated core config
  const { warpCoreConfig: updatedWarpCoreConfig, addWarpRouteOptions } =
    await getWarpCoreConfig(params, mergedRouters);
  WarpCoreConfigSchema.parse(updatedWarpCoreConfig);

  return {
    newDeployedContracts,
    updatedWarpCoreConfig,
    addWarpRouteOptions,
  };
}

/**
 * Updates the Warp route configuration by incorporating newly deployed contract addresses.
 * Preserves existing configuration while updating token addresses for collateral tokens.
 */
function updateWarpRouteConfigWithNewAddresses(
  warpDeployConfig: WarpRouteDeployConfig,
  newDeployedContracts: HyperlaneContractsMap<
    HypERC20Factories | HypERC721Factories
  >,
): WarpRouteDeployConfig {
  return {
    ...warpDeployConfig,
    ...Object.fromEntries(
      Object.entries(newDeployedContracts).map(([chain, contracts]) => {
        const config = { ...warpDeployConfig[chain] };
        if (!isCollateralTokenConfig(config)) {
          return [chain, config];
        }

        const router = getRouter(
          contracts as HyperlaneContracts<HypERC20Factories>,
        );

        return [chain, { ...config, token: router.address }];
      }),
    ),
  };
}

/**
 * Extends an existing Warp route to include new chains.
 * This is a core function that orchestrates the entire extension process:
 * 1. Splits the configuration between existing and new chains
 * 2. If no new chains are being added, returns the current configuration
 * 3. Deploys and configures new contracts on the extended chains
 * 4. Updates the Warp deployment configuration with new contract addresses
 * 5. Updates the Warp core configuration with new token information
 * 6. Writes the updated artifacts to the registry
 */
export async function extendWarpRoute(
  params: WarpApplyParams,
  apiKeys: ChainMap<string>,
  warpCoreConfigByChain: ChainMap<WarpCoreConfig['tokens'][number]>,
): Promise<{
  updatedWarpDeployConfig: WarpRouteDeployConfig;
  updatedWarpCoreConfigByChain: ChainMap<WarpCoreConfig['tokens'][number]>;
}> {
  const { context, warpDeployConfig } = params;
  const warpCoreChains = Object.keys(warpCoreConfigByChain);

  // Split between the existing and additional config
  const [existingConfigs, initialExtendedConfigs] = splitWarpApplyConfig(
    warpDeployConfig,
    warpCoreChains,
  );

  const extendedChains = Object.keys(initialExtendedConfigs);
  if (extendedChains.length === 0) {
    return {
      updatedWarpDeployConfig: { ...warpDeployConfig },
      updatedWarpCoreConfigByChain: { ...warpCoreConfigByChain },
    };
  }

  logBlue(`Extending Warp Route to ${extendedChains.join(', ')}`);

  // Deploy new contracts with derived metadata and merge with existing config
  const { newDeployedContracts, updatedWarpCoreConfig, addWarpRouteOptions } =
    await deployWarpExtensionContracts(
      params,
      apiKeys,
      existingConfigs,
      initialExtendedConfigs,
      warpCoreConfigByChain,
    );

  // Create new warpDeployConfig with updated addresses
  const updatedWarpDeployConfig = updateWarpRouteConfigWithNewAddresses(
    warpDeployConfig,
    newDeployedContracts,
  );

  // Create new warpCoreConfigByChain with updated tokens
  const updatedWarpCoreConfigByChain = {
    ...warpCoreConfigByChain,
    ...Object.fromEntries(
      updatedWarpCoreConfig.tokens.map((token) => [token.chainName, token]),
    ),
  };

  // Write the updated artifacts
  await writeDeploymentArtifacts(
    updatedWarpCoreConfig,
    context,
    addWarpRouteOptions,
  );

  return {
    updatedWarpDeployConfig,
    updatedWarpCoreConfigByChain,
  };
}

/**
 * Gets router address for a chain
 */
const getRemoteRouterAddress = (
  deployedRoutersAddresses: ChainMap<Address>,
  chain: string,
): Address => deployedRoutersAddresses[chain];

/**
 * Gets gas configuration for a chain
 */
const getGasConfig = (
  warpDeployConfig: WarpRouteDeployConfig,
  chain: string,
): string =>
  warpDeployConfig[chain].gas?.toString() ||
  gasOverhead(warpDeployConfig[chain].type).toString();

/**
 * Returns default router addresses and gas values for cross-chain communication.
 * For each remote chain:
 * - Sets up router addresses for message routing
 * - Configures gas values for message processing
 */
function getDefaultRemoteRouterAndDestinationGasConfig(
  multiProvider: MultiProvider,
  chain: string,
  deployedRoutersAddresses: ChainMap<Address>,
  warpDeployConfig: WarpRouteDeployConfig,
): [RemoteRouters, DestinationGas] {
  const remoteRouters: RemoteRouters = {};
  const destinationGas: DestinationGas = {};

  const otherChains = multiProvider
    .getRemoteChains(chain)
    .filter((c) => Object.keys(deployedRoutersAddresses).includes(c));

  for (const otherChain of otherChains) {
    const domainId = multiProvider.getDomainId(otherChain);

    remoteRouters[domainId] = {
      address: getRemoteRouterAddress(deployedRoutersAddresses, otherChain),
    };

    destinationGas[domainId] = getGasConfig(warpDeployConfig, otherChain);
  }

  return [remoteRouters, destinationGas];
}

async function updateExistingWarpRoute(
  params: WarpApplyParams,
  apiKeys: ChainMap<string>,
  warpDeployConfig: WarpRouteDeployConfig,
  warpCoreConfigByChain: ChainMap<WarpCoreConfig['tokens'][number]>,
) {
  logBlue('Updating deployed Warp Routes');
  const { multiProvider, registry } = params.context;
  const registryAddresses =
    (await registry.getAddresses()) as ChainMap<ChainAddresses>;
  const contractVerifier = new ContractVerifier(
    multiProvider,
    apiKeys,
    coreBuildArtifact,
    ExplorerLicenseType.MIT,
  );
  const transactions: AnnotatedEV5Transaction[] = [];

  // Get all deployed router addresses
  const deployedRoutersAddresses: ChainMap<Address> = objMap(
    warpCoreConfigByChain,
    (_, config) => config.addressOrDenom as Address,
  );

  await promiseObjAll(
    objMap(warpDeployConfig, async (chain, config) => {
      await retryAsync(async () => {
        const deployedTokenRoute = deployedRoutersAddresses[chain];
        if (!deployedTokenRoute)
          return logGray(
            `Missing artifacts for ${chain}. Probably new deployment. Skipping update...`,
          );

        const {
          domainRoutingIsmFactory,
          staticMerkleRootMultisigIsmFactory,
          staticMessageIdMultisigIsmFactory,
          staticAggregationIsmFactory,
          staticAggregationHookFactory,
          staticMerkleRootWeightedMultisigIsmFactory,
          staticMessageIdWeightedMultisigIsmFactory,
        } = registryAddresses[chain];

        const evmERC20WarpModule = new EvmERC20WarpModule(
          multiProvider,
          {
            config,
            chain,
            addresses: {
              deployedTokenRoute,
              staticMerkleRootMultisigIsmFactory,
              staticMessageIdMultisigIsmFactory,
              staticAggregationIsmFactory,
              staticAggregationHookFactory,
              domainRoutingIsmFactory,
              staticMerkleRootWeightedMultisigIsmFactory,
              staticMessageIdWeightedMultisigIsmFactory,
            },
          },
          contractVerifier,
        );

        const [remoteRouters, destinationGas] =
          getDefaultRemoteRouterAndDestinationGasConfig(
            multiProvider,
            chain,
            deployedRoutersAddresses,
            warpDeployConfig,
          );

        transactions.push(
          ...(await evmERC20WarpModule.update({
            // Default behavior: Use fully connected routers with chain-specific gas values
            // if no explicit mappings are provided in the config
            remoteRouters,
            destinationGas,

            // Override defaults with any router or gas configurations specified in the warp apply config
            ...config,
          })),
        );
      });
    }),
  );
  return transactions;
}

/**
 * Retrieves a chain submission strategy from the provided filepath.
 * @param submissionStrategyFilepath a filepath to the submission strategy file
 * @returns a formatted submission strategy
 */
export function readChainSubmissionStrategy(
  submissionStrategyFilepath: string,
): ChainSubmissionStrategy {
  const submissionStrategyFileContent = readYamlOrJson(
    submissionStrategyFilepath.trim(),
  );
  return ChainSubmissionStrategySchema.parse(submissionStrategyFileContent);
}

/**
 * Derives token metadata from existing config and merges it with extended config.
 * @returns The merged Warp route deployment config with token metadata.
 */
async function deriveMetadataFromExisting(
  multiProvider: MultiProvider,
  existingConfigs: WarpRouteDeployConfig,
  extendedConfigs: WarpRouteDeployConfig,
): Promise<WarpRouteDeployConfig> {
  const existingTokenMetadata = await HypERC20Deployer.deriveTokenMetadata(
    multiProvider,
    existingConfigs,
  );
  return objMap(extendedConfigs, (_chain, extendedConfig) => {
    return {
      ...existingTokenMetadata,
      ...extendedConfig,
    };
  });
}

/**
 * Merges existing router configs with newly deployed router contracts.
 */
function mergeAllRouters(
  multiProvider: MultiProvider,
  existingConfigs: WarpRouteDeployConfig,
  deployedContractsMap: HyperlaneContractsMap<
    HypERC20Factories | HypERC721Factories
  >,
  warpCoreConfigByChain: ChainMap<WarpCoreConfig['tokens'][number]>,
) {
  const existingContractAddresses = objMap(
    existingConfigs,
    (chain, config) => ({
      [config.type]: warpCoreConfigByChain[chain].addressOrDenom!,
    }),
  );
  return {
    ...connectContractsMap(
      attachContractsMap(existingContractAddresses, hypERC20factories),
      multiProvider,
    ),
    ...deployedContractsMap,
  } as HyperlaneContractsMap<HypERC20Factories>;
}

function getRouter(contracts: HyperlaneContracts<HypERC20Factories>) {
  for (const key of objKeys(hypERC20factories)) {
    if (contracts[key]) return contracts[key];
  }
  throw new Error('No matching contract found.');
}

function displayWarpDeployPlan(deployConfig: WarpRouteDeployConfig) {
  logBlue('\nWarp Route Deployment Plan');
  logGray('==========================');
  log(`📋 Token Standard: ${deployConfig.isNft ? 'ERC721' : 'ERC20'}`);

  const { transformedDeployConfig, transformedIsmConfigs } =
    transformDeployConfigForDisplay(deployConfig);

  log('📋 Warp Route Config:');
  logTable(transformedDeployConfig);
  objMap(transformedIsmConfigs, (chain, ismConfigs) => {
    log(`📋 ${chain} ISM Config(s):`);
    ismConfigs.forEach((ismConfig) => {
      logTable(ismConfig);
    });
  });
}

/* only used for transformIsmForDisplay type-sense */
type IsmDisplayConfig =
  | RoutingIsmConfig // type, owner, ownerOverrides, domain
  | AggregationIsmConfig // type, modules, threshold
  | MultisigIsmConfig // type, validators, threshold
  | OpStackIsmConfig // type, origin, nativeBridge
  | PausableIsmConfig // type, owner, paused, ownerOverrides
  | TrustedRelayerIsmConfig; // type, relayer

function transformDeployConfigForDisplay(deployConfig: WarpRouteDeployConfig) {
  const transformedIsmConfigs: Record<ChainName, any[]> = {};
  const transformedDeployConfig = objMap(deployConfig, (chain, config) => {
    if (config.interchainSecurityModule)
      transformedIsmConfigs[chain] = transformIsmConfigForDisplay(
        config.interchainSecurityModule as IsmDisplayConfig,
      );

    return {
      'NFT?': config.isNft ?? false,
      Type: config.type,
      Owner: config.owner,
      Mailbox: config.mailbox,
      'ISM Config(s)': config.interchainSecurityModule
        ? 'See table(s) below.'
        : 'No ISM config(s) specified.',
    };
  });

  return {
    transformedDeployConfig,
    transformedIsmConfigs,
  };
}

function transformIsmConfigForDisplay(ismConfig: IsmDisplayConfig): any[] {
  const ismConfigs: any[] = [];
  switch (ismConfig.type) {
    case IsmType.AGGREGATION:
      ismConfigs.push({
        Type: ismConfig.type,
        Threshold: ismConfig.threshold,
        Modules: 'See table(s) below.',
      });
      ismConfig.modules.forEach((module) => {
        ismConfigs.push(
          ...transformIsmConfigForDisplay(module as IsmDisplayConfig),
        );
      });
      return ismConfigs;
    case IsmType.ROUTING:
      return [
        {
          Type: ismConfig.type,
          Owner: ismConfig.owner,
          'Owner Overrides': ismConfig.ownerOverrides ?? 'Undefined',
          Domains: 'See warp config for domain specification.',
        },
      ];
    case IsmType.FALLBACK_ROUTING:
      return [
        {
          Type: ismConfig.type,
          Owner: ismConfig.owner,
          'Owner Overrides': ismConfig.ownerOverrides ?? 'Undefined',
          Domains: 'See warp config for domain specification.',
        },
      ];
    case IsmType.MERKLE_ROOT_MULTISIG:
      return [
        {
          Type: ismConfig.type,
          Validators: ismConfig.validators,
          Threshold: ismConfig.threshold,
        },
      ];
    case IsmType.MESSAGE_ID_MULTISIG:
      return [
        {
          Type: ismConfig.type,
          Validators: ismConfig.validators,
          Threshold: ismConfig.threshold,
        },
      ];
    case IsmType.OP_STACK:
      return [
        {
          Type: ismConfig.type,
          Origin: ismConfig.origin,
          'Native Bridge': ismConfig.nativeBridge,
        },
      ];
    case IsmType.PAUSABLE:
      return [
        {
          Type: ismConfig.type,
          Owner: ismConfig.owner,
          'Paused ?': ismConfig.paused,
          'Owner Overrides': ismConfig.ownerOverrides ?? 'Undefined',
        },
      ];
    case IsmType.TRUSTED_RELAYER:
      return [
        {
          Type: ismConfig.type,
          Relayer: ismConfig.relayer,
        },
      ];
    default:
      return [ismConfig];
  }
}

/**
 * Submits a set of transactions to the specified chain and outputs transaction receipts
 */
async function submitWarpApplyTransactions(
  params: WarpApplyParams,
  chainTransactions: Record<string, AnnotatedEV5Transaction[]>,
): Promise<void> {
  // Create mapping of chain ID to chain name for all chains in warpDeployConfig
  const chains = Object.keys(params.warpDeployConfig);
  const chainIdToName = Object.fromEntries(
    chains.map((chain) => [
      params.context.multiProvider.getChainId(chain),
      chain,
    ]),
  );

  await promiseObjAll(
    objMap(chainTransactions, async (chainId, transactions) => {
      await retryAsync(
        async () => {
          const chain = chainIdToName[chainId];
          const submitter: TxSubmitterBuilder<ProtocolType> =
            await getWarpApplySubmitter({
              chain,
              context: params.context,
              strategyUrl: params.strategyUrl,
            });
          const transactionReceipts = await submitter.submit(...transactions);
          if (transactionReceipts) {
            const receiptPath = `${params.receiptsDir}/${chain}-${
              submitter.txSubmitterType
            }-${Date.now()}-receipts.json`;
            writeYamlOrJson(receiptPath, transactionReceipts);
            logGreen(
              `Transactions receipts successfully written to ${receiptPath}`,
            );
          }
        },
        5, // attempts
        100, // baseRetryMs
      );
    }),
  );
}

/**
 * Helper function to get warp apply specific submitter.
 *
 * @returns the warp apply submitter
 */
async function getWarpApplySubmitter({
  chain,
  context,
  strategyUrl,
}: {
  chain: ChainName;
  context: WriteCommandContext;
  strategyUrl?: string;
}): Promise<TxSubmitterBuilder<ProtocolType>> {
  const { multiProvider } = context;

  const submissionStrategy: SubmissionStrategy = strategyUrl
    ? readChainSubmissionStrategy(strategyUrl)[chain]
    : {
        submitter: {
          chain,
          type: TxSubmitterType.JSON_RPC,
        },
      };

  return getSubmitterBuilder<ProtocolType>({
    submissionStrategy,
    multiProvider,
  });
}
