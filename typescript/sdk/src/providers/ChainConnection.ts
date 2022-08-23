import { Debugger, debug } from 'debug';
import { ethers } from 'ethers';

import { IChainConnection } from '../types';

export class ChainConnection {
  provider: ethers.providers.Provider;
  signer?: ethers.Signer;
  overrides: ethers.Overrides;
  confirmations: number;
  blockExplorerUrl: string;
  apiPrefix: string;
  logger: Debugger;

  constructor(dc: IChainConnection) {
    this.provider = dc.provider;
    this.signer = dc.signer;
    this.overrides = dc.overrides ?? {};
    this.confirmations = dc.confirmations ?? 0;
    this.blockExplorerUrl = dc.blockExplorerUrl ?? 'UNKNOWN_EXPLORER';
    this.apiPrefix = dc.apiPrefix ?? 'api.';
    this.logger = debug('abacus:ChainConnection');
  }

  getConnection = (): ethers.providers.Provider | ethers.Signer =>
    this.signer ?? this.provider;

  getAddress = (): Promise<string> | undefined => this.signer?.getAddress();

  getTxUrl(response: ethers.providers.TransactionResponse): string {
    return `${this.blockExplorerUrl}/tx/${response.hash}`;
  }

  async getAddressUrl(address?: string): Promise<string> {
    return `${this.blockExplorerUrl}/address/${
      address ?? (await this.signer!.getAddress())
    }`;
  }

  getApiUrl(): string {
    const prefix = 'https://';
    return `${prefix}${this.apiPrefix}${this.blockExplorerUrl.slice(
      prefix.length,
    )}/api`;
  }

  async handleTx(
    tx: ethers.ContractTransaction | Promise<ethers.ContractTransaction>,
  ): Promise<ethers.ContractReceipt> {
    const response = await tx;
    this.logger(
      `Pending ${this.getTxUrl(response)} (waiting ${
        this.confirmations
      } blocks for confirmation)`,
    );
    return response.wait(this.confirmations);
  }
}
