import { Chains } from '../../consts/chains';
import { serializeContracts } from '../../contracts';
import { HyperlaneCore } from '../../core/HyperlaneCore';
import { getChainToOwnerMap } from '../../deploy/utils';
import { MultiProvider } from '../../providers/MultiProvider';

import { EnvSubsetDeployer, alfajoresChainConfig } from './app';
import { getAlfajoresSigner } from './utils';

async function main() {
  const signer = getAlfajoresSigner();

  console.info('Preparing utilities');
  const multiProvider = new MultiProvider();
  multiProvider.setSigner(Chains.alfajores, signer);

  const core = HyperlaneCore.fromEnvironment('testnet', multiProvider);
  const config = core.extendWithConnectionClientConfig(
    getChainToOwnerMap(alfajoresChainConfig, signer.address),
  );

  console.info('Starting deployment');
  const deployer = new EnvSubsetDeployer(multiProvider, config, core);
  const chainToContracts = await deployer.deploy();
  const addresses = serializeContracts(chainToContracts);
  console.info('===Contract Addresses===');
  console.info(JSON.stringify(addresses));
}

main()
  .then(() => console.info('Deploy complete'))
  .catch(console.error);
