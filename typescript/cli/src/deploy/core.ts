import { confirm, input } from '@inquirer/prompts';
import { ethers } from 'ethers';

import {
  ChainMap,
  ChainName,
  CoreConfig,
  DeployedIsm,
  GasOracleContractType,
  HyperlaneAddresses,
  HyperlaneAddressesMap,
  HyperlaneContractsMap,
  HyperlaneCoreDeployer,
  HyperlaneDeploymentArtifacts,
  HyperlaneIgpDeployer,
  HyperlaneIsmFactory,
  HyperlaneIsmFactoryDeployer,
  ModuleType,
  MultiProvider,
  MultisigIsmConfig,
  OverheadIgpConfig,
  RoutingIsmConfig,
  agentStartBlocks,
  buildAgentConfig,
  defaultMultisigIsmConfigs,
  multisigIsmVerificationCost,
  serializeContractsMap,
} from '@hyperlane-xyz/sdk';
import { Address, objFilter, objMerge } from '@hyperlane-xyz/utils';

import { readDeploymentArtifacts } from '../config/artifacts.js';
import { readMultisigConfig } from '../config/multisig.js';
import { MINIMUM_CORE_DEPLOY_BALANCE } from '../consts.js';
import {
  getDeployerContext,
  getMergedContractAddresses,
  sdkContractAddressesMap,
} from '../context.js';
import { log, logBlue, logGray, logGreen } from '../logger.js';
import { runOriginAndRemotesSelectionStep } from '../utils/chains.js';
import { prepNewArtifactsFiles, writeJson } from '../utils/files.js';

import {
  TestRecipientConfig,
  TestRecipientDeployer,
} from './TestRecipientDeployer.js';
import { runPreflightChecks } from './utils.js';

export async function runCoreDeploy({
  key,
  chainConfigPath,
  ismConfigPath,
  artifactsPath,
  outPath,
  origin,
  remotes,
  skipConfirmation,
}: {
  key: string;
  chainConfigPath: string;
  ismConfigPath: string;
  artifactsPath?: string;
  outPath: string;
  origin?: string;
  remotes?: string[];
  skipConfirmation: boolean;
}) {
  const { customChains, multiProvider, signer } = getDeployerContext(
    key,
    chainConfigPath,
  );

  if (!origin || !remotes?.length) {
    ({ origin, remotes } = await runOriginAndRemotesSelectionStep(
      customChains,
    ));
  }
  const selectedChains = [origin, ...remotes];
  const artifacts = await runArtifactStep(selectedChains, artifactsPath);
  const multisigConfig = await runIsmStep(selectedChains, ismConfigPath);

  const deploymentParams: DeployParams = {
    origin,
    remotes,
    signer,
    multiProvider,
    artifacts,
    multisigConfig,
    outPath,
    skipConfirmation,
  };

  await runDeployPlanStep(deploymentParams);
  await runPreflightChecks({
    ...deploymentParams,
    minBalanceWei: MINIMUM_CORE_DEPLOY_BALANCE,
  });
  await executeDeploy(deploymentParams);
}

async function runArtifactStep(
  selectedChains: ChainName[],
  artifactsPath?: string,
) {
  if (!artifactsPath) {
    logBlue(
      '\n',
      'Deployments can be totally new or can use some existing contract addresses.',
    );
    const isResume = await confirm({
      message: 'Do you want use some existing contract addresses?',
    });
    if (!isResume) return undefined;

    artifactsPath = await input({
      message: 'Enter filepath with existing contract artifacts (addresses)',
    });
  }
  const artifacts = readDeploymentArtifacts(artifactsPath);
  const artifactChains = Object.keys(artifacts).filter((c) =>
    selectedChains.includes(c),
  );
  log(`Found existing artifacts for chains: ${artifactChains.join(', ')}`);
  return artifacts;
}

