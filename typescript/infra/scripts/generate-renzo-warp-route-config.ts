import { writeFileSync } from 'fs';
import { stringify as yamlStringify } from 'yaml';

import { GithubRegistry } from '@hyperlane-xyz/registry';
import {
  IsmType,
  TokenRouterConfig,
  TokenType,
  WarpRouteDeployConfig,
  WarpRouteDeployConfigSchema,
  buildAggregationIsmConfigs,
} from '@hyperlane-xyz/sdk';

const lockbox = '0xC8140dA31E6bCa19b287cC35531c2212763C2059';
const xERC20 = '0x2416092f143378750bb29b79eD961ab195CcEea5';
const lockboxChain = 'ethereum';

const chainsToDeploy = [
  'arbitrum',
  'optimism',
  'base',
  'blast',
  'bsc',
  'mode',
  'linea',
  'ethereum',
];

const ezEthValidators = {
  arbitrum: {
    threshold: 1,
    validators: [
      '0xc27032c6bbd48c20005f552af3aaa0dbf14260f3', // Renzo
      '0x9bCcFAd3BD12Ef0Ee8aE839dD9ED7835BcCaDc9D', // Everclear
    ],
  },
  optimism: {
    threshold: 1,
    validators: [
      '0xe2593D205F5E7F74A50fA900824501084E092eBd', // Renzo
      '0x6f4cb8e96db5d44422a4495faa73fffb9d30e9e2', // Everclear
    ],
  },
  base: {
    threshold: 1,
    validators: [
      '0x25BA4eE5268CbfB8D69BAc531Aa10368778702BD', // Renzo
      '0x9ec803b503e9c7d2611e231521ef3fde73f7a21c', // Everclear
    ],
  },
  blast: {
    threshold: 1,
    validators: [
      '0x54Bb0036F777202371429e062FE6AEE0d59442F9', // Renzo
      '0x1652d8ba766821cf01aeea34306dfc1cab964a32', // Everclear
    ],
  },
  bsc: {
    threshold: 1,
    validators: [
      '0x3156Db97a3B3e2dcc3D69FdDfD3e12dc7c937b6D', // Renzo
      '0x9a0326c43e4713ae2477f09e0f28ffedc24d8266', // Everclear
    ],
  },
  mode: {
    threshold: 1,
    validators: [
      '0x7e29608C6E5792bBf9128599ca309Be0728af7B4', // Renzo
      '0x456fbbe05484fc9f2f38ea09648424f54d6872be', // Everclear
    ],
  },
  linea: {
    threshold: 1,
    validators: [
      '0xcb3e44EdD2229860bDBaA58Ba2c3817D111bEE9A', // Renzo
      '0x06a5a2a429560034d38bf62ca6d470942535947e', // Everclear
    ],
  },
  ethereum: {
    threshold: 1,
    validators: [
      '0xc7f7b94a6BaF2FFFa54DfE1dDE6E5Fcbb749e04f', // Renzo
      '0x1fd889337F60986aa57166bc5AC121eFD13e4fdd', // Everclear
    ],
  },
};
const zeroAddress = '0x0000000000000000000000000000000000000001';

async function main() {
  const registry = new GithubRegistry();

  const tokenConfig: WarpRouteDeployConfig =
    Object.fromEntries<TokenRouterConfig>(
      await Promise.all(
        chainsToDeploy.map(
          async (chain): Promise<[string, TokenRouterConfig]> => {
            const ret: [string, TokenRouterConfig] = [
              chain,
              {
                isNft: false,
                type:
                  chain === lockboxChain
                    ? TokenType.XERC20Lockbox
                    : TokenType.XERC20,
                token: chain === lockboxChain ? lockbox : xERC20,
                owner: zeroAddress,
                mailbox: (await registry.getChainAddresses(chain))!.mailbox,
                interchainSecurityModule: {
                  type: IsmType.AGGREGATION,
                  threshold: 2,
                  modules: [
                    {
                      type: IsmType.ROUTING,
                      owner: zeroAddress,
                      domains: buildAggregationIsmConfigs(
                        chain,
                        chainsToDeploy,
                        ezEthValidators,
                      ),
                    },
                    {
                      type: IsmType.FALLBACK_ROUTING,
                      domains: {},
                      owner: zeroAddress,
                    },
                  ],
                },
              },
            ];

            return ret;
          },
        ),
      ),
    );

  const parsed = WarpRouteDeployConfigSchema.safeParse(tokenConfig);

  if (!parsed.success) {
    console.dir(parsed.error.format(), { depth: null });
    return;
  }

  writeFileSync(
    'renzo-warp-route-config.yaml',
    yamlStringify(parsed.data, null, 2),
  );
}

main().catch(console.error).then(console.log);
