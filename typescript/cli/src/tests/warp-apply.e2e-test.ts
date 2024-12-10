import { expect } from 'chai';
import { Signer, Wallet, ethers } from 'ethers';

import { InterchainAccountRouter__factory } from '@hyperlane-xyz/core';
import { ChainAddresses } from '@hyperlane-xyz/registry';
import {
  ChainMetadata,
  DerivedCoreConfig,
  HookType,
  HypTokenRouterConfig,
  TokenType,
  WarpRouteDeployConfig,
  normalizeConfig,
  randomAddress,
} from '@hyperlane-xyz/sdk';
import { Address, Domain } from '@hyperlane-xyz/utils';

import { readYamlOrJson, writeYamlOrJson } from '../utils/files.js';

import { hyperlaneCoreApply, readCoreConfig } from './commands/core.js';
import {
  ANVIL_KEY,
  CHAIN_2_METADATA_PATH,
  CHAIN_3_METADATA_PATH,
  CHAIN_NAME_2,
  CHAIN_NAME_3,
  CORE_CONFIG_PATH,
  CORE_READ_CONFIG_PATH_2,
  CORE_READ_CONFIG_PATH_3,
  DEFAULT_E2E_TEST_TIMEOUT,
  E2E_TEST_BURN_ADDRESS,
  EXAMPLES_PATH,
  REGISTRY_PATH,
  TEMP_PATH,
  WARP_CONFIG_PATH_2,
  WARP_CONFIG_PATH_EXAMPLE,
  WARP_CORE_CONFIG_PATH_2,
  deployOrUseExistingCore,
  extendWarpConfig,
  getDomainId,
  updateOwner,
} from './commands/helpers.js';
import {
  hyperlaneWarpApply,
  hyperlaneWarpDeploy,
  readWarpConfig,
} from './commands/warp.js';

