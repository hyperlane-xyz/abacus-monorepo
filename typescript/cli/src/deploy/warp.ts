import { confirm } from '@inquirer/prompts';
import { stringify as yamlStringify } from 'yaml';

import { IRegistry } from '@hyperlane-xyz/registry';
import {
  AggregationIsmConfig,
  AnnotatedEV5Transaction,
  ChainMap,
  ChainName,
  EvmERC20WarpModule,
  EvmERC20WarpRouteReader,
  EvmIsmModule,
  HypERC20Deployer,
  HypERC20Factories,
  HypERC721Deployer,
  HyperlaneAddresses,
  HyperlaneContracts,
  HyperlaneContractsMap,
  HyperlaneProxyFactoryDeployer,
  IsmType,
  MultiProvider,
  MultisigIsmConfig,
  OpStackIsmConfig,
  PausableIsmConfig,
  ProxyFactoryFactoriesAddresses,
  RoutingIsmConfig,
  TOKEN_TYPE_TO_STANDARD,
  TokenFactories,
  TrustedRelayerIsmConfig,
  WarpCoreConfig,
  WarpCoreConfigSchema,
  WarpRouteDeployConfig,
  WarpRouteDeployConfigSchema,
  attachContractsMap,
  connectContractsMap,
  getTokenConnectionId,
  hypERC20factories,
  isCollateralConfig,
  isTokenMetadata,
  serializeContracts,
} from '@hyperlane-xyz/sdk';
import {
  Address,
  ProtocolType,
  assert,
  objFilter,
  objKeys,
  objMap,
  promiseObjAll,
} from '@hyperlane-xyz/utils';