async function runIsmStep(selectedChains: ChainName[], ismConfigPath?: string) {
  const defaultConfigChains = Object.keys(defaultMultisigIsmConfigs);
  const configRequired = !!selectedChains.find(
    (c) => !defaultConfigChains.includes(c),
  );
  if (!configRequired) return;

  if (!ismConfigPath) {
    logBlue(
      '\n',
      'Hyperlane instances requires an Interchain Security Module (ISM).',
    );
    logGray(
      'Note, only Multisig ISM configs are currently supported in the CLI',
      'Example config: https://github.com/hyperlane-xyz/hyperlane-monorepo/blob/main/cli/typescript/cli/examples/multisig-ism.yaml',
    );
    ismConfigPath = await input({
      message: 'Enter filepath for the multisig config',
    });
  }
  const configs = readMultisigConfig(ismConfigPath);
  const multisigConfigChains = Object.keys(configs).filter((c) =>
    selectedChains.includes(c),
  );
  log(`Found configs for chains: ${multisigConfigChains.join(', ')}`);
  return configs;
}

interface DeployParams {
  origin: string;
  remotes: string[];
  signer: ethers.Signer;
  multiProvider: MultiProvider;
  artifacts?: HyperlaneContractsMap<any>;
  multisigConfig?: ChainMap<MultisigIsmConfig>;
  outPath: string;
  skipConfirmation: boolean;
}

async function runDeployPlanStep({
  origin,
  remotes,
  signer,
  artifacts,
  skipConfirmation,
}: DeployParams) {
  const address = await signer.getAddress();
  logBlue('\nDeployment plan:');
  logGray('===============:');
  log(`Transaction signer and owner of new contracts will be ${address}`);
  log(`Deploying to ${origin} and connecting it to ${remotes.join(', ')}`);
  const numContracts = Object.keys(
    Object.values(sdkContractAddressesMap)[0],
  ).length;
  log(`There are ${numContracts} contracts for each chain`);
  if (artifacts)
    log('But contracts with an address in the artifacts file will be skipped');
  for (const chain of [origin, ...remotes]) {
    const chainArtifacts = artifacts?.[chain] || {};
    const numRequired = numContracts - Object.keys(chainArtifacts).length;
    log(`${chain} will require ${numRequired} of ${numContracts}`);
  }
  log('The interchain security module will be a Multisig.');
  if (skipConfirmation) return;
  const isConfirmed = await confirm({
    message: 'Is this deployment plan correct?',
  });
  if (!isConfirmed) throw new Error('Deployment cancelled');
}

