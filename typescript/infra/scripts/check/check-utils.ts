import { HelloWorldChecker } from '@hyperlane-xyz/helloworld';
import { ChainAddresses } from '@hyperlane-xyz/registry';
import {
  ChainMap,
  HypERC20App,
  HypERC20Checker,
  HyperlaneCore,
  HyperlaneCoreChecker,
  HyperlaneIgp,
  HyperlaneIgpChecker,
  HyperlaneIsmFactory,
  InterchainAccount,
  InterchainAccountChecker,
  InterchainAccountConfig,
  InterchainQuery,
  InterchainQueryChecker,
  MultiProvider,
  attachContractsMapAndGetForeignDeployments,
  hypERC20factories,
  proxiedFactories,
} from '@hyperlane-xyz/sdk';
import { eqAddress, objFilter } from '@hyperlane-xyz/utils';

import { Contexts } from '../../config/contexts.js';
import { DEPLOYER } from '../../config/environments/mainnet3/owners.js';
import { getWarpConfig } from '../../config/warp.js';
import { EnvironmentConfig } from '../../src/config/environment.js';
import { HyperlaneAppGovernor } from '../../src/govern/HyperlaneAppGovernor.js';
import { HyperlaneCoreGovernor } from '../../src/govern/HyperlaneCoreGovernor.js';
import { HyperlaneIgpGovernor } from '../../src/govern/HyperlaneIgpGovernor.js';
import { ProxiedRouterGovernor } from '../../src/govern/ProxiedRouterGovernor.js';
import { Role } from '../../src/roles.js';
import { impersonateAccount, useLocalProvider } from '../../src/utils/fork.js';
import { logViolationDetails } from '../../src/utils/violation.js';
import {
  Modules,
  getArgs as getRootArgs,
  getWarpAddresses,
  withAsDeployer,
  withChain,
  withContext,
  withFork,
  withGovern,
  withModule,
  withWarpRouteId,
} from '../agent-utils.js';
import { getEnvironmentConfig, getHyperlaneCore } from '../core-utils.js';
import { getHelloWorldApp } from '../helloworld/utils.js';

export function getCheckArgs() {
  return withAsDeployer(
    withGovern(withChain(withFork(withContext(getRootArgs())))),
  );
}

export function getCheckDeployArgs() {
  return withWarpRouteId(withModule(getCheckArgs()));
}

export async function check(argv?: Record<string, any>) {
  const {
    fork,
    govern,
    module,
    environment,
    context,
    chain,
    asDeployer,
    warpRouteId,
  } = argv ?? (await getCheckDeployArgs().argv);

  const envConfig = getEnvironmentConfig(environment);
  let multiProvider = await envConfig.getMultiProvider();

  // must rotate to forked provider before building core contracts
  if (fork) {
    await useLocalProvider(multiProvider, fork);

    if (govern) {
      multiProvider = multiProvider.extendChainMetadata({
        [fork]: { blocks: { confirmations: 0 } },
      });

      const owner = asDeployer ? DEPLOYER : envConfig.core[fork].owner;
      const signer = await impersonateAccount(owner, 1e18);

      multiProvider.setSigner(fork, signer);
    }
  }

  const { core, chainAddresses } = await getHyperlaneCore(
    environment,
    multiProvider,
  );

  const governor = await getGovernor(
    module,
    multiProvider,
    core,
    envConfig,
    chainAddresses,
    context,
    chain,
    fork,
    warpRouteId,
  );

  // TODO: getGovernor should throw if module not implemented and this should be removed
  if (!governor) {
    return;
  }

  if (fork) {
    await governor.checker.checkChain(fork);
    if (govern) {
      await governor.govern(false, fork);
    }
  } else if (chain) {
    await governor.checker.checkChain(chain);
    if (govern) {
      await governor.govern(true, chain);
    }
  } else {
    await governor.checker.check();
    if (govern) {
      await governor.govern();
    }
  }

  if (!govern) {
    const violations = governor.checker.violations;
    if (violations.length > 0) {
      console.table(violations, [
        'chain',
        'remote',
        'name',
        'type',
        'subType',
        'actual',
        'expected',
      ]);

      logViolationDetails(violations);

      if (!fork) {
        throw new Error(
          `Checking ${module} deploy yielded ${violations.length} violations`,
        );
      }
    } else {
      console.info(`${module} checker found no violations`);
    }
  }
}

