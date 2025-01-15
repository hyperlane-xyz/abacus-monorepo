import { Provider } from '@ethersproject/providers';
import { BigNumber as BigNumberJs } from 'bignumber.js';
import { assert } from 'console';
import { BigNumber, ethers } from 'ethers';

import { ProtocolType, convertDecimals, objMap } from '@hyperlane-xyz/utils';

import {
  TOKEN_EXCHANGE_RATE_DECIMALS_COSMOS,
  TOKEN_EXCHANGE_RATE_DECIMALS_ETHEREUM,
  TOKEN_EXCHANGE_RATE_DECIMALS_SEALEVEL,
} from '../consts/igp.js';
import { ChainMetadataManager } from '../metadata/ChainMetadataManager.js';
import { AgentCosmosGasPrice } from '../metadata/agentConfig.js';
import { MultiProtocolProvider } from '../providers/MultiProtocolProvider.js';
import { ChainMap, ChainName } from '../types.js';
import { getCosmosRegistryChain } from '../utils/cosmos.js';

import { ProtocolAgnositicGasOracleConfig } from './oracle/types.js';

export interface GasPriceConfig {
  amount: string;
  decimals: number;
}

export interface NativeTokenPriceConfig {
  price: string;
  decimals: number;
}

export interface ChainGasOracleParams {
  gasPrice: GasPriceConfig;
  nativeToken: NativeTokenPriceConfig;
}

export async function getGasPrice(
  mpp: MultiProtocolProvider,
  chain: string,
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
      const { amount } = await getCosmosChainGasPrice(chain, mpp);
      return {
        amount,
        decimals: 1,
      };
    }
    case ProtocolType.Sealevel:
      // TODO get a reasonable value
      return {
        amount: '0.001',
        decimals: 9,
      };
    default:
      throw new Error(`Unsupported protocol type: ${protocolType}`);
  }
}

// Gets the gas price for a Cosmos chain
export async function getCosmosChainGasPrice(
  chain: ChainName,
  chainMetadataManager: ChainMetadataManager,
): Promise<AgentCosmosGasPrice> {
  const metadata = chainMetadataManager.getChainMetadata(chain);
  if (!metadata) {
    throw new Error(`No metadata found for Cosmos chain ${chain}`);
  }
  if (metadata.protocol !== ProtocolType.Cosmos) {
    throw new Error(`Chain ${chain} is not a Cosmos chain`);
  }

  const cosmosRegistryChain = await getCosmosRegistryChain(chain);
  const nativeToken = metadata.nativeToken;
  if (!nativeToken) {
    throw new Error(`No native token found for Cosmos chain ${chain}`);
  }
  if (!nativeToken.denom) {
    throw new Error(`No denom found for native token on Cosmos chain ${chain}`);
  }

  const fee = cosmosRegistryChain.fees?.fee_tokens.find(
    (fee: { denom: string }) => {
      return (
        fee.denom === nativeToken.denom || fee.denom === `u${nativeToken.denom}`
      );
    },
  );
  if (!fee || fee.average_gas_price === undefined) {
    throw new Error(`No gas price found for Cosmos chain ${chain}`);
  }

  return {
    denom: fee.denom,
    amount: fee.average_gas_price.toString(),
  };
}

// Gets the exchange rate of the remote quoted in local tokens, not accounting for decimals.
function getTokenExchangeRateFromValues({
  local,
  remote,
  tokenPrices,
  exchangeRateMarginPct,
}: // decimals,
{
  local: ChainName;
  remote: ChainName;
  tokenPrices: ChainMap<string>;
  exchangeRateMarginPct: number;
  // decimals: { local: number; remote: number };
}): BigNumberJs {
  // Workaround for chicken-egg dependency problem.
  // We need to provide some default value here to satisfy the config on initial load,
  // whilst knowing that it will get overwritten when a script actually gets run.
  const defaultValue = '1';
  const localValue = new BigNumberJs(tokenPrices[local] ?? defaultValue);
  const remoteValue = new BigNumberJs(tokenPrices[remote] ?? defaultValue);

  console.log(
    'yeet 1',
    local,
    remote,
    'localValue',
    localValue.toString(),
    tokenPrices[local],
    'remoteValue',
    remoteValue.toString(),
    tokenPrices[remote],
  );
  // This does not yet account for decimals!
  let exchangeRate = remoteValue.div(localValue);
  console.log('yeet 2', local, remote, 'exchangeRate', exchangeRate.toString());
  // Apply the premium
  exchangeRate = exchangeRate.times(100 + exchangeRateMarginPct).div(100);
  console.log('yeet 3', local, remote, 'exchangeRate', exchangeRate.toString());

  // const value = convertDecimals(decimals.remote, decimals.local, exchangeRate);
  // console.log('yeet 4', local, remote, 'value', value.toString());
  assert(
    exchangeRate.isGreaterThan(0),
    'Exchange rate must be greater than 0, possible loss of precision',
  );
  return exchangeRate;
}

