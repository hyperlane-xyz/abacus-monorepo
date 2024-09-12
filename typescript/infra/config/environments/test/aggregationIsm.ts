import { AggregationIsmConfig, IsmType } from '@hyperlane-xyz/sdk';

import {
  merkleRootMultisig,
  messageIdMultisig,
  uniformlyWeightedMultisigIsm,
} from './multisigIsm.js';

export const aggregationIsm = (validatorKey: string): AggregationIsmConfig => {
  return {
    type: IsmType.AGGREGATION,
    modules: [
      merkleRootMultisig(validatorKey),
      messageIdMultisig(validatorKey),
      uniformlyWeightedMultisigIsm(merkleRootMultisig(validatorKey)),
      uniformlyWeightedMultisigIsm(messageIdMultisig(validatorKey)),
    ],
    threshold: 4,
  };
};
