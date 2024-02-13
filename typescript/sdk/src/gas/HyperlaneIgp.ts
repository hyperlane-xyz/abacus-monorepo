import { BigNumber } from 'ethers';

import { InterchainGasPaymaster__factory } from '@hyperlane-xyz/core';
import { Address } from '@hyperlane-xyz/utils';

import { HyperlaneApp } from '../app/HyperlaneApp';
import {
  HyperlaneEnvironment,
  hyperlaneEnvironments,
} from '../consts/environments';
import { appFromAddressesMapHelper } from '../contracts/contracts';
import { HyperlaneAddressesMap } from '../contracts/types';
import { MultiProvider } from '../providers/MultiProvider';
import { ChainName } from '../types';

import { IgpFactories, igpFactories } from './contracts';

export class HyperlaneIgp extends HyperlaneApp<IgpFactories> {
  static fromEnvironment<Env extends HyperlaneEnvironment>(
    env: Env,
    multiProvider: MultiProvider,
    supportedChainNames?: string[],
  ): HyperlaneIgp {
    const envAddresses = hyperlaneEnvironments[env];
    if (!envAddresses) {
      throw new Error(`No addresses found for ${env}`);
    }
    /// @ts-ignore
    return HyperlaneIgp.fromAddressesMap(
      envAddresses,
      multiProvider,
      supportedChainNames,
    );
  }

  static fromAddressesMap(
    addressesMap: HyperlaneAddressesMap<any>,
    multiProvider: MultiProvider,
    supportedChainNames?: string[],
  ): HyperlaneIgp {
    const helper = appFromAddressesMapHelper(
      addressesMap,
      igpFactories,
      multiProvider,
      supportedChainNames,
    );
    return new HyperlaneIgp(
      helper.contractsMap,
      helper.multiProvider,
      supportedChainNames,
    );
  }

  /**
   * Calls the default ISM IGP's `quoteGasPayment` function to get the amount of native tokens
   * required to pay for interchain gas.
   * The default ISM IGP will add any gas overhead amounts related to the Mailbox
   * and default ISM on the destination to the provided gasAmount.
   * @param origin The name of the origin chain.
   * @param destination The name of the destination chain.
   * @param gasAmount The amount of gas to use when calling `quoteGasPayment`.
   * The default IGP is expected to add any gas overhead related to the Mailbox
   * or ISM, so this gas amount is only required to cover the usage of the `handle`
   * function.
   * @returns The amount of native tokens required to pay for interchain gas.
   */
  quoteGasPayment(
    origin: ChainName,
    destination: ChainName,
    gasAmount: BigNumber,
  ): Promise<BigNumber> {
    const igp = this.getContracts(origin).interchainGasPaymaster;
    return this.quoteGasPaymentForIgp(
      origin,
      destination,
      gasAmount,
      igp.address,
    );
  }

  /**
   * Calls the default ISM IGP's `quoteGasPayment` function to get the amount of native tokens
   * required to pay for interchain gas.
   * The default ISM IGP will add any gas overhead amounts related to the Mailbox
   * and default ISM on the destination to the provided gasAmount.
   * @param origin The name of the origin chain.
   * @param destination The name of the destination chain.
   * @param gasAmount The amount of gas to use when calling `quoteGasPayment`.
   * The default IGP is expected to add any gas overhead related to the Mailbox
   * or ISM, so this gas amount is only required to cover the usage of the `handle`
   * function.
   * @returns The amount of native tokens required to pay for interchain gas.
   */
  quoteGasPaymentForDefaultIsmIgp(
    origin: ChainName,
    destination: ChainName,
    gasAmount: BigNumber,
  ): Promise<BigNumber> {
    const igp = this.getContracts(origin).interchainGasPaymaster;
    return this.quoteGasPaymentForIgp(
      origin,
      destination,
      gasAmount,
      igp.address,
    );
  }

  /**
   * Calls the origin's default IGP's `quoteGasPayment` function to get the
   * amount of native tokens required to pay for interchain gas.
   * The default IGP is expected to add any gas overhead related to the Mailbox
   * and ISM to the provided gasAmount.
   * @param origin The name of the origin chain.
   * @param destination The name of the destination chain.
   * @param gasAmount The amount of gas to use when calling `quoteGasPayment`.
   * The default IGP is expected to add any gas overhead related to the Mailbox
   * or ISM, so this gas amount is only required to cover the usage of the `handle`
   * function.
   * @returns The amount of native tokens required to pay for interchain gas.
   */
  protected quoteGasPaymentForIgp(
    origin: ChainName,
    destination: ChainName,
    gasAmount: BigNumber,
    interchainGasPaymasterAddress: Address,
  ): Promise<BigNumber> {
    const originProvider = this.multiProvider.getProvider(origin);
    const igp = InterchainGasPaymaster__factory.connect(
      interchainGasPaymasterAddress,
      originProvider,
    );
    const domainId = this.multiProvider.getDomainId(destination);
    return igp.quoteGasPayment(domainId, gasAmount);
  }
}
