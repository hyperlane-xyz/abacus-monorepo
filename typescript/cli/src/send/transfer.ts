import { Account, Contract, uint256 } from 'starknet';
import { stringify as yamlStringify } from 'yaml';

import {
  ChainName,
  DispatchedMessage,
  HyperlaneCore,
  MessageService,
  MultiProtocolProvider,
  ProviderType,
  StarknetCore,
  Token,
  TokenAmount,
  WarpCore,
  WarpCoreConfig,
} from '@hyperlane-xyz/sdk';
import {
  ProtocolType,
  parseWarpRouteMessage,
  timeout,
} from '@hyperlane-xyz/utils';

import { MINIMUM_TEST_SEND_GAS } from '../consts.js';
import { WriteCommandContext } from '../context/types.js';
import { runPreflightChecksForChains } from '../deploy/utils.js';
import { log, logBlue, logGreen, logRed } from '../logger.js';
import { runSingleChainSelectionStep } from '../utils/chains.js';
import { indentYamlOrJson } from '../utils/files.js';
// import { stubMerkleTreeConfig } from '../utils/relay.js';
import { runTokenSelectionStep } from '../utils/tokens.js';

export const WarpSendLogs = {
  SUCCESS: 'Transfer was self-relayed!',
};

export async function sendTestTransfer({
  context,
  warpCoreConfig,
  origin,
  destination,
  amount,
  recipient,
  timeoutSec,
  skipWaitForDelivery,
  selfRelay,
}: {
  context: WriteCommandContext;
  warpCoreConfig: WarpCoreConfig;
  origin?: ChainName; // resolved in signerMiddleware
  destination?: ChainName; // resolved in signerMiddleware
  amount: string;
  recipient?: string;
  timeoutSec: number;
  skipWaitForDelivery: boolean;
  selfRelay?: boolean;
}) {
  const { chainMetadata } = context;

  if (!origin) {
    origin = await runSingleChainSelectionStep(
      chainMetadata,
      'Select the origin chain',
    );
  }

  if (!destination) {
    destination = await runSingleChainSelectionStep(
      chainMetadata,
      'Select the destination chain',
    );
  }

  await runPreflightChecksForChains({
    context,
    chains: [origin, destination],
    chainsToGasCheck: [origin],
    minGas: MINIMUM_TEST_SEND_GAS,
  });

  await timeout(
    executeDelivery({
      context,
      origin,
      destination,
      warpCoreConfig,
      amount,
      recipient,
      skipWaitForDelivery,
      selfRelay,
    }),
    timeoutSec * 1000,
    'Timed out waiting for messages to be delivered',
  );
}

