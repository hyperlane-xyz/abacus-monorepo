import { z } from 'zod';

import { ZChainName, ZHash } from '../../../../metadata/customZodTypes.js';
import { TxSubmitterType } from '../TxSubmitterTypes.js';

export const EV5GnosisSafeTxSubmitterPropsSchema = z.object({
  chain: ZChainName,
  safeAddress: ZHash,
});

export const EV5GnosisSafeTxBuilderPropsSchema = z.object({
  version: z.string().default('1.0'),
  chain: ZChainName,
  safeAddress: ZHash,
});

export const EV5JsonRpcTxSubmitterPropsSchema = z.object({
  chain: ZChainName,
});

export const EV5ImpersonatedAccountTxSubmitterPropsSchema =
  EV5JsonRpcTxSubmitterPropsSchema.extend({
    userAddress: ZHash,
  });

export const EvmIcaTxSubmitterPropsSchema = z.object({
  chain: ZChainName,
  owner: ZHash.optional(),
  destinationChain: ZChainName,
  originInterchainAccountRouter: ZHash.optional(),
  destinationInterchainAccountRouter: ZHash.optional(),
  interchainSecurityModule: ZHash.optional(),
  internalSubmitter: z
    .discriminatedUnion('type', [
      z.object({
        type: z.literal(TxSubmitterType.JSON_RPC),
      }),
      z
        .object({
          type: z.literal(TxSubmitterType.GNOSIS_TX_BUILDER),
        })
        .merge(EV5GnosisSafeTxBuilderPropsSchema.omit({ chain: true })),
      z
        .object({
          type: z.literal(TxSubmitterType.GNOSIS_SAFE),
        })
        .merge(EV5GnosisSafeTxSubmitterPropsSchema.omit({ chain: true })),
      z
        .object({
          type: z.literal(TxSubmitterType.IMPERSONATED_ACCOUNT),
        })
        .merge(
          EV5ImpersonatedAccountTxSubmitterPropsSchema.omit({ chain: true }),
        ),
    ])
    .default({
      type: TxSubmitterType.JSON_RPC,
    }),
});
