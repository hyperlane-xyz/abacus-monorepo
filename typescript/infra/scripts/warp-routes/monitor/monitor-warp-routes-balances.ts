import { PopulatedTransaction } from 'ethers';

import {
  ChainMap,
  ChainMetadata,
  CoinGeckoTokenPriceGetter,
  EvmHypXERC20Adapter,
  EvmHypXERC20LockboxAdapter,
  IHypXERC20Adapter,
  MultiProtocolProvider,
  Token,
  TokenStandard,
  WarpCore,
} from '@hyperlane-xyz/sdk';
import { ProtocolType, objMerge } from '@hyperlane-xyz/utils';

import { getWarpCoreConfig } from '../../../config/registry.js';
import {
  DeployEnvironment,
  getRouterConfigsForAllVms,
} from '../../../src/config/environment.js';
import { fetchGCPSecret } from '../../../src/utils/gcloud.js';
import { startMetricsServer } from '../../../src/utils/metrics.js';
import { getArgs, withWarpRouteIdRequired } from '../../agent-utils.js';
import { getEnvironmentConfig } from '../../core-utils.js';

import {
  metricsRegister,
  updateTokenBalanceMetrics,
  updateXERC20LimitsMetrics,
} from './metrics.js';
import { WarpRouteBalance, XERC20Limit } from './types.js';
import { gracefullyHandleError, logger } from './utils.js';

async function main() {
  const { checkFrequency, environment, warpRouteId } =
    await withWarpRouteIdRequired(getArgs())
      .describe('checkFrequency', 'frequency to check balances in ms')
      .demandOption('checkFrequency')
      .alias('v', 'checkFrequency') // v as in Greek letter nu
      .number('checkFrequency')
      .parse();

  startMetricsServer(metricsRegister);

  const envConfig = getEnvironmentConfig(environment);
  const registry = await envConfig.getRegistry();
  const chainMetadata = await registry.getMetadata();

  // The Sealevel warp adapters require the Mailbox address, so we
  // get router configs (that include the Mailbox address) for all chains
  // and merge them with the chain metadata.
  const routerConfig = await getRouterConfigsForAllVms(
    envConfig,
    await envConfig.getMultiProvider(),
  );
  const multiProtocolProvider = new MultiProtocolProvider(
    objMerge(chainMetadata, routerConfig),
  );
  const warpCoreConfig = getWarpCoreConfig(warpRouteId);
  const warpCore = WarpCore.FromConfig(multiProtocolProvider, warpCoreConfig);

  await pollAndUpdateWarpRouteMetrics(checkFrequency, warpCore, chainMetadata);
}

// Indefinitely loops, updating warp route metrics at the specified frequency.
async function pollAndUpdateWarpRouteMetrics(
  checkFrequency: number,
  warpCore: WarpCore,
  chainMetadata: ChainMap<ChainMetadata>,
) {
  const tokenPriceGetter = CoinGeckoTokenPriceGetter.withDefaultCoinGecko(
    chainMetadata,
    await getCoinGeckoApiKey(),
  );

  setInterval(async () => {
    await gracefullyHandleError(async () => {
      await Promise.all(
        warpCore.tokens.map((token) =>
          updateTokenMetrics(warpCore, token, tokenPriceGetter),
        ),
      );
    }, 'Updating warp route metrics');
  }, checkFrequency);
}

// Updates the metrics for a single token in a warp route.
async function updateTokenMetrics(
  warpCore: WarpCore,
  token: Token,
  tokenPriceGetter: CoinGeckoTokenPriceGetter,
) {
  const promises = [
    gracefullyHandleError(async () => {
      const balanceInfo = await getTokenBridgedBalance(
        warpCore,
        token,
        tokenPriceGetter,
      );
      if (!balanceInfo) {
        return;
      }
      updateTokenBalanceMetrics(warpCore, token, balanceInfo);
    }, 'Getting bridged balance and value'),
  ];

  if (token.isXerc20()) {
    promises.push(
      gracefullyHandleError(async () => {
        const limits = await getXERC20Limits(warpCore, token);
        updateXERC20LimitsMetrics(token, limits);
      }, 'Getting xERC20 limits'),
    );
  }

  await Promise.all(promises);
}