import { readWarpRouteDeployConfig } from '../config/warp.js';
import { MINIMUM_WARP_DEPLOY_GAS } from '../consts.js';
import { WriteCommandContext } from '../context/types.js';
import {
  log,
  logBlue,
  logGray,
  logGreen,
  logRed,
  logTable,
} from '../logger.js';
import {
  indentYamlOrJson,
  isFile,
  runFileSelectionStep,
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

interface ApplyParams extends DeployParams {
  warpCoreConfig: WarpCoreConfig;
}

export async function runWarpRouteDeploy({
  context,
  warpRouteDeploymentConfigPath,
}: {
  context: WriteCommandContext;
  warpRouteDeploymentConfigPath?: string;
}) {
  const { signer, skipConfirmation } = context;

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

  const deploymentParams = {
    context,
    warpDeployConfig: warpRouteConfig,
  };

  await runDeployPlanStep(deploymentParams);
  const chains = Object.keys(warpRouteConfig);

  await runPreflightChecksForChains({
    context,
    chains,
    minGas: MINIMUM_WARP_DEPLOY_GAS,
  });

  const userAddress = await signer.getAddress();

  const initialBalances = await prepareDeploy(context, userAddress, chains);

  const deployedContracts = await executeDeploy(deploymentParams);

  const warpCoreConfig = await getWarpCoreConfig(
    deploymentParams,
    deployedContracts,
  );

  await writeDeploymentArtifacts(warpCoreConfig, context);

  await completeDeploy(context, 'warp', initialBalances, userAddress, chains);
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
): Promise<HyperlaneContractsMap<TokenFactories>> {
  logBlue('All systems ready, captain! Beginning deployment...');

  const {
    warpDeployConfig,
    context: { registry, multiProvider, isDryRun, dryRunChain },
  } = params;

  const deployer = warpDeployConfig.isNft
    ? new HypERC721Deployer(multiProvider)
    : new HypERC20Deployer(multiProvider); // @TODO replace with EvmERC20WarpModule

  const config: WarpRouteDeployConfig =
    isDryRun && dryRunChain
      ? { [dryRunChain]: warpDeployConfig[dryRunChain] }
      : warpDeployConfig;

  const ismFactoryDeployer = new HyperlaneProxyFactoryDeployer(multiProvider);

  // For each chain in WarpRouteConfig, deploy each Ism Factory, if it's not in the registry
  // Then return a modified config with the ism address as a string
  const modifiedConfig = await deployAndResolveWarpIsm(
    config,
    multiProvider,
    registry,
    ismFactoryDeployer,
  );

  const deployedContracts = await deployer.deploy(modifiedConfig);

  logGreen('✅ Warp contract deployments complete');
  return deployedContracts;
}

async function writeDeploymentArtifacts(
  warpCoreConfig: WarpCoreConfig,
  context: WriteCommandContext,
) {
  if (!context.isDryRun) {
    log('Writing deployment artifacts...');
    await context.registry.addWarpRoute(warpCoreConfig);
  }
  log(indentYamlOrJson(yamlStringify(warpCoreConfig, null, 2), 4));
}

async function deployAndResolveWarpIsm(
  warpConfig: WarpRouteDeployConfig,
  multiProvider: MultiProvider,
  registry: IRegistry,
  ismFactoryDeployer: HyperlaneProxyFactoryDeployer,
): Promise<WarpRouteDeployConfig> {
  return promiseObjAll(
    objMap(warpConfig, async (chain, config) => {
      // Skip deployment if Ism is empty, or a string
      if (
        !config.interchainSecurityModule ||
        typeof config.interchainSecurityModule === 'string'
      ) {
        logGray(
          `Config Ism is ${
            !config.interchainSecurityModule
              ? 'empty'
              : config.interchainSecurityModule
          }, skipping deployment`,
        );
        return config;
      }

      logBlue('Loading Registry factory addresses');
      let chainAddresses = await registry.getChainAddresses(chain); // Can includes other addresses

      if (!chainAddresses) {
        logGray('Registry factory addresses not found, deploying');
        chainAddresses = serializeContracts(
          await ismFactoryDeployer.deployContracts(chain),
        ) as Record<string, string>;
      }

      logGray(
        `Creating ${config.interchainSecurityModule.type} Ism for ${config.type} token on ${chain} chain`,
      );

      const deployedIsm = await createWarpIsm(
        chain,
        warpConfig,
        multiProvider,
        {
          domainRoutingIsmFactory: chainAddresses.domainRoutingIsmFactory,
          staticAggregationHookFactory:
            chainAddresses.staticAggregationHookFactory,
          staticAggregationIsmFactory:
            chainAddresses.staticAggregationIsmFactory,
          staticMerkleRootMultisigIsmFactory:
            chainAddresses.staticMerkleRootMultisigIsmFactory,
          staticMessageIdMultisigIsmFactory:
            chainAddresses.staticMessageIdMultisigIsmFactory,
        },
      );

      logGreen(
        `Finished creating ${config.interchainSecurityModule.type} Ism for ${config.type} token on ${chain} chain`,
      );
      return { ...warpConfig[chain], interchainSecurityModule: deployedIsm };
    }),
  );
}

/**
 * Deploys the Warp ISM for a given config
 *
 * @returns The deployed ism address
 */
async function createWarpIsm(
  chain: string,
  warpConfig: WarpRouteDeployConfig,
  multiProvider: MultiProvider,
  factoryAddresses: HyperlaneAddresses<any>,
): Promise<string> {
  const {
    domainRoutingIsmFactory,
    staticAggregationHookFactory,
    staticAggregationIsmFactory,
    staticMerkleRootMultisigIsmFactory,
    staticMessageIdMultisigIsmFactory,
  } = factoryAddresses;
  const evmIsmModule = await EvmIsmModule.create({
    chain,
    multiProvider,
    mailbox: warpConfig[chain].mailbox,
    proxyFactoryFactories: {
      domainRoutingIsmFactory,
      staticAggregationHookFactory,
      staticAggregationIsmFactory,
      staticMerkleRootMultisigIsmFactory,
      staticMessageIdMultisigIsmFactory,
    },
    config: warpConfig[chain].interchainSecurityModule!,
  });
  const { deployedIsm } = evmIsmModule.serialize();
  return deployedIsm;
}

async function getWarpCoreConfig(
  { warpDeployConfig, context }: DeployParams,
  contracts: HyperlaneContractsMap<TokenFactories>,
): Promise<WarpCoreConfig> {
  const warpCoreConfig: WarpCoreConfig = { tokens: [] };

  // TODO: replace with warp read
  const tokenMetadata = await HypERC20Deployer.deriveTokenMetadata(
    context.multiProvider,
    warpDeployConfig,
  );
  assert(
    tokenMetadata && isTokenMetadata(tokenMetadata),
    'Missing required token metadata',
  );
  const { decimals, symbol, name } = tokenMetadata;
  assert(decimals, 'Missing decimals on token metadata');

  // First pass, create token configs
  for (const [chainName, contract] of Object.entries(contracts)) {
    const config = warpDeployConfig[chainName];
    const collateralAddressOrDenom = isCollateralConfig(config)
      ? config.token // gets set in the above deriveTokenMetadata()
      : undefined;

    warpCoreConfig.tokens.push({
      chainName,
      standard: TOKEN_TYPE_TO_STANDARD[config.type],
      decimals,
      symbol,
      name,
      addressOrDenom:
        contract[warpDeployConfig[chainName].type as keyof TokenFactories]
          .address,
      collateralAddressOrDenom,
    });
  }

  // Second pass, add connections between tokens
  // Assumes full interconnectivity between all tokens for now b.c. that's
  // what the deployers do by default.
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

  return warpCoreConfig;
}

export async function runWarpRouteApply(params: ApplyParams) {
  const { warpDeployConfig, warpCoreConfig, context } = params;
  const { multiProvider, registry } = context;
  WarpRouteDeployConfigSchema.parse(warpDeployConfig);
  WarpCoreConfigSchema.parse(warpCoreConfig);

  // Addresses used to get static Ism factories
  const addresses = await registry.getAddresses();

  // Convert warpCoreConfig.tokens[] into a mapping of { [chainName]: Config }
  // This allows O(1) reads within the loop
  const warpCoreByChain = Object.fromEntries(
    warpCoreConfig.tokens.map((token) => [token.chainName, token]),
  );

  // get diff of both configs
  const warpDeployChains = Object.keys(warpDeployConfig);
  const warpCoreChains = Object.keys(warpCoreByChain);
  logGray(`Comparing target and onchain Warp configs`);
  if (warpDeployChains.length === warpCoreChains.length) {
    // Attempt to update Warp Routes
    // Can update existing or deploy new contracts
    await promiseObjAll(
      objMap(warpDeployConfig, async (chain, config) => {
        try {
          // Update Warp
          config.ismFactoryAddresses = addresses[
            chain
          ] as ProxyFactoryFactoriesAddresses;
          const evmERC20WarpModule = new EvmERC20WarpModule(
            context.multiProvider,
            {
              config,
              chain,
              addresses: {
                deployedTokenRoute: warpCoreByChain[chain].addressOrDenom!,
              },
            },
          );
          const transactions = await evmERC20WarpModule.update(config);

          // Send Txs
          if (transactions.length) {
            for (const transaction of transactions) {
              logGray(`Attempting on ${chain}`);
              await multiProvider.sendTransaction(chain, transaction);
            }

            logGreen(`Warp config updated on ${chain}.`);
          } else {
            logGreen(
              `Warp config on ${chain} is the same as target. No updates needed.`,
            );
          }
        } catch (e) {
          logRed(`Warp config on ${chain} failed to update.`, e);
        }
      }),
    );
  } else if (warpDeployChains.length > warpCoreChains.length) {
    logGray('Extending deployed Warp configs');

    // Get the existing deployed config
    const deployedConfig: WarpRouteDeployConfig = objFilter(
      warpDeployConfig,
      (chain, _config): _config is any => warpCoreChains.includes(chain), // @TODO fix any
    );

    // Get additional config
    let additionalConfig: WarpRouteDeployConfig = objFilter(
      warpDeployConfig,
      (chain, _config): _config is any => !warpCoreChains.includes(chain),
    );

    // Derive additionalConfig metadata using the first deployed Warp Route.
    const tokenMetadata = await HypERC20Deployer.deriveTokenMetadata(
      multiProvider,
      deployedConfig,
    );
    additionalConfig = objMap(additionalConfig, (_chain, config) => {
      return {
        ...config,
        ...tokenMetadata,
      };
    });

    // Deploy (and enrolls) additional routers with each other
    const newDeployedContracts = await executeDeploy({
      context,
      warpDeployConfig: additionalConfig,
    });

    // Enroll all existing and additional deployed routers with each other
    const existingDeployedAddresses = objMap(
      deployedConfig,
      (chain, config) => ({
        [config.type]: warpCoreByChain[chain].addressOrDenom!,
      }),
    );
    const allRouters = {
      ...connectContractsMap(
        attachContractsMap(existingDeployedAddresses, hypERC20factories),
        multiProvider,
      ),
      ...newDeployedContracts,
    } as HyperlaneContractsMap<HypERC20Factories>;

    // Send Txs
    for (const transaction of await enrollRemoteRouters(
      multiProvider,
      allRouters,
    )) {
      const chain = multiProvider.getChainName(transaction.chainId!);
      logGray(`Attempting on ${chain}`);
      await multiProvider.sendTransaction(chain, transaction);
      logGreen(`Successfully enrolled routers on ${chain}`);
    }

    // Write the WarpCore Artifacts
    const updatedWarpCoreConfig = await getWarpCoreConfig(params, allRouters);
    WarpCoreConfigSchema.parse(updatedWarpCoreConfig);
    await writeDeploymentArtifacts(updatedWarpCoreConfig, context);
  } else {
    throw new Error('Unenrolling warp routes is currently not supported');
  }
}

async function enrollRemoteRouters(
  multiProvider: MultiProvider,
  deployedContractsMap: HyperlaneContractsMap<HypERC20Factories>,
): Promise<AnnotatedEV5Transaction[]> {
  logBlue(`Enrolling deployed routers with each other (if not already)...`);
  const transactions: AnnotatedEV5Transaction[] = [];
  const deployedRouters: ChainMap<Address> = objMap(
    deployedContractsMap,
    (_, contracts) => getRouter(contracts).address,
  );
  const allChains = Object.keys(deployedRouters);

  // For each deployed routers, create tx to enroll with others
  await promiseObjAll(
    objMap(deployedContractsMap, async (chain, contracts) => {
      // Get the existing config, and mutate it's remoteRouters by setting it to all other routers
      const router = getRouter(contracts);
      const config = await new EvmERC20WarpRouteReader(
        multiProvider,
        chain,
      ).deriveWarpRouteConfig(router.address);
      const evmERC20WarpModule = new EvmERC20WarpModule(multiProvider, {
        config,
        chain,
        addresses: { deployedTokenRoute: router.address },
      });

      const allRemoteChains = multiProvider
        .getRemoteChains(chain)
        .filter((c) => allChains.includes(c));

      config.remoteRouters = await Promise.all(
        allRemoteChains.map(async (remote) => ({
          domain: multiProvider.getDomainId(remote),
          router: deployedRouters[remote],
        })),
      );
      transactions.push(...(await evmERC20WarpModule.update(config)));
    }),
  );

  return transactions;
}

function getRouter(contracts: HyperlaneContracts<HypERC20Factories>) {
  for (const key of objKeys(hypERC20factories)) {
    if (contracts[key]) {
      return contracts[key];
    }
  }
  throw new Error('No matching contract found');
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
type IsmConfig =
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
        config.interchainSecurityModule as IsmConfig,
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

function transformIsmConfigForDisplay(ismConfig: IsmConfig): any[] {
  const ismConfigs: any[] = [];
  switch (ismConfig.type) {
    case IsmType.AGGREGATION:
      ismConfigs.push({
        Type: ismConfig.type,
        Threshold: ismConfig.threshold,
        Modules: 'See table(s) below.',
      });
      ismConfig.modules.forEach((module) => {
        ismConfigs.push(...transformIsmConfigForDisplay(module as IsmConfig));
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
