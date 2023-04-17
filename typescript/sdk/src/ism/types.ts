import {
  DomainRoutingIsm,
  StaticAggregationIsm,
  StaticMultisigIsm,
} from '@hyperlane-xyz/core';
import type { types } from '@hyperlane-xyz/utils';

import { ChainMap } from '../types';

export type DeployedIsm =
  | StaticMultisigIsm
  | StaticAggregationIsm
  | DomainRoutingIsm;

export enum ModuleType {
  UNUSED,
  ROUTING,
  AGGREGATION,
  LEGACY_MULTISIG,
  MULTISIG,
}

export type MultisigIsmConfig = {
  type: ModuleType.MULTISIG;
  validators: Array<types.Address>;
  threshold: number;
};

export type RoutingIsmConfig = {
  type: ModuleType.ROUTING;
  owner: types.Address;
  domains: ChainMap<IsmConfig>;
};

export type AggregationIsmConfig = {
  type: ModuleType.AGGREGATION;
  modules: Array<IsmConfig>;
  threshold: number;
};

export type IsmConfig =
  | RoutingIsmConfig
  | MultisigIsmConfig
  | AggregationIsmConfig;
