import {
  ChainName,
  HyperlaneDeployer,
  buildContracts,
  serializeContracts,
} from '@hyperlane-xyz/sdk';

import {
  readJSONAtPath,
  writeJsonAtPath,
  writeMergedJSONAtPath,
} from './utils/utils';

export async function deployWithArtifacts(
  deployer: HyperlaneDeployer<any, any, any>,
  addressesPath: string,
  verificationPath: string,
  fork?: ChainName,
) {
  const addresses = readJSONAtPath(addressesPath);
  const savedContracts = buildContracts(addresses, deployer.factories);
  deployer.cacheContracts(savedContracts);

  if (fork) {
    await deployer.deployContracts(fork, deployer.configMap[fork]);
    // TODO: reconsider writing artifacts in fork mode
    return;
  }

  try {
    await deployer.deploy();
  } catch (e) {
    console.error(e);
  }
  writeMergedJSONAtPath(
    addressesPath,
    serializeContracts(deployer.deployedContracts),
  );

  const savedVerification = readJSONAtPath(verificationPath);
  const inputs =
    deployer.mergeWithExistingVerificationInputs(savedVerification);
  writeJsonAtPath(verificationPath, inputs);
}