// Gets the bridged balance and value of a token in a warp route.
async function getTokenBridgedBalance(
  warpCore: WarpCore,
  token: Token,
  tokenPriceGetter: CoinGeckoTokenPriceGetter,
): Promise<WarpRouteBalance | undefined> {
  const bridgedSupply = await token.getBridgedSupply(warpCore.multiProvider);
  if (!bridgedSupply) {
    logger.warn('Bridged supply not found for token', token);
    return undefined;
  }

  let tokenPrice;
  // Only record value for collateralized and xERC20 lockbox tokens.
  if (
    token.isCollateralized() ||
    token.standard === TokenStandard.EvmHypXERC20Lockbox
  ) {
    tokenPrice = await tryGetTokenPrice(warpCore, token, tokenPriceGetter);
  }
  const balance = bridgedSupply.getDecimalFormattedAmount();

  return {
    balance,
    valueUSD: tokenPrice ? balance * tokenPrice : undefined,
  };
}

async function getXERC20Limits(
  warpCore: WarpCore,
  token: Token,
): Promise<XERC20Limit> {
  if (token.protocol !== ProtocolType.Ethereum) {
    throw new Error(`Unsupported XERC20 protocol type ${token.protocol}`);
  }

  if (token.standard === TokenStandard.EvmHypXERC20) {
    const adapter = token.getAdapter(
      warpCore.multiProvider,
    ) as EvmHypXERC20Adapter;
    return getXERC20Limit(token, adapter);
  } else if (token.standard === TokenStandard.EvmHypXERC20Lockbox) {
    const adapter = token.getAdapter(
      warpCore.multiProvider,
    ) as EvmHypXERC20LockboxAdapter;
    return getXERC20Limit(token, adapter);
  }
  throw new Error(`Unsupported XERC20 token standard ${token.standard}`);
}

async function getXERC20Limit(
  token: Token,
  xerc20: IHypXERC20Adapter<PopulatedTransaction>,
): Promise<XERC20Limit> {
  const formatBigInt = (num: bigint) => {
    return token.amount(num).getDecimalFormattedAmount();
  };

  const [mintCurrent, mintMax, burnCurrent, burnMax] = await Promise.all([
    xerc20.getMintLimit(),
    xerc20.getMintMaxLimit(),
    xerc20.getBurnLimit(),
    xerc20.getBurnMaxLimit(),
  ]);

  return {
    mint: formatBigInt(mintCurrent),
    mintMax: formatBigInt(mintMax),
    burn: formatBigInt(burnCurrent),
    burnMax: formatBigInt(burnMax),
  };
}

// Tries to get the price of a token from CoinGecko. Returns undefined if there's no
// CoinGecko ID for the token.
async function tryGetTokenPrice(
  warpCore: WarpCore,
  token: Token,
  tokenPriceGetter: CoinGeckoTokenPriceGetter,
): Promise<number | undefined> {
  // We assume all tokens in the warp route are the same token, so just find the first one.
  let coinGeckoId = warpCore.tokens.find(
    (t) => t.coinGeckoId !== undefined,
  )?.coinGeckoId;

  // If the token is a native token, we may be able to get the CoinGecko ID from the chain metadata.
  if (!coinGeckoId && token.isNative()) {
    const chainMetadata = warpCore.multiProvider.getChainMetadata(
      token.chainName,
    );
    // To defend against Cosmos, which can have multiple types of native tokens,
    // we only use the gas currency CoinGecko ID if it matches the token symbol.
    if (chainMetadata.nativeToken?.symbol === token.symbol) {
      coinGeckoId = chainMetadata.gasCurrencyCoinGeckoId;
    }
  }

  if (!coinGeckoId) {
    logger.warn('CoinGecko ID missing for token', token.symbol);
    return undefined;
  }

  return getCoingeckoPrice(tokenPriceGetter, coinGeckoId);
}

async function getCoingeckoPrice(
  tokenPriceGetter: CoinGeckoTokenPriceGetter,
  coingeckoId: string,
): Promise<number | undefined> {
  const prices = await tokenPriceGetter.getTokenPriceByIds([coingeckoId]);
  if (!prices) return undefined;
  return prices[0];
}

async function getCoinGeckoApiKey(): Promise<string | undefined> {
  const environment: DeployEnvironment = 'mainnet3';
  let apiKey: string | undefined;
  try {
    apiKey = (await fetchGCPSecret(
      `${environment}-coingecko-api-key`,
      false,
    )) as string;
  } catch (e) {
    logger.error(
      'Error fetching CoinGecko API key, proceeding with public tier',
      e,
    );
  }

  return apiKey;
}

main().then(logger.info).catch(logger.error);