describe('hyperlane warp apply e2e tests', async function () {
  this.timeout(2 * DEFAULT_E2E_TEST_TIMEOUT);

  let signer: Signer;
  let chain2Addresses: ChainAddresses = {};
  let initialOwnerAddress: Address;
  let chain2DomainId: Domain;
  let chain3DomainId: Domain;

  before(async function () {
    const chain2Metadata: ChainMetadata = readYamlOrJson(CHAIN_2_METADATA_PATH);
    const chain3Metadata: ChainMetadata = readYamlOrJson(CHAIN_3_METADATA_PATH);

    const provider = new ethers.providers.JsonRpcProvider(
      chain2Metadata.rpcUrls[0].http,
    );
    chain2DomainId = chain2Metadata.domainId;
    chain3DomainId = chain3Metadata.domainId;
    const wallet = new Wallet(ANVIL_KEY);
    signer = wallet.connect(provider);
    initialOwnerAddress = await signer.getAddress();

    [, chain2Addresses] = await Promise.all([
      deployOrUseExistingCore(CHAIN_NAME_2, CORE_CONFIG_PATH, ANVIL_KEY),
      deployOrUseExistingCore(CHAIN_NAME_3, CORE_CONFIG_PATH, ANVIL_KEY),
    ]);

    // Create a new warp config using the example
    const warpConfig: WarpRouteDeployConfig = readYamlOrJson(
      WARP_CONFIG_PATH_EXAMPLE,
    );
    const anvil2Config = { anvil2: { ...warpConfig.anvil1 } };
    writeYamlOrJson(WARP_CONFIG_PATH_2, anvil2Config);
  });

  beforeEach(async function () {
    await hyperlaneWarpDeploy(WARP_CONFIG_PATH_2);
  });

  it('should burn owner address', async function () {
    const warpConfigPath = `${TEMP_PATH}/warp-route-deployment-2.yaml`;
    await updateOwner(
      E2E_TEST_BURN_ADDRESS,
      CHAIN_NAME_2,
      warpConfigPath,
      WARP_CORE_CONFIG_PATH_2,
    );
    const updatedWarpDeployConfig = await readWarpConfig(
      CHAIN_NAME_2,
      WARP_CORE_CONFIG_PATH_2,
      warpConfigPath,
    );
    expect(updatedWarpDeployConfig.anvil2.owner).to.equal(
      E2E_TEST_BURN_ADDRESS,
    );
  });

  it('should not update the same owner', async () => {
    const warpConfigPath = `${TEMP_PATH}/warp-route-deployment-2.yaml`;
    await updateOwner(
      E2E_TEST_BURN_ADDRESS,
      CHAIN_NAME_2,
      warpConfigPath,
      WARP_CORE_CONFIG_PATH_2,
    );
    const { stdout } = await updateOwner(
      E2E_TEST_BURN_ADDRESS,
      CHAIN_NAME_2,
      warpConfigPath,
      WARP_CORE_CONFIG_PATH_2,
    );
    expect(stdout).to.include(
      'Warp config is the same as target. No updates needed.',
    );
  });

  it('should update hook configuration', async () => {
    const warpDeployPath = `${TEMP_PATH}/warp-route-deployment-2.yaml`;

    // First read the existing config
    const warpDeployConfig = await readWarpConfig(
      CHAIN_NAME_2,
      WARP_CORE_CONFIG_PATH_2,
      warpDeployPath,
    );

    // Update with a new hook config
    const owner = randomAddress();
    warpDeployConfig[CHAIN_NAME_2].hook = {
      type: HookType.PROTOCOL_FEE,
      beneficiary: owner,
      maxProtocolFee: '1000000',
      protocolFee: '100000',
      owner,
    };

    // Write the updated config
    await writeYamlOrJson(warpDeployPath, warpDeployConfig);

    // Apply the changes
    await hyperlaneWarpApply(warpDeployPath, WARP_CORE_CONFIG_PATH_2);

    // Read back the config to verify changes
    const updatedConfig = await readWarpConfig(
      CHAIN_NAME_2,
      WARP_CORE_CONFIG_PATH_2,
      warpDeployPath,
    );

    // Verify the hook was updated with all properties
    expect(normalizeConfig(updatedConfig[CHAIN_NAME_2].hook)).to.deep.equal(
      normalizeConfig(warpDeployConfig[CHAIN_NAME_2].hook),
    );
  });

  it('should extend an existing warp route', async () => {
    // Read existing config into a file
    const warpConfigPath = `${TEMP_PATH}/warp-route-deployment-2.yaml`;
    await readWarpConfig(CHAIN_NAME_2, WARP_CORE_CONFIG_PATH_2, warpConfigPath);

    // Extend with new config
    const config: HypTokenRouterConfig = {
      decimals: 18,
      mailbox: chain2Addresses!.mailbox,
      name: 'Ether',
      owner: new Wallet(ANVIL_KEY).address,
      symbol: 'ETH',
      totalSupply: 0,
      type: TokenType.native,
    };

    await extendWarpConfig({
      chain: CHAIN_NAME_2,
      chainToExtend: CHAIN_NAME_3,
      extendedConfig: config,
      warpCorePath: WARP_CORE_CONFIG_PATH_2,
      warpDeployPath: warpConfigPath,
    });

    const COMBINED_WARP_CORE_CONFIG_PATH = `${REGISTRY_PATH}/deployments/warp_routes/ETH/anvil2-anvil3-config.yaml`;

    // Check that chain2 is enrolled in chain1
    const updatedWarpDeployConfig1 = await readWarpConfig(
      CHAIN_NAME_2,
      COMBINED_WARP_CORE_CONFIG_PATH,
      warpConfigPath,
    );

    const chain2Id = await getDomainId(CHAIN_NAME_3, ANVIL_KEY);
    const remoteRouterKeys1 = Object.keys(
      updatedWarpDeployConfig1[CHAIN_NAME_2].remoteRouters!,
    );
    expect(remoteRouterKeys1).to.include(chain2Id);

    // Check that chain1 is enrolled in chain2
    const updatedWarpDeployConfig2 = await readWarpConfig(
      CHAIN_NAME_3,
      COMBINED_WARP_CORE_CONFIG_PATH,
      warpConfigPath,
    );

    const chain1Id = await getDomainId(CHAIN_NAME_2, ANVIL_KEY);
    const remoteRouterKeys2 = Object.keys(
      updatedWarpDeployConfig2[CHAIN_NAME_3].remoteRouters!,
    );
    expect(remoteRouterKeys2).to.include(chain1Id);
  });

  it('should extend an existing warp route with json strategy', async () => {
    // Read existing config into a file
    const warpConfigPath = `${TEMP_PATH}/warp-route-deployment-2.yaml`;
    await readWarpConfig(CHAIN_NAME_2, WARP_CORE_CONFIG_PATH_2, warpConfigPath);

    // Extend with new config
    const config: HypTokenRouterConfig = {
      decimals: 18,
      mailbox: chain2Addresses!.mailbox,
      name: 'Ether',
      owner: new Wallet(ANVIL_KEY).address,
      symbol: 'ETH',
      totalSupply: 0,
      type: TokenType.native,
    };

    await extendWarpConfig({
      chain: CHAIN_NAME_2,
      chainToExtend: CHAIN_NAME_3,
      extendedConfig: config,
      warpCorePath: WARP_CORE_CONFIG_PATH_2,
      warpDeployPath: warpConfigPath,
      strategyUrl: `${EXAMPLES_PATH}/submit/strategy/json-rpc-chain-strategy.yaml`,
    });

    const COMBINED_WARP_CORE_CONFIG_PATH = `${REGISTRY_PATH}/deployments/warp_routes/ETH/anvil2-anvil3-config.yaml`;

    // Check that chain2 is enrolled in chain1
    const updatedWarpDeployConfig1 = await readWarpConfig(
      CHAIN_NAME_2,
      COMBINED_WARP_CORE_CONFIG_PATH,
      warpConfigPath,
    );

    const chain2Id = await getDomainId(CHAIN_NAME_3, ANVIL_KEY);
    const remoteRouterKeys1 = Object.keys(
      updatedWarpDeployConfig1[CHAIN_NAME_2].remoteRouters!,
    );
    expect(remoteRouterKeys1).to.include(chain2Id);

    // Check that chain1 is enrolled in chain2
    const updatedWarpDeployConfig2 = await readWarpConfig(
      CHAIN_NAME_3,
      COMBINED_WARP_CORE_CONFIG_PATH,
      warpConfigPath,
    );

    const chain1Id = await getDomainId(CHAIN_NAME_2, ANVIL_KEY);
    const remoteRouterKeys2 = Object.keys(
      updatedWarpDeployConfig2[CHAIN_NAME_3].remoteRouters!,
    );
    expect(remoteRouterKeys2).to.include(chain1Id);
  });

  it('should extend an existing warp route and update the owner', async () => {
    const warpDeployPath = `${TEMP_PATH}/warp-route-deployment-2.yaml`;
    // Burn anvil2 owner in config
    const warpDeployConfig = await readWarpConfig(
      CHAIN_NAME_2,
      WARP_CORE_CONFIG_PATH_2,
      warpDeployPath,
    );
    warpDeployConfig[CHAIN_NAME_2].owner = E2E_TEST_BURN_ADDRESS;

    // Extend with new config
    const randomOwner = new Wallet(ANVIL_KEY).address;
    const extendedConfig: HypTokenRouterConfig = {
      decimals: 18,
      mailbox: chain2Addresses!.mailbox,
      name: 'Ether',
      owner: randomOwner,
      symbol: 'ETH',
      totalSupply: 0,
      type: TokenType.native,
    };

    warpDeployConfig[CHAIN_NAME_3] = extendedConfig;
    writeYamlOrJson(warpDeployPath, warpDeployConfig);
    await hyperlaneWarpApply(warpDeployPath, WARP_CORE_CONFIG_PATH_2);

    const COMBINED_WARP_CORE_CONFIG_PATH = `${REGISTRY_PATH}/deployments/warp_routes/ETH/anvil2-anvil3-config.yaml`;

    const updatedWarpDeployConfig_2 = await readWarpConfig(
      CHAIN_NAME_2,
      COMBINED_WARP_CORE_CONFIG_PATH,
      warpDeployPath,
    );
    const updatedWarpDeployConfig_3 = await readWarpConfig(
      CHAIN_NAME_3,
      COMBINED_WARP_CORE_CONFIG_PATH,
      warpDeployPath,
    );
    // Check that anvil2 owner is burned
    expect(updatedWarpDeployConfig_2.anvil2.owner).to.equal(
      E2E_TEST_BURN_ADDRESS,
    );

    // Also, anvil3 owner is not burned
    expect(updatedWarpDeployConfig_3.anvil3.owner).to.equal(randomOwner);

    // Check that both chains enrolled
    const chain2Id = await getDomainId(CHAIN_NAME_2, ANVIL_KEY);
    const chain3Id = await getDomainId(CHAIN_NAME_3, ANVIL_KEY);

    const remoteRouterKeys2 = Object.keys(
      updatedWarpDeployConfig_2[CHAIN_NAME_2].remoteRouters!,
    );
    const remoteRouterKeys3 = Object.keys(
      updatedWarpDeployConfig_3[CHAIN_NAME_3].remoteRouters!,
    );
    expect(remoteRouterKeys2).to.include(chain3Id);
    expect(remoteRouterKeys3).to.include(chain2Id);
  });

  it('should extend an existing warp route and update all destination domains', async () => {
    // Read existing config into a file
    const warpConfigPath = `${TEMP_PATH}/warp-route-deployment-2.yaml`;
    const warpDeployConfig = await readWarpConfig(
      CHAIN_NAME_2,
      WARP_CORE_CONFIG_PATH_2,
      warpConfigPath,
    );
    warpDeployConfig[CHAIN_NAME_2].gas = 7777;

    // Extend with new config
    const GAS = 694200;
    const extendedConfig: HypTokenRouterConfig = {
      decimals: 18,
      mailbox: chain2Addresses!.mailbox,
      name: 'Ether',
      owner: new Wallet(ANVIL_KEY).address,
      symbol: 'ETH',
      totalSupply: 0,
      type: TokenType.native,
      gas: GAS,
    };
    warpDeployConfig[CHAIN_NAME_3] = extendedConfig;
    writeYamlOrJson(warpConfigPath, warpDeployConfig);
    await hyperlaneWarpApply(warpConfigPath, WARP_CORE_CONFIG_PATH_2);

    const COMBINED_WARP_CORE_CONFIG_PATH = `${REGISTRY_PATH}/deployments/warp_routes/ETH/anvil2-anvil3-config.yaml`;

    // Check that chain2 is enrolled in chain1
    const updatedWarpDeployConfig_2 = await readWarpConfig(
      CHAIN_NAME_2,
      COMBINED_WARP_CORE_CONFIG_PATH,
      warpConfigPath,
    );

    const chain2Id = await getDomainId(CHAIN_NAME_2, ANVIL_KEY);
    const chain3Id = await getDomainId(CHAIN_NAME_3, ANVIL_KEY);

    // Destination gas should be set in the existing chain (chain2) to include the extended chain (chain3)
    const destinationGas_2 =
      updatedWarpDeployConfig_2[CHAIN_NAME_2].destinationGas!;
    expect(Object.keys(destinationGas_2)).to.include(chain3Id);
    expect(destinationGas_2[chain3Id]).to.equal(GAS.toString());

    // Destination gas should be set for the extended chain (chain3)
    const updatedWarpDeployConfig_3 = await readWarpConfig(
      CHAIN_NAME_3,
      COMBINED_WARP_CORE_CONFIG_PATH,
      warpConfigPath,
    );
    const destinationGas_3 =
      updatedWarpDeployConfig_3[CHAIN_NAME_3].destinationGas!;
    expect(Object.keys(destinationGas_3)).to.include(chain2Id);
    expect(destinationGas_3[chain2Id]).to.equal('7777');
  });

  it('should relay the ICA transaction to update the warp on the destination chain', async () => {
    // Add the remote ica on chain anvil3
    const CORE_READ_CHAIN_2_CONFIG_PATH = `${TEMP_PATH}/${CHAIN_NAME_2}/core-config-read.yaml`;
    const CORE_READ_CHAIN_3_CONFIG_PATH = `${TEMP_PATH}/${CHAIN_NAME_3}/core-config-read.yaml`;

    const [coreConfigChain2, coreConfigChain3]: DerivedCoreConfig[] =
      await Promise.all([
        readCoreConfig(CHAIN_NAME_2, CORE_READ_CHAIN_2_CONFIG_PATH),
        readCoreConfig(CHAIN_NAME_3, CORE_READ_CHAIN_3_CONFIG_PATH),
      ]);

    const coreConfigChain2IcaConfig = coreConfigChain2.interchainAccountRouter!;
    const coreConfigChain3IcaConfig = coreConfigChain3.interchainAccountRouter!;
    coreConfigChain2IcaConfig.remoteIcaRouters = {
      [chain3DomainId]: {
        address: coreConfigChain3IcaConfig.address,
      },
    };

    writeYamlOrJson(CORE_READ_CHAIN_2_CONFIG_PATH, coreConfigChain2);
    await hyperlaneCoreApply(CHAIN_NAME_2, CORE_READ_CHAIN_2_CONFIG_PATH);

    // Read existing config into a file
    const warpConfigChain2Path = `${TEMP_PATH}/warp-route-deployment-2.yaml`;
    const warpConfigChain3Path = `${TEMP_PATH}/warp-route-deployment-3.yaml`;
    const warpDeployConfig = await readWarpConfig(
      CHAIN_NAME_2,
      WARP_CORE_CONFIG_PATH_2,
      warpConfigChain2Path,
    );

    // Extend the warp route to add a token on chain 3
    const extendedConfig: HypTokenRouterConfig = {
      decimals: 18,
      mailbox: chain2Addresses!.mailbox,
      name: 'Ether',
      owner: initialOwnerAddress,
      symbol: 'ETH',
      totalSupply: 0,
      type: TokenType.native,
    };
    warpDeployConfig[CHAIN_NAME_3] = extendedConfig;
    writeYamlOrJson(warpConfigChain2Path, warpDeployConfig);
    await hyperlaneWarpApply(warpConfigChain2Path, WARP_CORE_CONFIG_PATH_2);

    const COMBINED_WARP_CORE_CONFIG_PATH = `${REGISTRY_PATH}/deployments/warp_routes/ETH/anvil2-anvil3-config.yaml`;
    const [updatedWarpDeployConfig_2, updatedWarpDeployConfig_3] =
      await Promise.all([
        readWarpConfig(
          CHAIN_NAME_2,
          COMBINED_WARP_CORE_CONFIG_PATH,
          warpConfigChain2Path,
        ),
        readWarpConfig(
          CHAIN_NAME_3,
          COMBINED_WARP_CORE_CONFIG_PATH,
          warpConfigChain3Path,
        ),
      ]);

    // Get the ICA router addresses and the associated ICA account address on chain3
    const [core2Config, core3Config]: DerivedCoreConfig[] = await Promise.all([
      readCoreConfig(CHAIN_NAME_2, CORE_READ_CONFIG_PATH_2),
      readCoreConfig(CHAIN_NAME_3, CORE_READ_CONFIG_PATH_3),
    ]);

    const chain2IcaRouter = InterchainAccountRouter__factory.connect(
      core2Config.interchainAccountRouter!.address,
      signer,
    );
    const remoteIcaAccountAddress = await chain2IcaRouter.callStatic[
      'getRemoteInterchainAccount(address,address,address)'
    ](
      initialOwnerAddress,
      core3Config.interchainAccountRouter!.address,
      ethers.constants.AddressZero,
    );

    // Transfer ownership of the warp token on chain3 to the ICA account
    warpDeployConfig[CHAIN_NAME_2] = updatedWarpDeployConfig_2[CHAIN_NAME_2];
    warpDeployConfig[CHAIN_NAME_3] = updatedWarpDeployConfig_3[CHAIN_NAME_3];
    warpDeployConfig[CHAIN_NAME_3].owner = remoteIcaAccountAddress;
    writeYamlOrJson(warpConfigChain2Path, warpDeployConfig);
    await hyperlaneWarpApply(
      warpConfigChain2Path,
      COMBINED_WARP_CORE_CONFIG_PATH,
    );

    // Update the remote gas for chain2 on chain3 and run warp apply with an ICA strategy
    const expectedChain2Gas = '46000';
    updatedWarpDeployConfig_3[CHAIN_NAME_3].destinationGas = {
      [chain2DomainId]: expectedChain2Gas,
    };
    writeYamlOrJson(warpConfigChain2Path, warpDeployConfig);

    await hyperlaneWarpApply(
      warpConfigChain2Path,
      COMBINED_WARP_CORE_CONFIG_PATH,
      './examples/submit/strategy/json-rpc-ica-strategy.yaml',
      true,
    );

    const updatedWarpDeployConfig_3_2 = await readWarpConfig(
      CHAIN_NAME_3,
      COMBINED_WARP_CORE_CONFIG_PATH,
      warpConfigChain2Path,
    );

    expect(
      updatedWarpDeployConfig_3_2[CHAIN_NAME_3].destinationGas![chain2DomainId],
    ).to.equal(expectedChain2Gas);
  });
});
