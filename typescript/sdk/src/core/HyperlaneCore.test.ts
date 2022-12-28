import { chainConnectionConfigs } from '../consts/chainConnectionConfigs';
import { MultiProvider } from '../providers/MultiProvider';

import { HyperlaneCore } from './HyperlaneCore';

describe('HyperlaneCore', () => {
  describe('fromEnvironment', () => {
    it('creates an object for mainnet2', async () => {
      const multiProvider = new MultiProvider(chainConnectionConfigs);
      HyperlaneCore.fromEnvironment('mainnet2', multiProvider);
    });
    it('creates an object for testnet3', async () => {
      const multiProvider = new MultiProvider(chainConnectionConfigs);
      HyperlaneCore.fromEnvironment('testnet3', multiProvider);
    });
  });
});
