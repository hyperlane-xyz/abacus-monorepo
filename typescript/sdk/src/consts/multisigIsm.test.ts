import { expect } from 'chai';
import { isAddress } from 'viem';

import { defaultMultisigConfigs } from './multisigIsm.js';

describe('MultisigIsm', () => {
  describe('defaultMultisigConfigs', () => {
    it('has thresholds that require a set majority', async () => {
      for (const [chain, config] of Object.entries(defaultMultisigConfigs)) {
        const minimumThreshold = Math.floor(config.validators.length / 2) + 1;
        expect(config.threshold).to.be.greaterThanOrEqual(
          minimumThreshold,
          `Threshold for ${chain} is too low, expected at least ${minimumThreshold}, got ${config.threshold}`,
        );
      }
    });

    it('has a valid number of validators for each threshold', async () => {
      for (const [chain, config] of Object.entries(defaultMultisigConfigs)) {
        expect(config.validators.length).to.be.greaterThanOrEqual(
          config.threshold,
          `Number of validators for ${chain} is less than the threshold, expected at least ${config.threshold}, got ${config.validators.length}`,
        );
      }
    });

    it('has valid EVM addresses for each validator', async () => {
      for (const [chain, config] of Object.entries(defaultMultisigConfigs)) {
        for (const validator of config.validators) {
          expect(isAddress(validator)).to.be.true(
            `Validator address ${validator} for ${chain} is not a valid EVM address`,
          );
        }
      }
    });
  });
});
