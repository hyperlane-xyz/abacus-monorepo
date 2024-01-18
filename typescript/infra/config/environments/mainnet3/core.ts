import { BigNumber, ethers } from 'ethers';

import {
  AggregationHookConfig,
  AggregationIsmConfig,
  ChainMap,
  CoreConfig,
  HookType,
  IgpHookConfig,
  IsmType,
  MerkleTreeHookConfig,
  MultisigConfig,
  MultisigIsmConfig,
  PausableHookConfig,
  PausableIsmConfig,
  ProtocolFeeHookConfig,
  RoutingIsmConfig,
  defaultMultisigConfigs,
} from '@hyperlane-xyz/sdk';
import { objMap } from '@hyperlane-xyz/utils';

import { supportedChainNames } from './chains';
import { igp } from './igp';
import { owners, safes } from './owners';

export const core: ChainMap<CoreConfig> = objMap(owners, (local, owner) => {
  const originMultisigs: ChainMap<MultisigConfig> = Object.fromEntries(
    supportedChainNames
      .filter((chain) => chain !== local)
      .map((origin) => [origin, defaultMultisigConfigs[origin]]),
  );

  const merkleRoot = (multisig: MultisigConfig): MultisigIsmConfig => ({
    type: IsmType.MERKLE_ROOT_MULTISIG,
    ...multisig,
  });

  const messageIdIsm = (multisig: MultisigConfig): MultisigIsmConfig => ({
    type: IsmType.MESSAGE_ID_MULTISIG,
    ...multisig,
  });

  const routingIsm: RoutingIsmConfig = {
    type: IsmType.ROUTING,
    domains: objMap(
      originMultisigs,
      (_, multisig): AggregationIsmConfig => ({
        type: IsmType.AGGREGATION,
        modules: [messageIdIsm(multisig), merkleRoot(multisig)],
        threshold: 1,
      }),
    ),
    owner,
  };

  const pausableIsm: PausableIsmConfig = {
    type: IsmType.PAUSABLE,
    owner,
  };

  const defaultIsm: AggregationIsmConfig = {
    type: IsmType.AGGREGATION,
    modules: [routingIsm, pausableIsm],
    threshold: 2,
  };

  const merkleHook: MerkleTreeHookConfig = {
    type: HookType.MERKLE_TREE,
  };

  const igpHook: IgpHookConfig = {
    type: HookType.INTERCHAIN_GAS_PAYMASTER,
    ...igp[local],
  };

  const pausableHook: PausableHookConfig = {
    type: HookType.PAUSABLE,
    owner,
  };

  const defaultHook: AggregationHookConfig = {
    type: HookType.AGGREGATION,
    hooks: [pausableHook, merkleHook, igpHook],
  };

  const requiredHook: ProtocolFeeHookConfig = {
    type: HookType.PROTOCOL_FEE,
    maxProtocolFee: ethers.utils.parseUnits('1', 'gwei').toString(), // 1 gwei of native token
    protocolFee: BigNumber.from(0).toString(), // 0 wei
    beneficiary: owner,
    owner,
  };

  return {
    owner,
    defaultIsm,
    defaultHook,
    requiredHook,
    ownerOverrides: {
      proxyAdmin:
        local === 'arbitrum'
          ? `0xAC98b0cD1B64EA4fe133C6D2EDaf842cE5cF4b01`
          : safes[local] ?? owner,
    },
  };
});
