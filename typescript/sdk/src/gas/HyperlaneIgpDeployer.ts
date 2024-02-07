import debug from 'debug';
import { ethers } from 'ethers';

import {
  InterchainGasPaymaster,
  ProxyAdmin,
  StorageGasOracle,
  StorageGasOracle__factory,
} from '@hyperlane-xyz/core';
import { Address, eqAddress, warn } from '@hyperlane-xyz/utils';

import { HyperlaneContracts } from '../contracts/types';
import { HyperlaneDeployer } from '../deploy/HyperlaneDeployer';
import { MultiProvider } from '../providers/MultiProvider';
import { ChainMap, ChainName } from '../types';

import { IgpFactories, igpFactories } from './contracts';
import { prettyRemoteGasData } from './oracle/logging';
import { OracleConfig, StorageGasOracleConfig } from './oracle/types';
import { IgpConfig } from './types';

export class HyperlaneIgpDeployer extends HyperlaneDeployer<
  IgpConfig & Partial<OracleConfig>,
  IgpFactories
> {
  constructor(multiProvider: MultiProvider) {
    super(multiProvider, igpFactories, {
      logger: debug('hyperlane:IgpDeployer'),
    });
  }

  async deployInterchainGasPaymaster(
    chain: ChainName,
    proxyAdmin: ProxyAdmin,
    storageGasOracle: StorageGasOracle,
    config: IgpConfig,
  ): Promise<InterchainGasPaymaster> {
    const beneficiary = config.beneficiary;
    const igp = await this.deployProxiedContract(
      chain,
      'interchainGasPaymaster',
      proxyAdmin.address,
      [],
      [await this.multiProvider.getSignerAddress(chain), beneficiary],
    );

    const gasParamsToSet: InterchainGasPaymaster.GasParamStruct[] = [];
    const remotes = Object.keys(config.gasOracleType);
    for (const remote of remotes) {
      const remoteId = this.multiProvider.getDomainId(remote);
      const newGasOverhead = config.overhead[remote];

      const currentGasConfig = await igp.destinationGasConfigs(remoteId);
      if (
        !eqAddress(currentGasConfig.gasOracle, storageGasOracle.address) ||
        !currentGasConfig.gasOverhead.eq(newGasOverhead)
      ) {
        this.logger(
          `Setting gas params for ${chain} -> ${remote}: gasOverhead = ${newGasOverhead} gasOracle = ${storageGasOracle.address}`,
        );
        gasParamsToSet.push({
          remoteDomain: remoteId,
          config: {
            gasOverhead: newGasOverhead,
            gasOracle: storageGasOracle.address,
          },
        });
      }
    }

    if (gasParamsToSet.length > 0) {
      await this.runIfOwner(chain, igp, async () =>
        this.multiProvider.handleTx(
          chain,
          igp.setDestinationGasConfigs(
            gasParamsToSet,
            this.multiProvider.getTransactionOverrides(chain),
          ),
        ),
      );
    }

    return igp;
  }

  async deployStorageGasOracle(chain: ChainName): Promise<StorageGasOracle> {
    return this.deployContract(chain, 'storageGasOracle', []);
  }

  async configureStorageGasOracle(
    chain: ChainName,
    igp: InterchainGasPaymaster,
    gasOracleConfig: ChainMap<StorageGasOracleConfig>,
  ): Promise<void> {
    this.logger(`Configuring gas oracles for ${chain}...`);
    const remotes = Object.keys(gasOracleConfig);
    const configsToSet: Record<
      Address,
      StorageGasOracle.RemoteGasDataConfigStruct[]
    > = {};

    // For each remote, check if the gas oracle has the correct data
    for (const remote of remotes) {
      const desiredGasData = gasOracleConfig[remote];
      const remoteId = this.multiProvider.getDomainId(remote);
      // each destination can have a different gas oracle
      const gasOracleAddress = (await igp.destinationGasConfigs(remoteId))
        .gasOracle;

      if (eqAddress(gasOracleAddress, ethers.constants.AddressZero)) {
        warn(`No gas oracle set for ${chain} -> ${remote}, cannot configure`);
        continue;
      }
      const gasOracle = StorageGasOracle__factory.connect(
        gasOracleAddress,
        this.multiProvider.getSigner(chain),
      );
      configsToSet[gasOracleAddress] ||= [];

      this.logger(`Checking gas oracle ${gasOracleAddress} for ${remote}...`);
      const remoteGasDataConfig = await gasOracle.remoteGasData(remoteId);

      if (
        !remoteGasDataConfig.gasPrice.eq(desiredGasData.gasPrice) ||
        !remoteGasDataConfig.tokenExchangeRate.eq(
          desiredGasData.tokenExchangeRate,
        )
      ) {
        this.logger(
          `${chain} -> ${remote} existing gas data:\n`,
          prettyRemoteGasData(remoteGasDataConfig),
        );
        this.logger(
          `${chain} -> ${remote} desired gas data:\n`,
          prettyRemoteGasData(desiredGasData),
        );
        configsToSet[gasOracleAddress].push({
          remoteDomain: this.multiProvider.getDomainId(remote),
          ...desiredGasData,
        });
      }
    }
    // loop through each gas oracle and batch set the remote gas data
    for (const gasOracle of Object.keys(configsToSet)) {
      const gasOracleContract = StorageGasOracle__factory.connect(
        gasOracle,
        this.multiProvider.getSigner(chain),
      );
      if (configsToSet[gasOracle].length > 0) {
        await this.runIfOwner(chain, gasOracleContract, async () => {
          this.logger(
            `Setting gas oracle on ${gasOracle} for ${configsToSet[
              gasOracle
            ].map((config) => config.remoteDomain)}`,
          );
          return this.multiProvider.handleTx(
            chain,
            gasOracleContract.setRemoteGasDataConfigs(
              configsToSet[gasOracle],
              this.multiProvider.getTransactionOverrides(chain),
            ),
          );
        });
      }
    }
  }

  async deployContracts(
    chain: ChainName,
    config: IgpConfig & Partial<OracleConfig>,
  ): Promise<HyperlaneContracts<IgpFactories>> {
    // NB: To share ProxyAdmins with HyperlaneCore, ensure the ProxyAdmin
    // is loaded into the contract cache.
    const proxyAdmin = await this.deployContract(chain, 'proxyAdmin', []);

    const storageGasOracle = await this.deployStorageGasOracle(chain);
    const interchainGasPaymaster = await this.deployInterchainGasPaymaster(
      chain,
      proxyAdmin,
      storageGasOracle,
      config,
    );

    // Configure storage gas oracle with remote gas data if provided
    if (config.oracleConfig) {
      await this.configureStorageGasOracle(
        chain,
        interchainGasPaymaster,
        config.oracleConfig,
      );
    }

    await this.transferOwnershipOfContracts(chain, config.owner, {
      interchainGasPaymaster,
    });

    // Configure oracle key for StorageGasOracle separately to keep 'hot'
    // for updating exchange rates regularly
    await this.transferOwnershipOfContracts(chain, config.oracleKey, {
      storageGasOracle,
    });

    return {
      proxyAdmin,
      storageGasOracle,
      interchainGasPaymaster,
    };
  }
}