async function executeDeploy({
  origin,
  remotes,
  signer,
  multiProvider,
  outPath,
  artifacts = {},
  multisigConfig = {},
}: DeployParams) {
  logBlue('All systems ready, captain! Beginning deployment...');

  const [contractsFilePath, agentFilePath] = prepNewArtifactsFiles(outPath, [
    { filename: 'core-deployment', description: 'Contract addresses' },
    { filename: 'agent-config', description: 'Agent configs' },
  ]);

  const owner = await signer.getAddress();
  const selectedChains = [origin, ...remotes];
  const mergedContractAddrs = getMergedContractAddresses(artifacts);

  // 1. Deploy ISM factories to all deployable chains that don't have them.
  log('Deploying ISM factory contracts');
  const ismDeployer = new HyperlaneIsmFactoryDeployer(multiProvider);
  ismDeployer.cacheAddressesMap(mergedContractAddrs);
  const ismFactoryContracts = await ismDeployer.deploy(selectedChains);
  artifacts = writeMergedAddresses(
    contractsFilePath,
    artifacts,
    ismFactoryContracts,
  );
  logGreen(`ISM factory contracts deployed`);

  // 2. Deploy IGPs to all deployable chains.
  log(`Deploying IGP contracts`);
  const igpConfig = buildIgpConfigMap(
    owner,
    selectedChains,
    selectedChains,
    multisigConfig,
  );
  const igpDeployer = new HyperlaneIgpDeployer(multiProvider);
  igpDeployer.cacheAddressesMap(artifacts);
  const igpContracts = await igpDeployer.deploy(igpConfig);
  artifacts = writeMergedAddresses(contractsFilePath, artifacts, igpContracts);
  logGreen(`IGP contracts deployed`);

  // Build an IsmFactory that covers all chains so that we can
  // use it later to deploy ISMs to remote chains.
  const ismFactory = HyperlaneIsmFactory.fromAddressesMap(
    mergedContractAddrs,
    multiProvider,
  );

  // 3. Deploy core contracts to origin chain
  log(`Deploying core contracts to ${origin}`);
  const coreDeployer = new HyperlaneCoreDeployer(multiProvider, ismFactory);
  coreDeployer.cacheAddressesMap(artifacts);
  const coreConfig = buildCoreConfigMap(owner, origin, remotes, multisigConfig);
  const coreContracts = await coreDeployer.deploy(coreConfig);
  artifacts = writeMergedAddresses(contractsFilePath, artifacts, coreContracts);
  logGreen(`Core contracts deployed`);

  // 4. Deploy ISM contracts to remote deployable chains
  log(`Deploying ISMs`);
  const ismConfigs = buildIsmConfigMap(
    owner,
    selectedChains,
    remotes,
    multisigConfig,
  );
  const ismContracts: ChainMap<{ multisigIsm: DeployedIsm }> = {};
  for (const [ismChain, ismConfig] of Object.entries(ismConfigs)) {
    if (artifacts[ismChain].multisigIsm) {
      log(`ISM contract recovered, skipping ISM deployment to ${ismChain}`);
      continue;
    }
    log(`Deploying ISM to ${ismChain}`);
    ismContracts[ismChain] = {
      multisigIsm: await ismFactory.deploy(ismChain, ismConfig),
    };
  }
  artifacts = writeMergedAddresses(contractsFilePath, artifacts, ismContracts);
  logGreen(`ISM contracts deployed `);

  // 5. Deploy TestRecipients to all deployable chains
  log(`Deploying test recipient contracts`);
  const testRecipientConfig = buildTestRecipientConfigMap(
    selectedChains,
    artifacts,
  );
  const testRecipientDeployer = new TestRecipientDeployer(multiProvider);
  testRecipientDeployer.cacheAddressesMap(artifacts);
  const testRecipients = await testRecipientDeployer.deploy(
    testRecipientConfig,
  );
  artifacts = writeMergedAddresses(
    contractsFilePath,
    artifacts,
    testRecipients,
  );
  logGreen(`Test recipient contracts deployed`);

  log('Writing agent configs');
  await writeAgentConfig(
    agentFilePath,
    artifacts,
    origin,
    remotes,
    multiProvider,
  );
  logGreen('Agent configs written');

  logBlue('Deployment is complete!');
  logBlue(`Contract address artifacts are in ${contractsFilePath}`);
  logBlue(`Agent configs are in ${agentFilePath}`);
}

function buildIsmConfig(
  owner: Address,
  remotes: ChainName[],
  multisigIsmConfigs: ChainMap<MultisigIsmConfig>,
): RoutingIsmConfig {
  const mergedMultisigIsmConfig: ChainMap<MultisigIsmConfig> = objMerge(
    defaultMultisigIsmConfigs,
    multisigIsmConfigs,
  );
  return {
    owner,
    type: ModuleType.ROUTING,
    domains: Object.fromEntries(
      remotes.map((remote) => [remote, mergedMultisigIsmConfig[remote]]),
    ),
  };
}

function buildIsmConfigMap(
  owner: Address,
  chains: ChainName[],
  remotes: ChainName[],
  multisigIsmConfigs: ChainMap<MultisigIsmConfig>,
): ChainMap<RoutingIsmConfig> {
  return Object.fromEntries(
    chains.map((chain) => {
      const ismConfig = buildIsmConfig(
        owner,
        remotes.filter((r) => r !== chain),
        multisigIsmConfigs,
      );
      return [chain, ismConfig];
    }),
  );
}

