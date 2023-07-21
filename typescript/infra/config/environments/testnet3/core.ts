import { AggregationIsmConfig, ChainMap, CoreConfig } from '@hyperlane-xyz/sdk';
import { objMap } from '@hyperlane-xyz/utils';

import { Contexts } from '../../contexts';

import { aggregationIsm } from './aggregationIsm';
import { owners } from './owners';

export const core: ChainMap<CoreConfig> = objMap(owners, (local, owner) => {
  const defaultIsm: AggregationIsmConfig = aggregationIsm(
    local,
    Contexts.Hyperlane,
  );
  return {
    owner,
    defaultIsm,
  };
});
