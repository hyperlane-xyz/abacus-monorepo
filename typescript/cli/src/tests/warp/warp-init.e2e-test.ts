import { expect } from 'chai';
import { Wallet } from 'ethers';

import {
  ChainName,
  TokenType,
  WarpRouteDeployConfigWithoutMailbox,
} from '@hyperlane-xyz/sdk';
import { Address } from '@hyperlane-xyz/utils';

import { readYamlOrJson } from '../../utils/files.js';
import {
  ANVIL_KEY,
  CHAIN_NAME_2,
  CHAIN_NAME_3,
  CONFIRM_DETECTED_OWNER_STEP,
  DEFAULT_E2E_TEST_TIMEOUT,
  KeyBoardKeys,
  SELECT_ANVIL_2_AND_ANVIL_3_STEPS,
  SELECT_ANVIL_2_FROM_MULTICHAIN_PICKER,
  SELECT_MAINNET_CHAIN_TYPE_STEP,
  TestPromptAction,
  WARP_CONFIG_PATH_2,
  deployToken,
  handlePrompts,
} from '../commands/helpers.js';
import { hyperlaneWarpInit } from '../commands/warp.js';

describe('hyperlane warp init e2e tests', async function () {
  this.timeout(2 * DEFAULT_E2E_TEST_TIMEOUT);

  let initialOwnerAddress: Address;

  before(async function () {
    const wallet = new Wallet(ANVIL_KEY);
    initialOwnerAddress = wallet.address;
  });

  describe('hyperlane warp init --yes', () => {
    function assertWarpConfig(
      warpConfig: WarpRouteDeployConfigWithoutMailbox,
      chainName: ChainName,
    ) {
      expect(warpConfig[chainName]).not.to.be.undefined;

      const chain2TokenConfig = warpConfig[chainName];
      expect(chain2TokenConfig.owner).equal(initialOwnerAddress);
      expect(chain2TokenConfig.type).equal(TokenType.native);
    }

    it('it should generate a warp deploy config with a single chain', async function () {
      const steps: TestPromptAction[] = [
        SELECT_MAINNET_CHAIN_TYPE_STEP,
        {
          check: (currentOutput: string) =>
            currentOutput.includes('--Mainnet Chains--'),
          // Scroll down through the mainnet chains list and select anvil2
          input: `${SELECT_ANVIL_2_FROM_MULTICHAIN_PICKER}${KeyBoardKeys.ENTER}`,
        },
        CONFIRM_DETECTED_OWNER_STEP,
        {
          check: (currentOutput: string) =>
            !!currentOutput.match(/Select .+?'s token type/),
          // Scroll up through the token type list and select native
          input: `${KeyBoardKeys.ARROW_UP.repeat(2)}${KeyBoardKeys.ENTER}`,
        },
      ];

      const output = hyperlaneWarpInit(WARP_CONFIG_PATH_2).stdio('pipe');

      await handlePrompts(output, steps);

      const warpConfig: WarpRouteDeployConfigWithoutMailbox =
        readYamlOrJson(WARP_CONFIG_PATH_2);

      assertWarpConfig(warpConfig, CHAIN_NAME_2);
    });

    it('it should generate a warp deploy config with a 2 chains warp route (native->native)', async function () {
      const steps: TestPromptAction[] = [
        SELECT_MAINNET_CHAIN_TYPE_STEP,
        ...SELECT_ANVIL_2_AND_ANVIL_3_STEPS,
        CONFIRM_DETECTED_OWNER_STEP,
        {
          check: (currentOutput: string) =>
            !!currentOutput.match(/Select .+?'s token type/),
          input: `${KeyBoardKeys.ARROW_UP.repeat(2)}${KeyBoardKeys.ENTER}`,
        },
        CONFIRM_DETECTED_OWNER_STEP,
        {
          check: (currentOutput: string) =>
            !!currentOutput.match(/Select .+?'s token type/),
          input: `${KeyBoardKeys.ARROW_UP.repeat(2)}${KeyBoardKeys.ENTER}`,
        },
      ];

      const output = hyperlaneWarpInit(WARP_CONFIG_PATH_2).stdio('pipe');

      await handlePrompts(output, steps);

      const warpConfig: WarpRouteDeployConfigWithoutMailbox =
        readYamlOrJson(WARP_CONFIG_PATH_2);

      [CHAIN_NAME_2, CHAIN_NAME_3].map((chainName) =>
        assertWarpConfig(warpConfig, chainName),
      );
    });

    it('it should generate a warp deploy config with a 2 chains warp route (collateral->synthetic)', async function () {
      const erc20Token = await deployToken(ANVIL_KEY, CHAIN_NAME_2, 6);
      const steps: TestPromptAction[] = [
        SELECT_MAINNET_CHAIN_TYPE_STEP,
        ...SELECT_ANVIL_2_AND_ANVIL_3_STEPS,
        // First chain token config
        CONFIRM_DETECTED_OWNER_STEP,
        {
          check: (currentOutput: string) =>
            !!currentOutput.match(/Select .+?'s token type/),
          // Scroll down through the token type list and select collateral
          input: `${KeyBoardKeys.ARROW_DOWN.repeat(4)}${KeyBoardKeys.ENTER}`,
        },
        {
          check: (currentOutput: string) =>
            currentOutput.includes('Enter the existing token address on chain'),
          input: `${erc20Token.address}${KeyBoardKeys.ENTER}`,
        },
        // Other chain token config
        CONFIRM_DETECTED_OWNER_STEP,
        {
          check: (currentOutput: string) =>
            !!currentOutput.match(/Select .+?'s token type/),
          // Select the synthetic token type
          input: `${KeyBoardKeys.ENTER}`,
        },
      ];

      const output = hyperlaneWarpInit(WARP_CONFIG_PATH_2).stdio('pipe');

      await handlePrompts(output, steps);

      const warpConfig: WarpRouteDeployConfigWithoutMailbox =
        readYamlOrJson(WARP_CONFIG_PATH_2);

      expect(warpConfig[CHAIN_NAME_2]).not.to.be.undefined;

      const chain2TokenConfig = warpConfig[CHAIN_NAME_2];
      expect(chain2TokenConfig.owner).equal(initialOwnerAddress);
      expect(chain2TokenConfig.type).equal(TokenType.collateral);
      expect((chain2TokenConfig as any).token).equal(erc20Token.address);

      expect(warpConfig[CHAIN_NAME_3]).not.to.be.undefined;

      const chain3TokenConfig = warpConfig[CHAIN_NAME_3];
      expect(chain3TokenConfig.owner).equal(initialOwnerAddress);
      expect(chain3TokenConfig.type).equal(TokenType.synthetic);
    });
  });
});