function buildCoreConfigMap(
  owner: Address,
  origin: ChainName,
  remotes: ChainName[],
  multisigIsmConfigs: ChainMap<MultisigIsmConfig>,
): ChainMap<CoreConfig> {
  const configMap: ChainMap<CoreConfig> = {};
  configMap[origin] = {
    owner,
    defaultIsm: buildIsmConfig(owner, remotes, multisigIsmConfigs),
  };
  return configMap;
}

function buildTestRecipientConfigMap(
  chains: ChainName[],
  addressesMap: HyperlaneAddressesMap<any>,
): ChainMap<TestRecipientConfig> {
  return Object.fromEntries(
    chains.map((chain) => {
      const interchainSecurityModule =
        // TODO revisit assumption that multisigIsm is always the ISM
        addressesMap[chain].multisigIsm ??
        addressesMap[chain].interchainSecurityModule ??
        ethers.constants.AddressZero;
      return [chain, { interchainSecurityModule }];
    }),
  );
}

function buildIgpConfigMap(
  owner: Address,
  deployChains: ChainName[],
  selectedChains: ChainName[],
  multisigIsmConfigs: ChainMap<MultisigIsmConfig>,
): ChainMap<OverheadIgpConfig> {
  const mergedMultisigIsmConfig: ChainMap<MultisigIsmConfig> = objMerge(
    defaultMultisigIsmConfigs,
    multisigIsmConfigs,
  );
  const configMap: ChainMap<OverheadIgpConfig> = {};
  for (const origin of deployChains) {
    const overhead: ChainMap<number> = {};
    const gasOracleType: ChainMap<GasOracleContractType> = {};
    for (const remote of selectedChains) {
      if (origin === remote) continue;
      overhead[remote] = multisigIsmVerificationCost(
        mergedMultisigIsmConfig[remote].threshold,
        mergedMultisigIsmConfig[remote].validators.length,
      );
      gasOracleType[remote] = GasOracleContractType.StorageGasOracle;
    }
    configMap[origin] = {
      owner,
      beneficiary: owner,
      gasOracleType,
      overhead,
      oracleKey: owner,
    };
  }
  return configMap;
}

function writeMergedAddresses(
  filePath: string,
  aAddresses: HyperlaneAddressesMap<any>,
  bContracts: HyperlaneContractsMap<any>,
): HyperlaneAddressesMap<any> {
  const bAddresses = serializeContractsMap(bContracts);
  const mergedAddresses = objMerge(aAddresses, bAddresses);
  writeJson(filePath, mergedAddresses);
  return mergedAddresses;
}

async function writeAgentConfig(
  filePath: string,
  artifacts: HyperlaneAddressesMap<any>,
  origin: ChainName,
  remotes: ChainName[],
  multiProvider: MultiProvider,
) {
  const selectedChains = [origin, ...remotes];
  const startBlocks: ChainMap<number> = { ...agentStartBlocks };
  startBlocks[origin] = await multiProvider
    .getProvider(origin)
    .getBlockNumber();

  const mergedAddressesMap: HyperlaneAddressesMap<any> = objMerge(
    sdkContractAddressesMap,
    artifacts,
  );
  const filteredAddressesMap = objFilter(
    mergedAddressesMap,
    (chain, v): v is HyperlaneAddresses<any> =>
      selectedChains.includes(chain) &&
      !!v.mailbox &&
      !!v.interchainGasPaymaster &&
      !!v.validatorAnnounce,
  ) as ChainMap<HyperlaneDeploymentArtifacts>;

  const agentConfig = buildAgentConfig(
    [origin],
    multiProvider,
    filteredAddressesMap,
    startBlocks,
  );
  writeJson(filePath, agentConfig);
}