const getGovernor = async (
  module: Modules,
  multiProvider: MultiProvider,
  core: HyperlaneCore,
  envConfig: EnvironmentConfig,
  chainAddresses: ChainMap<ChainAddresses>,
  context: Contexts,
  chain?: string,
  fork?: string,
  warpRouteId?: string,
) => {
  let governor: HyperlaneAppGovernor<any, any>;

  const ismFactory = HyperlaneIsmFactory.fromAddressesMap(
    chainAddresses,
    multiProvider,
  );

  const routerConfig = core.getRouterConfig(envConfig.owners);

  const icaChainAddresses = objFilter(
    chainAddresses,
    (chain, addresses): addresses is Record<string, string> =>
      !!chainAddresses[chain]?.interchainAccountRouter,
  );
  const ica = InterchainAccount.fromAddressesMap(
    icaChainAddresses,
    multiProvider,
  );

  if (module === Modules.CORE) {
    const checker = new HyperlaneCoreChecker(
      multiProvider,
      core,
      envConfig.core,
      ismFactory,
      chainAddresses,
    );
    governor = new HyperlaneCoreGovernor(checker, ica);
  } else if (module === Modules.INTERCHAIN_GAS_PAYMASTER) {
    const igp = HyperlaneIgp.fromAddressesMap(chainAddresses, multiProvider);
    const checker = new HyperlaneIgpChecker(multiProvider, igp, envConfig.igp);
    governor = new HyperlaneIgpGovernor(checker);
  } else if (module === Modules.INTERCHAIN_ACCOUNTS) {
    const checker = new InterchainAccountChecker(
      multiProvider,
      ica,
      objFilter(
        routerConfig,
        (chain, _): _ is InterchainAccountConfig => !!icaChainAddresses[chain],
      ),
    );
    governor = new ProxiedRouterGovernor(checker);
  } else if (module === Modules.INTERCHAIN_QUERY_SYSTEM) {
    const iqs = InterchainQuery.fromAddressesMap(chainAddresses, multiProvider);
    const checker = new InterchainQueryChecker(
      multiProvider,
      iqs,
      routerConfig,
    );
    governor = new ProxiedRouterGovernor(checker);
  } else if (module === Modules.HELLO_WORLD) {
    const app = await getHelloWorldApp(
      envConfig,
      context,
      Role.Deployer,
      Contexts.Hyperlane, // Owner should always be from the hyperlane context
    );
    const ismFactory = HyperlaneIsmFactory.fromAddressesMap(
      chainAddresses,
      multiProvider,
    );
    const checker = new HelloWorldChecker(
      multiProvider,
      app,
      routerConfig,
      ismFactory,
    );
    governor = new ProxiedRouterGovernor(checker);
  } else if (module === Modules.WARP) {
    if (!warpRouteId) {
      throw new Error('Warp route id required for warp module');
    }
    const config = await getWarpConfig(multiProvider, envConfig, warpRouteId);
    const warpAddresses = getWarpAddresses(warpRouteId);
    const filteredAddresses = Object.keys(warpAddresses) // filter out changes not in config
      .filter((key) => key in config)
      .reduce((obj, key) => {
        obj[key] = {
          ...warpAddresses[key],
        };

        // if the owner in the config is an AW account, set the proxyAdmin to the AW singleton proxyAdmin
        // this will ensure that the checker will check that any proxies are owned by the singleton proxyAdmin
        const proxyAdmin = eqAddress(
          config[key].owner,
          envConfig.owners[key]?.owner,
        )
          ? chainAddresses[key]?.proxyAdmin
          : undefined;

        if (proxyAdmin) {
          obj[key].proxyAdmin = proxyAdmin;
        }

        return obj;
      }, {} as typeof warpAddresses);

    const { contractsMap, foreignDeployments } =
      attachContractsMapAndGetForeignDeployments(
        filteredAddresses,
        { ...hypERC20factories, ...proxiedFactories },
        multiProvider,
      );

    // log error and return if foreign deployment chain is specifically checked
    if (
      (chain && foreignDeployments[chain]) ||
      (fork && foreignDeployments[fork])
    ) {
      console.log(
        `${
          chain ?? fork
        } is non evm and it not compatible with warp checker tooling`,
      );
      return;
    }

    const app = new HypERC20App(
      contractsMap,
      multiProvider,
      undefined,
      foreignDeployments,
    );

    const checker = new HypERC20Checker(
      multiProvider,
      app,
      config as any,
      ismFactory,
    );
    governor = new ProxiedRouterGovernor(checker, ica);
  } else {
    // TODO: should we throw here instead?
    console.log(`Skipping ${module}, checker or governor not implemented`);
    return;
  }

  return governor;
};
