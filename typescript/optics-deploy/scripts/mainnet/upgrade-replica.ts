import { mainnet } from '@abacus-network/sdk';
import { ethers } from 'ethers';
import { ViolationType } from '../../src/checks';
import { CoreInvariantChecker } from '../../src/core/checks';
import { CoreDeploy } from '../../src/core/CoreDeploy';
import { expectCalls, GovernanceCallBatchBuilder } from '../../src/core/govern';
import { Call } from '@abacus-network/sdk/dist/optics/govern';
import { core } from '../../config/environments/mainnet/core';
import { chains } from '../../config/environments/mainnet/chains';

const environment = 'mainnet';
const directory = `../../config/environments/${environment}/contracts`;
const deploys = chains.map((c) => CoreDeploy.fromDirectory(directory, c, core))

async function main() {
  mainnet.registerRpcProvider('celo', process.env.CELO_RPC!);
  mainnet.registerRpcProvider('polygon', process.env.POLYGON_RPC!);
  mainnet.registerRpcProvider('avalanche', process.env.AVALANCHE_RPC!);
  mainnet.registerRpcProvider('ethereum', process.env.ETHEREUM_RPC!);
  mainnet.registerSigner(
    'celo',
    new ethers.Wallet(process.env.CELO_DEPLOYER_KEY!),
  );

  const checker = new CoreInvariantChecker(deploys);
  await checker.checkDeploys();
  checker.expectViolations([ViolationType.UpgradeBeacon], [4]);
  const builder = new GovernanceCallBatchBuilder(
    deploys,
    mainnet,
    checker.violations,
  );
  const batch = await builder.build();

  const domains = deploys.map((d: CoreDeploy) => d.chainConfig.domain);
  for (const home of domains) {
    for (const remote of domains) {
      if (home === remote) continue;
      const core = mainnet.mustGetCore(remote);
      const replica = core.getReplica(home);
      const transferOwnership =
        await replica!.populateTransaction.transferOwnership(
          core._governanceRouter,
        );
      batch.push(remote, transferOwnership as Call);
    }
  }

  const txs = await batch.build();
  // For each domain, expect one call to upgrade the contract and then three
  // calls to transfer replica ownership.
  expectCalls(batch, domains, new Array(4).fill(4));
  // Change to `batch.execute` in order to run.
  const receipts = await batch.estimateGas();
  console.log(txs);
  console.log(receipts);
}
main().then(console.log).catch(console.error);
