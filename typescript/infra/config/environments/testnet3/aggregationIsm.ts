import {
  AggregationIsmConfig,
  ChainMap,
  ChainName,
  IsmConfig,
  ModuleType,
  MultisigIsmConfig,
  RoutingIsmConfig,
  defaultMultisigIsmConfigs,
  objFilter,
  objMap,
} from '@hyperlane-xyz/sdk';

import { Contexts } from '../../contexts';
import { rcMultisigIsmConfigs } from '../../multisigIsm';

import { chainNames } from './chains';
import { owners } from './owners';

export const multisigIsms = (
  local: ChainName,
  type: MultisigIsmConfig['type'],
  context: Contexts,
): ChainMap<MultisigIsmConfig> =>
  objMap(
    objFilter(
      context === Contexts.ReleaseCandidate
        ? rcMultisigIsmConfigs
        : defaultMultisigIsmConfigs,
      (chain, config): config is MultisigIsmConfig =>
        chain !== local && chainNames.includes(chain),
    ),
    (_, config) => ({
      ...config,
      type,
    }),
  );

/// Routing => Multisig ISM type
export const routingIsm = (
  local: ChainName,
  type: MultisigIsmConfig['type'],
  context: Contexts,
): RoutingIsmConfig => {
  const defaultMultisigIsmConfigs = multisigIsms(local, type, context);
  return {
    type: ModuleType.ROUTING,
    domains: defaultMultisigIsmConfigs,
    owner: owners[local],
  };
};

/// 1/2 Aggregation => Routing => Multisig ISM
export const aggregationIsm = (
  local: ChainName,
  context: Contexts,
): AggregationIsmConfig => {
  const config: AggregationIsmConfig = {
    type: ModuleType.AGGREGATION,
    modules: [
      // ORDERING MATTERS
      routingIsm(local, ModuleType.MERKLE_ROOT_MULTISIG, context),
      routingIsm(local, ModuleType.MESSAGE_ID_MULTISIG, context),
    ],
    threshold: 1,
  };
  return config;
};

const replacerEnum = (key: string, value: any) => {
  if (key === 'type') {
    switch (value) {
      case ModuleType.AGGREGATION:
        return 'AGGREGATION';
      case ModuleType.ROUTING:
        return 'ROUTING';
      case ModuleType.MERKLE_ROOT_MULTISIG:
        return 'MERKLE_ROOT_MULTISIG';
      case ModuleType.LEGACY_MULTISIG:
        return 'LEGACY_MULTISIG';
      case ModuleType.MESSAGE_ID_MULTISIG:
        return 'MESSAGE_ID_MULTISIG';
      default:
        return value;
    }
  }
  return value;
};

export const printIsmConfig = (ism: IsmConfig): string => {
  return JSON.stringify(ism, replacerEnum, 2);
};
