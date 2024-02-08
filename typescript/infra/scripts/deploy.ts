import path from 'path';
import { prompt } from 'prompts';

import { HelloWorldDeployer } from '@hyperlane-xyz/helloworld';
import {
  ChainMap,
  HypERC20Deployer,
  HyperlaneCore,
  HyperlaneCoreDeployer,
  HyperlaneDeployer,
  HyperlaneIgpDeployer,
  HyperlaneIsmFactory,
  HyperlaneProxyFactoryDeployer,
  InterchainAccountDeployer,
  InterchainQueryDeployer,
  LiquidityLayerDeployer,
  TokenType,
} from '@hyperlane-xyz/sdk';
import { objMap } from '@hyperlane-xyz/utils';

import { Contexts } from '../config/contexts';
import { aggregationIsm } from '../config/routingIsm';
import { supportedChainNames as mainnet3Chains } from '../config/environments/mainnet3/chains';
import { supportedChainNames as testnet4Chains } from '../config/environments/testnet4/chains';
import { deployEnvToSdkEnv } from '../src/config/environment';
import { deployWithArtifacts } from '../src/deployment/deploy';
import { TestQuerySenderDeployer } from '../src/deployment/testcontracts/testquerysender';
import { impersonateAccount, useLocalProvider } from '../src/utils/fork';

import {
  Modules,
  SDK_MODULES,
  getAddresses,
  getArgs,
  getContractAddressesSdkFilepath,
  getModuleDirectory,
  withContext,
  withModuleAndFork,
  withNetwork,
} from './agent-utils';
import { getEnvironmentConfig } from './core-utils';

async function main() {
  const {
    context = Contexts.Hyperlane,
    module,
    fork,
    environment,
    network,
  } = await withContext(withNetwork(withModuleAndFork(getArgs()))).argv;
  const envConfig = getEnvironmentConfig(environment);
  const env = deployEnvToSdkEnv[environment];

  const supportedChainNames =
    environment === 'mainnet3'
      ? mainnet3Chains
      : environment === 'testnet4'
      ? testnet4Chains
      : undefined;

  let multiProvider = await envConfig.getMultiProvider();

  if (fork) {
    multiProvider = multiProvider.extendChainMetadata({
      [fork]: { blocks: { confirmations: 0 } },
    });
    await useLocalProvider(multiProvider, fork);

    const signer = await impersonateAccount(envConfig.owners[fork].owner);
    multiProvider.setSharedSigner(signer);
  }

  let config: ChainMap<unknown> = {};
  let deployer: HyperlaneDeployer<any, any>;
  if (module === Modules.PROXY_FACTORY) {
    config = objMap(envConfig.core, (_chain) => true);
    deployer = new HyperlaneProxyFactoryDeployer(multiProvider);
  } else if (module === Modules.CORE) {
    config = envConfig.core;
    const ismFactory = HyperlaneIsmFactory.fromAddressesMap(
      getAddresses(environment, Modules.PROXY_FACTORY),
      multiProvider,
    );
    deployer = new HyperlaneCoreDeployer(multiProvider, ismFactory);
  } else if (module === Modules.WARP) {
    const core = HyperlaneCore.fromEnvironment(env, multiProvider);
    const ismFactory = HyperlaneIsmFactory.fromAddressesMap(
      getAddresses(environment, Modules.PROXY_FACTORY),
      multiProvider,
    );
    const routerConfig = core.getRouterConfig(envConfig.owners);
    const inevm = {
      ...routerConfig.inevm,
      type: TokenType.synthetic,
    };
    const ethereum = {
      ...routerConfig.ethereum,
      type: TokenType.collateral,
      token: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
      hook: '0xb87AC8EA4533AE017604E44470F7c1E550AC6F10', // aggregation of IGP and Merkle, arbitrary config not supported for now
      interchainSecurityModule: aggregationIsm('inevm', Contexts.Hyperlane),
    };
    config = {
      inevm,
      ethereum,
    };
    deployer = new HypERC20Deployer(multiProvider, ismFactory);
  } else if (module === Modules.INTERCHAIN_GAS_PAYMASTER) {
    config = envConfig.igp;
    deployer = new HyperlaneIgpDeployer(multiProvider);
  } else if (module === Modules.INTERCHAIN_ACCOUNTS) {
    const core = HyperlaneCore.fromEnvironment(env, multiProvider);
    config = core.getRouterConfig(envConfig.owners);
    deployer = new InterchainAccountDeployer(multiProvider);
  } else if (module === Modules.INTERCHAIN_QUERY_SYSTEM) {
    const core = HyperlaneCore.fromEnvironment(env, multiProvider);
    config = core.getRouterConfig(envConfig.owners);
    deployer = new InterchainQueryDeployer(multiProvider);
  } else if (module === Modules.LIQUIDITY_LAYER) {
    const core = HyperlaneCore.fromEnvironment(env, multiProvider);
    const routerConfig = core.getRouterConfig(envConfig.owners);
    if (!envConfig.liquidityLayerConfig) {
      throw new Error(`No liquidity layer config for ${environment}`);
    }
    config = objMap(
      envConfig.liquidityLayerConfig.bridgeAdapters,
      (chain, conf) => ({
        ...conf,
        ...routerConfig[chain],
      }),
    );
    deployer = new LiquidityLayerDeployer(multiProvider);
  } else if (module === Modules.TEST_RECIPIENT) {
    throw new Error('Test recipient is not supported. Use CLI instead.');
  } else if (module === Modules.TEST_QUERY_SENDER) {
    // Get query router addresses
    const queryAddresses = getAddresses(
      environment,
      Modules.INTERCHAIN_QUERY_SYSTEM,
    );
    config = objMap(queryAddresses, (_c, conf) => ({
      queryRouterAddress: conf.router,
    }));
    deployer = new TestQuerySenderDeployer(multiProvider);
  } else if (module === Modules.HELLO_WORLD) {
    const core = HyperlaneCore.fromEnvironment(
      env,
      multiProvider,
      supportedChainNames,
    );
    config = core.getRouterConfig(envConfig.owners);
    deployer = new HelloWorldDeployer(multiProvider);
  } else {
    console.log(`Skipping ${module}, deployer unimplemented`);
    return;
  }

  const modulePath = getModuleDirectory(environment, module, context);

  console.log(`Deploying to ${modulePath}`);

  const isSdkArtifact = SDK_MODULES.includes(module) && environment !== 'test';

  const addresses = isSdkArtifact
    ? path.join(
        getContractAddressesSdkFilepath(),
        `${deployEnvToSdkEnv[environment]}.json`,
      )
    : path.join(modulePath, 'addresses.json');

  const verification = path.join(modulePath, 'verification.json');

  const cache = {
    addresses,
    verification,
    read: environment !== 'test',
    write: !fork,
  };
  // Don't write agent config in fork tests
  const agentConfig =
    module === Modules.CORE && !fork
      ? {
          addresses,
          environment,
          multiProvider,
        }
      : undefined;

  // prompt for confirmation in production environments
  if (environment !== 'test' && !fork) {
    const confirmConfig = network ? config[network] : config;
    console.log(JSON.stringify(confirmConfig, null, 2));
    const { value: confirmed } = await prompt({
      type: 'confirm',
      name: 'value',
      message: `Confirm you want to deploy this ${module} configuration to ${environment}?`,
      initial: false,
    });
    if (!confirmed) {
      process.exit(0);
    }
  }

  await deployWithArtifacts(
    config,
    deployer,
    cache,
    network ?? fork,
    agentConfig,
  );
}

main()
  .then()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
