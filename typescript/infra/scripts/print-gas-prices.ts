import { Provider } from '@ethersproject/providers';
import { ethers } from 'ethers';

import { ChainMap, MultiProtocolProvider } from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

// Intentionally circumvent `mainnet3/index.ts` and `getEnvironmentConfig('mainnet3')`
// to avoid circular dependencies.
import { getRegistry as getMainnet3Registry } from '../config/environments/mainnet3/chains.js';
import mainnet3GasPrices from '../config/environments/mainnet3/gasPrices.json' assert { type: 'json' };
import { supportedChainNames as mainnet3SupportedChainNames } from '../config/environments/mainnet3/supportedChainNames.js';
import { getRegistry as getTestnet4Registry } from '../config/environments/testnet4/chains.js';
import testnet4GasPrices from '../config/environments/testnet4/gasPrices.json' assert { type: 'json' };
import { supportedChainNames as testnet4SupportedChainNames } from '../config/environments/testnet4/supportedChainNames.js';
import {
  GasPriceConfig,
  getCosmosChainGasPrice,
} from '../src/config/gas-oracle.js';

import { getArgs } from './agent-utils.js';

async function main() {
  const { environment } = await getArgs().argv;
  const { registry, supportedChainNames, gasPrices } =
    environment === 'mainnet3'
      ? {
          registry: await getMainnet3Registry(),
          supportedChainNames: mainnet3SupportedChainNames,
          gasPrices: mainnet3GasPrices,
        }
      : {
          registry: await getTestnet4Registry(),
          supportedChainNames: testnet4SupportedChainNames,
          gasPrices: testnet4GasPrices,
        };

  const chainMetadata = await registry.getMetadata();
  const mpp = new MultiProtocolProvider(chainMetadata);

  const prices: ChainMap<GasPriceConfig> = Object.fromEntries(
    await Promise.all(
      supportedChainNames.map(async (chain) => [
        chain,
        await getGasPrice(
          mpp,
          chain,
          gasPrices[chain as keyof typeof gasPrices],
        ),
      ]),
    ),
  );

  console.log(JSON.stringify(prices, null, 2));
}

async function getGasPrice(
  mpp: MultiProtocolProvider,
  chain: string,
  gasPrice?: GasPriceConfig,
): Promise<GasPriceConfig> {
  const protocolType = mpp.getProtocol(chain);
  switch (protocolType) {
    case ProtocolType.Ethereum: {
      const provider = mpp.getProvider(chain);
      const gasPrice = await (provider.provider as Provider).getGasPrice();
      return {
        amount: ethers.utils.formatUnits(gasPrice, 'gwei'),
        decimals: 9,
      };
    }
    case ProtocolType.Cosmos: {
      const { amount } = await getCosmosChainGasPrice(chain);

      return {
        amount,
        decimals: 1,
      };
    }
    case ProtocolType.Sealevel:
      // Return the gas price from the config if it exists, otherwise return some  default
      // TODO get a reasonable value
      return (
        gasPrice ?? {
          amount: 'PLEASE SET A GAS PRICE FOR SEALEVEL',
          decimals: 1,
        }
      );
    default:
      throw new Error(`Unsupported protocol type: ${protocolType}`);
  }
}

main()
  .then()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