async function executeDelivery({
  context,
  origin,
  destination,
  warpCoreConfig,
  amount,
  recipient,
  skipWaitForDelivery,
  selfRelay,
}: {
  context: WriteCommandContext;
  origin: ChainName;
  destination: ChainName;
  warpCoreConfig: WarpCoreConfig;
  amount: string;
  recipient?: string;
  skipWaitForDelivery: boolean;
  selfRelay?: boolean;
}) {
  const { multiProvider, registry } = context;
  const { chainMetadata } = context;

  const chainAddresses = await registry.getAddresses();

  // Create protocol-specific cores map
  const protocolCores: Partial<
    Record<ProtocolType, HyperlaneCore | StarknetCore>
  > = {};

  // Initialize cores for the chains
  for (const chain of [origin, destination]) {
    const protocol = chainMetadata[chain].protocol;
    if (!protocolCores[protocol]) {
      if (protocol === ProtocolType.Starknet) {
        protocolCores[protocol] = new StarknetCore(
          chainAddresses,
          multiProvider,
          context.multiProtocolSigner!,
        );
      } else {
        protocolCores[protocol] = HyperlaneCore.fromAddressesMap(
          chainAddresses,
          multiProvider,
        );
      }
    }
  }

  const messageService = new MessageService(multiProvider, protocolCores);

  const { signerAddress, recipientAddress } =
    await getSignerAndRecipientAddresses({
      context,
      origin,
      destination,
      recipient,
    });

  recipient ||= recipientAddress;
  const warpCore = WarpCore.FromConfig(
    MultiProtocolProvider.fromMultiProvider(multiProvider),
    warpCoreConfig,
  );

  let token: Token;
  const tokensForRoute = warpCore.getTokensForRoute(origin, destination);
  if (tokensForRoute.length === 0) {
    logRed(`No Warp Routes found from ${origin} to ${destination}`);
    throw new Error('Error finding warp route');
  } else if (tokensForRoute.length === 1) {
    token = tokensForRoute[0];
  } else {
    logBlue(`Please select a token from the Warp config`);
    const routerAddress = await runTokenSelectionStep(tokensForRoute);
    token = warpCore.findToken(origin, routerAddress)!;
  }

  console.log('JALEN token', token);
  const errors = await warpCore.validateTransfer({
    originTokenAmount: token.amount(amount),
    destination,
    recipient,
    sender: signerAddress,
  });
  if (errors) {
    logRed('Error validating transfer', JSON.stringify(errors));
    throw new Error('Error validating transfer');
  }

  // TODO: override hook address for self-relay
  const transferTxs = await warpCore.getTransferRemoteTxs({
    originTokenAmount: new TokenAmount(amount, token),
    destination,
    sender: signerAddress,
    recipient,
  });
  console.log('JALEN transferTxs', transferTxs);

  const txReceipts = [];
  for (const tx of transferTxs) {
    if (tx.type === ProviderType.EthersV5) {
      const signer = multiProvider.getSigner(origin);
      const txResponse = await signer.sendTransaction(tx.transaction);
      const txReceipt = await multiProvider.handleTx(origin, txResponse);
      txReceipts.push(txReceipt);
    }

    if (tx.type === ProviderType.Starknet) {
      const mpProvider = new MultiProtocolProvider(chainMetadata);
      const starknetProvider = mpProvider.getStarknetProvider(origin);
      console.log('JALEN starknetProvider', starknetProvider);
      const account = new Account(starknetProvider, 'ADDRESS', 'PRIVATE_KEY');
      const TOKEN_API = [
        {
          type: 'function',
          name: 'transfer_remote',
          inputs: [
            {
              name: 'destination',
              type: 'core::integer::u32',
            },
            {
              name: 'recipient',
              type: 'core::integer::u256',
            },
            {
              name: 'amount_or_id',
              type: 'core::integer::u256',
            },
            {
              name: 'value',
              type: 'core::integer::u256',
            },
            {
              name: 'hook_metadata',
              type: 'core::byte_array::ByteArray',
            },
            {
              name: 'hook',
              type: 'core::starknet::contract_address::ContractAddress',
            },
          ],
          outputs: [],
          state_mutability: 'external',
        },
      ];
      const tokenContract = new Contract(
        TOKEN_API,
        '0x004d71a6e85cca6bca219a64baae790ea9958fc4124e0b4787965f7da7536cd8',
        account,
      );
      const recipientUint256 = uint256.bnToUint256(recipient);
      console.log('JALEN recipientUint256', recipientUint256);
      await tokenContract.invoke('transfer_remote', [
        11155111,
        recipientUint256,
        uint256.bnToUint256(amount),
        uint256.bnToUint256(0),
        '0x0',
        '0x0000000000000000000000000000000000000000000000000000000000000000',
      ]);
    }
  }
  console.log('JALEN txReceipts', txReceipts);
  const transferTxReceipt = txReceipts[txReceipts.length - 1];
  const messageIndex: number = 0;
  const message: DispatchedMessage =
    HyperlaneCore.getDispatchedMessages(transferTxReceipt)[messageIndex];

  console.log('JALEN message', message);

  const parsed = parseWarpRouteMessage(message.parsed.body);

  logBlue(
    `Sent transfer from sender (${signerAddress}) on ${origin} to recipient (${recipient}) on ${destination}.`,
  );
  logBlue(`Message ID: ${message.id}`);
  log(`Message:\n${indentYamlOrJson(yamlStringify(message, null, 2), 4)}`);
  log(`Body:\n${indentYamlOrJson(yamlStringify(parsed, null, 2), 4)}`);

  logBlue(`Message dispatched with ID: ${message.id}`);

  if (selfRelay) {
    log('Attempting self-relay of message');
    await messageService.relayMessage(message);
    logGreen(WarpSendLogs.SUCCESS);
  } else if (!skipWaitForDelivery) {
    // log('Waiting for message delivery...');
    // await messageService.waitForMessageDelivery(message);
    logGreen('Transfer sent to destination chain!');
  }
}

async function getSignerAndRecipientAddresses({
  context,
  origin,
  destination,
  recipient,
}: {
  context: WriteCommandContext;
  origin: ChainName;
  destination: ChainName;
  recipient?: string;
}): Promise<{
  signerAddress: string;
  recipientAddress: string;
}> {
  const { multiProvider } = context;
  const originMetadata = multiProvider.getChainMetadata(origin);
  const destinationMetadata = multiProvider.getChainMetadata(destination);

  // Get signer address based on origin protocol
  let signerAddress: string;
  if (originMetadata.protocol === ProtocolType.Starknet) {
    const starknetSigner =
      context.multiProtocolSigner!.getStarknetSigner(origin);
    signerAddress = starknetSigner.address;
  } else {
    // EVM-based chains
    const evmSigner = multiProvider.getSigner(origin);
    signerAddress = await evmSigner.getAddress();
  }

  // Get recipient address based on destination protocol
  let recipientAddress: string;
  if (recipient) {
    recipientAddress = recipient;
  } else if (destinationMetadata.protocol === ProtocolType.Starknet) {
    const starknetSigner =
      context.multiProtocolSigner!.getStarknetSigner(destination);
    recipientAddress = starknetSigner.address;
  } else {
    // EVM-based chains
    const evmSigner = multiProvider.getSigner(destination);
    recipientAddress = await evmSigner.getAddress();
  }

  return {
    signerAddress,
    recipientAddress,
  };
}
