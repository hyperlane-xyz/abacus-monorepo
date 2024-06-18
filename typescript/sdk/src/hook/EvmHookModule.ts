import { BigNumber, ethers } from 'ethers';

import {
  DomainRoutingHook,
  DomainRoutingHook__factory,
  FallbackDomainRoutingHook,
  IL1CrossDomainMessenger__factory,
  IPostDispatchHook__factory,
  InterchainGasPaymaster,
  OPStackHook,
  OPStackIsm__factory,
  PausableHook,
  ProtocolFee,
  StaticAggregationHook,
  StaticAggregationHookFactory__factory,
  StaticAggregationHook__factory,
  StorageGasOracle,
} from '@hyperlane-xyz/core';
import {
  Address,
  ProtocolType,
  addressToBytes32,
  configDeepEquals,
  normalizeConfig,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { TOKEN_EXCHANGE_RATE_SCALE } from '../consts/igp.js';
import { HyperlaneAddresses } from '../contracts/types.js';
import {
  HyperlaneModule,
  HyperlaneModuleParams,
} from '../core/AbstractHyperlaneModule.js';
import { CoreAddresses } from '../core/contracts.js';
import { ProxyFactoryFactories } from '../deploy/contracts.js';
import { IgpConfig } from '../gas/types.js';
import { EvmIsmModule } from '../ism/EvmIsmModule.js';
import { IsmType, OpStackIsmConfig } from '../ism/types.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { AnnotatedEV5Transaction } from '../providers/ProviderType.js';
import { ChainNameOrId } from '../types.js';

import { EvmHookReader } from './EvmHookReader.js';
import { HyperlaneHookDeployer } from './HyperlaneHookDeployer.js';
import { DeployedHook } from './contracts.js';
import {
  AggregationHookConfig,
  DomainRoutingHookConfig,
  FallbackRoutingHookConfig,
  HookConfig,
  HookType,
  IgpHookConfig,
  OpStackHookConfig,
  PausableHookConfig,
  ProtocolFeeHookConfig,
} from './types.js';

type HookModuleAddresses = {
  deployedHook: Address;
  mailbox: Address;
  proxyAdmin: Address;
};

export class EvmHookModule extends HyperlaneModule<
  ProtocolType.Ethereum,
  HookConfig,
  HyperlaneAddresses<ProxyFactoryFactories> & HookModuleAddresses
> {
  protected readonly logger = rootLogger.child({ module: 'EvmHookModule' });
  protected readonly reader: EvmHookReader;

  // Adding these to reduce how often we need to grab from MultiProvider.
  public readonly chainName: string;
  // We use domainId here because MultiProvider.getDomainId() will always
  // return a number, and EVM the domainId and chainId are the same.
  public readonly domainId: number;

  // Transaction overrides for the chain
  protected readonly txOverrides: Partial<ethers.providers.TransactionRequest>;

  protected constructor(
    protected readonly multiProvider: MultiProvider,
    protected readonly deployer: HyperlaneHookDeployer,
    args: HyperlaneModuleParams<
      HookConfig,
      HyperlaneAddresses<ProxyFactoryFactories> & HookModuleAddresses
    >,
  ) {
    super(args);
    this.reader = new EvmHookReader(multiProvider, this.args.chain);

    this.chainName = this.multiProvider.getChainName(this.args.chain);
    this.domainId = this.multiProvider.getDomainId(this.chainName);

    this.txOverrides = this.multiProvider.getTransactionOverrides(
      this.chainName,
    );
  }

  public async read(): Promise<HookConfig> {
    const config = await this.reader.deriveHookConfig(
      this.args.addresses.deployedHook,
    );
    return normalizeConfig(config);
  }

  public async update(_config: HookConfig): Promise<AnnotatedEV5Transaction[]> {
    throw new Error('Method not implemented.');
  }

  // manually write static create function
  public static async create({
    chain,
    config,
    deployer,
    factories,
    coreAddresses,
    multiProvider,
  }: {
    chain: ChainNameOrId;
    config: HookConfig;
    deployer: HyperlaneHookDeployer;
    factories: HyperlaneAddresses<ProxyFactoryFactories>;
    coreAddresses: CoreAddresses;
    multiProvider: MultiProvider;
  }): Promise<EvmHookModule> {
    // instantiate new EvmHookModule
    const module = new EvmHookModule(multiProvider, deployer, {
      addresses: {
        ...factories,
        ...coreAddresses,
        deployedHook: ethers.constants.AddressZero,
      },
      chain,
      config,
    });

    // deploy hook and assign address to module
    const deployedHook = await module.deploy({ config });
    module.args.addresses.deployedHook = deployedHook.address;

    return module;
  }

  // Compute delta between current and target domain configurations
  protected async computeRoutingHooksToSet({
    currentDomains,
    targetDomains,
  }: {
    currentDomains: DomainRoutingHookConfig['domains'];
    targetDomains: DomainRoutingHookConfig['domains'];
  }): Promise<DomainRoutingHook.HookConfigStruct[]> {
    const routingHookUpdates: DomainRoutingHook.HookConfigStruct[] = [];

    // Iterate over the target domains and compare with the current configuration
    for (const [dest, targetDomainConfig] of Object.entries(targetDomains)) {
      const destDomain = this.multiProvider.tryGetDomainId(dest);
      if (!destDomain) {
        this.logger.warn(`Domain not found in MultiProvider: ${dest}`);
        continue;
      }

      // If the domain is not in the current config or the config has changed, deploy a new hook
      // TODO: in-place updates per domain as a future optimization
      if (!configDeepEquals(currentDomains[dest], targetDomainConfig)) {
        const domainHook = await this.deploy({
          config: targetDomainConfig,
        });

        routingHookUpdates.push({
          destination: destDomain,
          hook: domainHook.address,
        });
      }
    }

    return routingHookUpdates;
  }

  // Updates a routing hook
  protected async updateRoutingHook({
    current,
    target,
  }: {
    current: DomainRoutingHookConfig | FallbackRoutingHookConfig;
    target: DomainRoutingHookConfig | FallbackRoutingHookConfig;
  }): Promise<AnnotatedEV5Transaction[]> {
    // Deploy a new fallback hook if the fallback config has changed
    if (
      target.type === HookType.FALLBACK_ROUTING &&
      !configDeepEquals(
        target.fallback,
        (current as FallbackRoutingHookConfig).fallback,
      )
    ) {
      const hook = await this.deploy({ config: target });
      this.args.addresses.deployedHook = hook.address;
    }

    const routingUpdates = await this.computeRoutingHooksToSet({
      currentDomains: current.domains,
      targetDomains: target.domains,
    });

    // Return if no updates are required
    if (routingUpdates.length === 0) {
      return [];
    }

    // Create tx for setting hooks
    return [
      {
        annotation: 'Updating routing hooks...',
        chainId: this.domainId,
        to: this.args.addresses.deployedHook,
        data: DomainRoutingHook__factory.createInterface().encodeFunctionData(
          'setHooks',
          [routingUpdates],
        ),
      },
    ];
  }

  protected async deploy({
    config,
  }: {
    config: HookConfig;
  }): Promise<DeployedHook> {
    // If it's a custom ISM, just return a base ISM
    if (typeof config === 'string') {
      // TODO: https://github.com/hyperlane-xyz/hyperlane-monorepo/issues/3773
      // we can remove the ts-ignore once we have a proper type for custom ISMs
      // @ts-ignore
      return IPostDispatchHook__factory.connect(
        config,
        this.multiProvider.getSignerOrProvider(this.args.chain),
      );
    }

    switch (config.type) {
      case HookType.MERKLE_TREE:
        return this.deployer.deployNewContract(this.chainName, config.type, [
          this.args.addresses.mailbox,
        ]);
      case HookType.INTERCHAIN_GAS_PAYMASTER:
        return this.deployIgpHook({ config });
      case HookType.AGGREGATION:
        return this.deployAggregationHook({ config });
      case HookType.PROTOCOL_FEE:
        return this.deployProtocolFeeHook({ config });
      case HookType.OP_STACK:
        return this.deployOpStackHook({ config });
      case HookType.ROUTING:
      case HookType.FALLBACK_ROUTING:
        return this.deployRoutingHook({ config });
      case HookType.PAUSABLE: {
        return this.deployPausableHook({ config });
      }
      default:
        throw new Error(`Unsupported hook config: ${config}`);
    }
  }

  protected async deployProtocolFeeHook({
    config,
  }: {
    config: ProtocolFeeHookConfig;
  }): Promise<ProtocolFee> {
    this.logger.debug('Deploying ProtocolFeeHook...');
    return this.deployer.deployNewContract(
      this.chainName,
      HookType.PROTOCOL_FEE,
      [
        config.maxProtocolFee,
        config.protocolFee,
        config.beneficiary,
        config.owner,
      ],
    );
  }

  protected async deployPausableHook({
    config,
  }: {
    config: PausableHookConfig;
  }): Promise<PausableHook> {
    this.logger.debug('Deploying PausableHook...');
    const hook = await this.deployer.deployNewContract(
      this.chainName,
      HookType.PAUSABLE,
      [],
    );

    // transfer ownership
    await this.multiProvider.handleTx(
      this.chainName,
      hook.transferOwnership(config.owner, this.txOverrides),
    );

    return hook;
  }

  protected async deployAggregationHook({
    config,
  }: {
    config: AggregationHookConfig;
  }): Promise<StaticAggregationHook> {
    this.logger.debug('Deploying AggregationHook...');

    // deploy subhooks
    const aggregatedHooks = [];
    for (const hookConfig of config.hooks) {
      const { address } = await this.deploy({ config: hookConfig });
      aggregatedHooks.push(address);
    }

    // deploy aggregation hook
    this.logger.debug(
      `Deploying aggregation hook of type ${config.hooks.map((h) =>
        typeof h === 'string' ? h : h.type,
      )}...`,
    );
    const signer = this.multiProvider.getSigner(this.chainName);
    const factory = StaticAggregationHookFactory__factory.connect(
      this.args.addresses.staticAggregationHookFactory,
      signer,
    );
    const address = await EvmIsmModule.deployStaticAddressSet({
      chain: this.chainName,
      factory,
      values: aggregatedHooks,
      logger: this.logger,
      multiProvider: this.multiProvider,
    });

    // return aggregation hook
    return StaticAggregationHook__factory.connect(address, signer);
  }

  protected async deployOpStackHook({
    config,
  }: {
    config: OpStackHookConfig;
  }): Promise<OPStackHook> {
    const chain = this.chainName;
    const mailbox = this.args.addresses.mailbox;
    this.logger.debug(
      'Deploying OPStackHook for %s to %s...',
      chain,
      config.destinationChain,
    );

    // fetch l2 messenger address from l1 messenger
    const l1Messenger = IL1CrossDomainMessenger__factory.connect(
      config.nativeBridge,
      this.multiProvider.getSignerOrProvider(chain),
    );
    const l2Messenger: Address = await l1Messenger.OTHER_MESSENGER();
    // deploy opstack ism
    const ismConfig: OpStackIsmConfig = {
      type: IsmType.OP_STACK,
      origin: chain,
      nativeBridge: l2Messenger,
    };

    // deploy opstack ism
    const opStackIsmAddress = (
      await EvmIsmModule.create({
        chain: config.destinationChain,
        config: ismConfig,
        deployer: this.deployer,
        factories: this.args.addresses,
        mailbox: mailbox,
        multiProvider: this.multiProvider,
      })
    ).serialize().deployedIsm;

    // connect to ISM
    const opstackIsm = OPStackIsm__factory.connect(
      opStackIsmAddress,
      this.multiProvider.getSignerOrProvider(config.destinationChain),
    );

    // deploy opstack hook
    const hook = await this.deployer.deployNewContract(
      chain,
      HookType.OP_STACK,
      [
        mailbox,
        this.multiProvider.getDomainId(config.destinationChain),
        addressToBytes32(opstackIsm.address),
        config.nativeBridge,
      ],
    );

    // set authorized hook on opstack ism
    const authorizedHook = await opstackIsm.authorizedHook();
    if (authorizedHook === addressToBytes32(hook.address)) {
      this.logger.debug(
        'Authorized hook already set on ism %s',
        opstackIsm.address,
      );
      return hook;
    } else if (
      authorizedHook !== addressToBytes32(ethers.constants.AddressZero)
    ) {
      this.logger.debug(
        'Authorized hook mismatch on ism %s, expected %s, got %s',
        opstackIsm.address,
        addressToBytes32(hook.address),
        authorizedHook,
      );
      throw new Error('Authorized hook mismatch');
    }

    // check if mismatch and redeploy hook
    this.logger.debug(
      'Setting authorized hook %s on ism % on destination %s',
      hook.address,
      opstackIsm.address,
      config.destinationChain,
    );
    await this.multiProvider.handleTx(
      config.destinationChain,
      opstackIsm.setAuthorizedHook(
        addressToBytes32(hook.address),
        this.multiProvider.getTransactionOverrides(config.destinationChain),
      ),
    );

    return hook;
  }

  protected async deployRoutingHook({
    config,
  }: {
    config: DomainRoutingHookConfig | FallbackRoutingHookConfig;
  }): Promise<DomainRoutingHook> {
    // originally set owner to deployer so we can set hooks
    const deployerAddress = await this.multiProvider.getSignerAddress(
      this.chainName,
    );

    let routingHook: DomainRoutingHook | FallbackDomainRoutingHook;
    if (config.type === HookType.FALLBACK_ROUTING) {
      // deploy fallback hook
      const fallbackHook = await this.deploy({ config: config.fallback });
      // deploy routing hook with fallback
      routingHook = await this.deployer.deployNewContract(
        this.chainName,
        HookType.FALLBACK_ROUTING,
        [this.args.addresses.mailbox, deployerAddress, fallbackHook.address],
      );
    } else {
      // deploy routing hook
      routingHook = await this.deployer.deployNewContract(
        this.chainName,
        HookType.ROUTING,
        [this.args.addresses.mailbox, deployerAddress],
      );
    }

    // compute the hooks that need to be set
    const hooksToSet = await this.computeRoutingHooksToSet({
      currentDomains: {},
      targetDomains: config.domains,
    });

    // set hooks
    await this.multiProvider.handleTx(
      this.chainName,
      routingHook.setHooks(hooksToSet, this.txOverrides),
    );

    // transfer ownership
    await this.multiProvider.handleTx(
      this.chainName,
      routingHook.transferOwnership(config.owner, this.txOverrides),
    );

    // return a fully configured routing hook
    return routingHook;
  }

  protected async deployIgpHook({
    config,
  }: {
    config: IgpHookConfig;
  }): Promise<InterchainGasPaymaster> {
    this.logger.debug('Deploying IGP as hook...');

    // Deploy the StorageGasOracle
    const storageGasOracle = await this.deployStorageGasOracle({
      config,
    });

    // Deploy the InterchainGasPaymaster
    const interchainGasPaymaster = await this.deployInterchainGasPaymaster({
      storageGasOracle,
      config,
    });

    return interchainGasPaymaster;
  }

  protected async deployInterchainGasPaymaster({
    storageGasOracle,
    config,
  }: {
    storageGasOracle: StorageGasOracle;
    config: IgpConfig;
  }): Promise<InterchainGasPaymaster> {
    const deployerAddress = await this.multiProvider.getSignerAddress(
      this.chainName,
    );
    const igp = await this.deployer.igpDeployer.deployProxiedContract(
      this.chainName,
      'interchainGasPaymaster',
      'interchainGasPaymaster',
      this.args.addresses.proxyAdmin,
      [],
      [deployerAddress, config.beneficiary],
    );

    const gasParamsToSet: InterchainGasPaymaster.GasParamStruct[] = [];
    for (const [remote, gasOverhead] of Object.entries(config.overhead)) {
      // TODO: add back support for non-EVM remotes.
      // Previously would check core metadata for non EVMs and fallback to multiprovider for custom EVMs
      const remoteDomain = this.multiProvider.tryGetDomainId(remote);
      if (!remoteDomain) {
        this.logger.warn(
          `Skipping overhead ${this.chainName} -> ${remote}. Expected if the remote is a non-EVM chain.`,
        );
        continue;
      }

      this.logger.debug(
        `Setting gas params for ${this.chainName} -> ${remote}: gasOverhead = ${gasOverhead} gasOracle = ${storageGasOracle.address}`,
      );
      gasParamsToSet.push({
        remoteDomain,
        config: {
          gasOverhead,
          gasOracle: storageGasOracle.address,
        },
      });
    }

    if (gasParamsToSet.length > 0) {
      await this.multiProvider.handleTx(
        this.chainName,
        igp.setDestinationGasConfigs(gasParamsToSet, this.txOverrides),
      );
    }

    // Transfer igp to the configured owner
    await this.multiProvider.handleTx(
      this.chainName,
      igp.transferOwnership(config.owner, this.txOverrides),
    );

    return igp;
  }

  protected async deployStorageGasOracle({
    config,
  }: {
    config: IgpConfig;
  }): Promise<StorageGasOracle> {
    const gasOracle = await this.deployer.igpDeployer.deployNewContract(
      this.chainName,
      'storageGasOracle',
      [],
    );

    if (!config.oracleConfig) {
      this.logger.debug('No oracle config provided, skipping...');
      return gasOracle;
    }

    this.logger.info(`Configuring gas oracle from ${this.chainName}...`);
    const configsToSet: Array<StorageGasOracle.RemoteGasDataConfigStruct> = [];

    for (const [remote, desired] of Object.entries(config.oracleConfig)) {
      // TODO: add back support for non-EVM remotes.
      // Previously would check core metadata for non EVMs and fallback to multiprovider for custom EVMs
      const remoteDomain = this.multiProvider.tryGetDomainId(remote);
      if (!remoteDomain) {
        this.logger.warn(
          `Skipping gas oracle ${this.chainName} -> ${remote}.` +
            ' Expected if the remote is a non-EVM chain or the remote domain is not the in the MultiProvider.',
        );
        continue;
      }

      configsToSet.push({
        remoteDomain,
        ...desired,
      });

      // Log an example remote gas cost
      const exampleRemoteGas = (config.overhead[remote] ?? 200_000) + 50_000;
      const exampleRemoteGasCost = BigNumber.from(desired.tokenExchangeRate)
        .mul(desired.gasPrice)
        .mul(exampleRemoteGas)
        .div(TOKEN_EXCHANGE_RATE_SCALE);
      this.logger.info(
        `${
          this.chainName
        } -> ${remote}: ${exampleRemoteGas} remote gas cost: ${ethers.utils.formatEther(
          exampleRemoteGasCost,
        )}`,
      );
    }

    if (configsToSet.length > 0) {
      await this.multiProvider.handleTx(
        this.chainName,
        gasOracle.setRemoteGasDataConfigs(configsToSet, this.txOverrides),
      );
    }

    // Transfer gas oracle to the configured owner
    await this.multiProvider.handleTx(
      this.chainName,
      gasOracle.transferOwnership(config.oracleKey, this.txOverrides),
    );

    return gasOracle;
  }
}
