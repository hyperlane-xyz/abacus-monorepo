import path from 'path';
import yargs from 'yargs';

import {
  AllChains,
  ChainMap,
  ChainName,
  IChainConnection,
  MultiProvider,
  objMap,
  promiseObjAll,
} from '@abacus-network/sdk';

import { Contexts } from '../config/contexts';
import { environments } from '../config/environments';
import { getCurrentKubernetesContext } from '../src/agents';
import { AgentKey } from '../src/agents/agent';
import { getKey } from '../src/agents/key-utils';
import { KEY_ROLE_ENUM } from '../src/agents/roles';
import { CoreEnvironmentConfig, DeployEnvironment } from '../src/config';
import { fetchProvider } from '../src/config/chain';
import { EnvironmentNames } from '../src/config/environment';
import { assertContext } from '../src/utils/utils';

export function getArgs() {
  return yargs(process.argv.slice(2))
    .alias('e', 'env')
    .describe('e', 'deploy environment')
    .string('e')
    .describe('context', 'deploy context')
    .string('context')
    .help('h')
    .alias('h', 'help');
}

export async function getEnvironmentFromArgs(): Promise<string> {
  const argv = await getArgs().argv;
  return argv.e!;
}

export function assertEnvironment(env: string): DeployEnvironment {
  if (EnvironmentNames.includes(env)) {
    return env as DeployEnvironment;
  }
  throw new Error(
    `Invalid environment ${env}, must be one of ${EnvironmentNames}`,
  );
}

export function getCoreEnvironmentConfig<Env extends DeployEnvironment>(
  env: Env,
): CoreEnvironmentConfig<any> {
  return environments[env];
}

export async function getEnvironment() {
  return assertEnvironment(await getEnvironmentFromArgs());
}

export async function getEnvironmentConfig() {
  return getCoreEnvironmentConfig(await getEnvironment());
}

export async function getContext(): Promise<Contexts> {
  const argv = await getArgs().argv;
  return assertContext(argv.context!);
}

// Gets the agent config for the context that has been specified via yargs.
export async function getContextAgentConfig<Chain extends ChainName>(
  coreEnvironmentConfig?: CoreEnvironmentConfig<Chain>,
) {
  return getAgentConfig(await getContext(), coreEnvironmentConfig);
}

// Gets the agent config of a specific context.
export async function getAgentConfig<Chain extends ChainName>(
  context: Contexts,
  coreEnvironmentConfig?: CoreEnvironmentConfig<Chain>,
) {
  const coreConfig = coreEnvironmentConfig
    ? coreEnvironmentConfig
    : await getEnvironmentConfig();
  const agentConfig = coreConfig.agents[context];
  if (!agentConfig) {
    throw Error(
      `Invalid context ${context} for environment, must be one of ${Object.keys(
        coreConfig.agents,
      )}.`,
    );
  }
  return agentConfig;
}

async function getKeyForRole<Chain extends ChainName>(
  environment: DeployEnvironment,
  context: Contexts,
  chain: Chain,
  role: KEY_ROLE_ENUM,
  index?: number,
): Promise<AgentKey> {
  const coreConfig = getCoreEnvironmentConfig(environment);
  const agentConfig = await getAgentConfig(context, coreConfig);
  return getKey(agentConfig, role, chain, index);
}

export async function getMultiProviderForRole<Chain extends ChainName>(
  txConfigs: ChainMap<Chain, IChainConnection>,
  environment: DeployEnvironment,
  context: Contexts,
  role: KEY_ROLE_ENUM,
  index?: number,
): Promise<MultiProvider<Chain>> {
  const connections = await promiseObjAll(
    objMap(txConfigs, async (chain, config) => {
      const provider = await fetchProvider(environment, chain);
      const key = await getKeyForRole(environment, context, chain, role, index);
      const signer = await key.getSigner(provider);
      return {
        ...config,
        provider,
        signer,
      };
    }),
  );
  return new MultiProvider<Chain>(connections);
}

function getContractsSdkFilepath(mod: string) {
  return path.join('../sdk/src/', mod, 'environments');
}

export function getCoreContractsSdkFilepath() {
  return getContractsSdkFilepath('consts');
}

export function getEnvironmentDirectory(environment: DeployEnvironment) {
  return path.join('./config/environments/', environment);
}

export function getCoreDirectory(environment: DeployEnvironment) {
  return path.join(getEnvironmentDirectory(environment), 'core');
}

export function getCoreVerificationDirectory(environment: DeployEnvironment) {
  return path.join(getCoreDirectory(environment), 'verification');
}

export function getCoreRustDirectory(environment: DeployEnvironment) {
  return path.join('../../', 'rust', 'config', environment);
}

export function getKeyRoleAndChainArgs() {
  return getArgs()
    .alias('r', 'role')
    .describe('r', 'key role')
    .choices('r', Object.values(KEY_ROLE_ENUM))
    .require('r')
    .alias('c', 'chain')
    .describe('c', 'chain name')
    .choices('c', AllChains)
    .require('c')
    .alias('i', 'index')
    .describe('i', 'index of role')
    .number('i');
}

export async function assertCorrectKubeContext<Chain extends ChainName>(
  coreConfig: CoreEnvironmentConfig<Chain>,
) {
  const currentKubeContext = await getCurrentKubernetesContext();
  if (
    !currentKubeContext.endsWith(`${coreConfig.infra.kubernetes.clusterName}`)
  ) {
    console.error(
      `Cowardly refusing to deploy using k8s context ${currentKubeContext}; are you sure you have the right k8s context active?`,
    );
    process.exit(1);
  }
}
