import { Meta, StoryObj } from '@storybook/react';

import { chainMetadata } from '@hyperlane-xyz/registry';
import { pick } from '@hyperlane-xyz/utils';

import { ChainSearchMenu } from '../chains/ChainSearchMenu.js';

const meta = {
  title: 'ChainSearchMenu',
  component: ChainSearchMenu,
} satisfies Meta<typeof ChainSearchMenu>;
export default meta;
type Story = StoryObj<typeof meta>;

export const DefaultChainSearch = {
  args: {
    chainMetadata,
    onChangeOverrideMetadata: () => {},
    onClickChain: (chain) => console.log('Clicked', chain),
  },
} satisfies Story;

export const WithCustomField = {
  args: {
    chainMetadata: pick(chainMetadata, ['alfajores', 'arbitrum', 'ethereum']),
    onChangeOverrideMetadata: () => {},
    customListItemField: {
      header: 'Warp Routes',
      data: {
        alfajores: { display: '1 token', sortValue: 1 },
        arbitrum: { display: '2 tokens', sortValue: 2 },
        ethereum: { display: '1 token', sortValue: 1 },
      },
    },
    showAddChainButton: true,
  },
} satisfies Story;

export const WithOverrideChain = {
  args: {
    chainMetadata: pick(chainMetadata, ['alfajores']),
    overrideChainMetadata: {
      arbitrum: { ...chainMetadata['arbitrum'], displayName: 'Fake Arb' },
    },
    onChangeOverrideMetadata: () => {},
    showAddChainButton: true,
  },
} satisfies Story;