function getProtocolSpecificExchangeRateDecimals(
  protocolType: ProtocolType,
): number {
  switch (protocolType) {
    case ProtocolType.Ethereum:
      return TOKEN_EXCHANGE_RATE_DECIMALS_ETHEREUM;
    case ProtocolType.Sealevel:
      return TOKEN_EXCHANGE_RATE_DECIMALS_SEALEVEL;
    case ProtocolType.Cosmos:
      return TOKEN_EXCHANGE_RATE_DECIMALS_COSMOS;
    default:
      throw new Error(`Unsupported protocol type: ${protocolType}`);
  }
}

export function getProtocolSpecificExchangeRateScale(
  protocolType: ProtocolType,
): BigNumber {
  return BigNumber.from(10).pow(
    getProtocolSpecificExchangeRateDecimals(protocolType),
  );
}

function getProtocolSpecificExchangeRate(
  exchangeRate: BigNumberJs,
  protocolType: ProtocolType,
): BigNumber {
  const multiplierDecimals =
    getProtocolSpecificExchangeRateDecimals(protocolType);
  const multiplier = new BigNumberJs(10).pow(multiplierDecimals);
  const integer = exchangeRate
    .times(multiplier)
    .integerValue(BigNumberJs.ROUND_FLOOR)
    .toString(10);
  return BigNumber.from(integer);
}

// The move is to somehow scale up the gas price and scale down the exchange rate by the same factor.

// Gets the StorageGasOracleConfig for each remote chain for a particular local chain.
// Accommodates small non-integer gas prices by scaling up the gas price
// and scaling down the exchange rate by the same factor.
export function getLocalStorageGasOracleConfig({
  local,
  localProtocolType,
  gasOracleParams,
  exchangeRateMarginPct,
  gasPriceModifier,
}: {
  local: ChainName;
  localProtocolType: ProtocolType;
  gasOracleParams: ChainMap<ChainGasOracleParams>;
  exchangeRateMarginPct: number;
  gasPriceModifier?: (
    local: ChainName,
    remote: ChainName,
    gasOracleConfig: ProtocolAgnositicGasOracleConfig,
  ) => BigNumberJs.Value;
}): ChainMap<ProtocolAgnositicGasOracleConfig> {
  const remotes = Object.keys(gasOracleParams).filter(
    (remote) => remote !== local,
  );
  const tokenPrices: ChainMap<string> = objMap(
    gasOracleParams,
    (chain) => gasOracleParams[chain].nativeToken.price,
  );
  const localDecimals = gasOracleParams[local].nativeToken.decimals;
  return remotes.reduce((agg, remote) => {
    const remoteDecimals = gasOracleParams[remote].nativeToken.decimals;
    let exchangeRateFloat = getTokenExchangeRateFromValues({
      local,
      remote,
      tokenPrices,
      exchangeRateMarginPct,
      // decimals: { local: localDecimals, remote: remoteDecimals },
    });

    if (localProtocolType !== ProtocolType.Sealevel) {
      // On all chains other than Sealevel, we need to adjust the exchange rate for decimals
      console.log(
        'exchangeRateFloat before convertDecimals',
        exchangeRateFloat.toString(),
        'localDecimals',
        localDecimals,
        'remoteDecimals',
        remoteDecimals,
      );
      exchangeRateFloat = convertDecimals(
        remoteDecimals,
        localDecimals,
        exchangeRateFloat,
      );
    }

    console.log(
      'exchangeRateFloat before protocol specific',
      exchangeRateFloat.toString(),
    );
    let exchangeRate = getProtocolSpecificExchangeRate(
      exchangeRateFloat,
      // TODO need to get this
      localProtocolType,
    );
    console.log(
      'exchangeRate after protocol specific',
      exchangeRate.toString(),
    );

    // First parse as a number, so we have floating point precision.
    // Recall it's possible to have gas prices that are not integers, even
    // after converting to the "wei" version of the token.
    let gasPrice =
      parseFloat(gasOracleParams[remote].gasPrice.amount) *
      Math.pow(10, gasOracleParams[remote].gasPrice.decimals);
    if (isNaN(gasPrice)) {
      throw new Error(
        `Invalid gas price for chain ${remote}: ${gasOracleParams[remote].gasPrice.amount}`,
      );
    }

    // Our integer gas price.
    // let gasPriceBn = BigNumber.from(Math.ceil(gasPrice));

    // let gasOracleConfig: ProtocolAgnositicGasOracleConfig = {
    //   gasPrice: gasPriceBn.toString(),
    //   tokenExchangeRate: exchangeRate.toString(),
    //   tokenDecimals: remoteDecimals,
    // };

    let gasOracleConfig = adjustForPrecisionLoss(
      gasPrice,
      exchangeRate,
      remoteDecimals,
    );

    if (gasPriceModifier) {
      gasOracleConfig = adjustForPrecisionLoss(
        gasPriceModifier(local, remote, gasOracleConfig),
        BigNumber.from(gasOracleConfig.tokenExchangeRate),
        remoteDecimals,
      );
    }

    return {
      ...agg,
      [remote]: gasOracleConfig,
    };
  }, {} as ChainMap<ProtocolAgnositicGasOracleConfig>);
}

function adjustForPrecisionLoss(
  gasPriceValue: BigNumberJs.Value,
  exchangeRate: BigNumber,
  remoteDecimals: number,
): ProtocolAgnositicGasOracleConfig {
  let newGasPrice = new BigNumberJs(gasPriceValue);
  let newExchangeRate = exchangeRate;
  // We have very little precision and ultimately need an integer value for
  // the gas price that will be set on-chain. We scale up the gas price and
  // scale down the exchange rate by the same factor.
  if (newGasPrice.lt(10) && newGasPrice.mod(1) !== new BigNumberJs(0)) {
    // Scale up the gas price by 1e4
    const gasPriceScalingFactor = 1e4;

    // Check that there's no significant underflow when applying
    // this to the exchange rate:
    const adjustedExchangeRate = newExchangeRate.div(gasPriceScalingFactor);
    const recoveredExchangeRate = adjustedExchangeRate.mul(
      gasPriceScalingFactor,
    );
    if (recoveredExchangeRate.mul(100).div(newExchangeRate).lt(99)) {
      throw new Error('Too much underflow when downscaling exchange rate');
    }

    console.log(
      'gasPriceValue',
      gasPriceValue,
      'newGasPrice',
      newGasPrice.toString(),
      'gasPriceScalingFactor',
      gasPriceScalingFactor.toString(),
    );
    newGasPrice = newGasPrice.times(gasPriceScalingFactor);
    newExchangeRate = adjustedExchangeRate;
  }

  const newGasPriceInteger = newGasPrice.integerValue(BigNumberJs.ROUND_CEIL);
  assert(
    newGasPriceInteger.gt(0),
    'Gas price must be greater than 0, possible loss of precision',
  );

  return {
    tokenExchangeRate: newExchangeRate.toString(),
    gasPrice: newGasPriceInteger.toString(),
    tokenDecimals: remoteDecimals,
  };
}

// class ProtocolAgnosticGasOracleConfigClass {
//   constructor(readonly config: ProtocolAgnositicGasOracleConfig) {}

//   getProtocolSpecificConfig(protocol: ProtocolType): any {

//   }
// }
