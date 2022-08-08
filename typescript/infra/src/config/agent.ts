import { ChainMap, ChainName, RemoteChainMap } from '@abacus-network/sdk';
import { types } from '@abacus-network/utils';

import { Contexts } from '../../config/contexts';
import {
  AgentAwsKey,
  AgentAwsUser,
  ValidatorAgentAwsUser,
} from '../agents/aws';
import { KEY_ROLE_ENUM } from '../agents/roles';

import { DeployEnvironment } from './environment';

// Allows a "default" config to be specified and any per-chain overrides.
interface ChainOverridableConfig<Chain extends ChainName, T> {
  default: T;
  chainOverrides?: Partial<ChainMap<Chain, Partial<T>>>;
}

// Returns the default config with any overriden values specified for the provided chain.
export function getChainOverriddenConfig<Chain extends ChainName, T>(
  overridableConfig: ChainOverridableConfig<Chain, T>,
  chain: Chain,
): T {
  return {
    ...overridableConfig.default,
    ...overridableConfig.chainOverrides?.[chain],
  };
}

// =====================================
// =====     Checkpoint Syncer     =====
// =====================================

// These values are eventually passed to Rust, which expects the values to be camelCase
export const enum CheckpointSyncerType {
  LocalStorage = 'localStorage',
  S3 = 's3',
}

interface LocalCheckpointSyncerConfig {
  type: CheckpointSyncerType.LocalStorage;
  path: string;
}

interface S3CheckpointSyncerConfig {
  type: CheckpointSyncerType.S3;
  bucket: string;
  region: string;
}

export type CheckpointSyncerConfig =
  | LocalCheckpointSyncerConfig
  | S3CheckpointSyncerConfig;

interface MultisigCheckpointSyncerConfig {
  threshold: number;
  // Keyed by validator address
  checkpointSyncers: Record<string, CheckpointSyncerConfig>;
}

// =================================
// =====     Validator Set     =====
// =================================

// A validator set for a single chain
interface ValidatorSet {
  threshold: number;
  validators: Array<Validator>;
}

// A validator. This isn't agent-specific configuration, just information
// on the validator that is enrolled in a validator set.
interface Validator {
  address: string;
  checkpointSyncer: CheckpointSyncerConfig;
}

// Validator sets for each chain
export type ChainValidatorSets<Chain extends ChainName> = ChainMap<
  Chain,
  ValidatorSet
>;

// =================================
// =====     Relayer Agent     =====
// =================================

type Whitelist = WhitelistElement[];

interface WhitelistElement {
  sourceDomain?: '*' | string | string[] | number | number[];
  sourceAddress?: '*' | string | string[];
  destinationDomain?: '*' | string | string[] | number | number[];
  destinationAddress?: '*' | string | string[];
}

// Incomplete basic relayer agent config
interface BaseRelayerConfig {
  // The polling interval to check for new signed checkpoints in seconds
  signedCheckpointPollingInterval: number;
  // The maxinmum number of times a processor will try to process a message
  maxProcessingRetries: number;
  whitelist?: Whitelist;
}

// Per-chain relayer agent configs
type ChainRelayerConfigs<Chain extends ChainName> = ChainOverridableConfig<
  Chain,
  BaseRelayerConfig
>;

// Full relayer agent config for a single chain
interface RelayerConfig extends Omit<BaseRelayerConfig, 'whitelist'> {
  multisigCheckpointSyncer: MultisigCheckpointSyncerConfig;
  whitelist?: string;
}

// ===================================
// =====     Validator Agent     =====
// ===================================

// Incomplete basic validator agent config
interface BaseValidatorConfig {
  // How frequently to check for new checkpoints
  interval: number;
  // The reorg_period in blocks
  reorgPeriod: number;
}

// Per-chain validator agent configs
type ChainValidatorConfigs<Chain extends ChainName> = ChainOverridableConfig<
  Chain,
  BaseValidatorConfig
>;

// Full validator agent config for a single chain
interface ValidatorConfig extends BaseValidatorConfig {
  checkpointSyncer: CheckpointSyncerConfig;
  validator: KeyConfig;
}

// ===============================
// =====     Kathy Agent     =====
// ===============================

interface ChatGenConfig {
  type: 'static';
  message: string;
  recipient: string;
}

// Full kathy agent config for a single chain
interface KathyConfig {
  // The message interval (in seconds)
  interval: number;
  // Configuration for kathy's chat
  chat: ChatGenConfig;
  // Whether kathy is enabled
  enabled: boolean;
}

// Per-chain kathy agent configs
type ChainKathyConfigs<Chain extends ChainName> = ChainOverridableConfig<
  Chain,
  KathyConfig
>;

// Eventually consumed by Rust, which expects camelCase values
export enum KeyType {
  Aws = 'aws',
  Hex = 'hexKey',
}

export interface AwsKeyConfig {
  type: KeyType.Aws;
  // ID of the key, can be an alias of the form `alias/foo-bar`
  id: string;
  // AWS region where the key is
  region: string;
}

// The private key is omitted so it can be fetched using external-secrets
export interface HexKeyConfig {
  type: KeyType.Hex;
}

export type KeyConfig = AwsKeyConfig | HexKeyConfig;

interface IndexingConfig {
  from: number;
  chunk: number;
}

export interface AwsConfig {
  region: string;
}

export interface DockerConfig {
  repo: string;
  tag: string;
}

export interface AgentConfig<Chain extends ChainName> {
  environment: string;
  namespace: string;
  runEnv: string;
  context: Contexts;
  docker: DockerConfig;
  index?: IndexingConfig;
  aws?: AwsConfig;
  // Names of all chains in the environment
  environmentChainNames: Chain[];
  // Names of chains this context cares about
  contextChainNames: Chain[];
  validatorSets: ChainValidatorSets<Chain>;
  validator?: ChainValidatorConfigs<Chain>;
  relayer?: ChainRelayerConfigs<Chain>;
  kathy?: ChainKathyConfigs<Chain>;
  // Roles to manage keys for
  rolesWithKeys: KEY_ROLE_ENUM[];
}

export type RustSigner = {
  key: string;
  type: string; // TODO
};

export type RustConnection = {
  type: string; // TODO
  url: string;
};

export type RustContractBlock<T> = {
  addresses: T;
  domain: string;
  name: ChainName;
  rpcStyle: string; // TODO
  connection: RustConnection;
};

export type OutboxAddresses = {
  outbox: types.Address;
};

export type InboxAddresses = {
  inbox: types.Address;
  validatorManager: types.Address;
};

export type RustConfig<Chain extends ChainName> = {
  environment: DeployEnvironment;
  index?: { from: string };
  signers: Partial<ChainMap<Chain, RustSigner>>;
  inboxes: RemoteChainMap<Chain, any, RustContractBlock<InboxAddresses>>;
  outbox: RustContractBlock<OutboxAddresses>;
  tracing: {
    level: string;
    fmt: 'json';
  };
  db: string;
};

// Helper to get chain-specific agent configurations
export class ChainAgentConfig<Chain extends ChainName> {
  constructor(
    public readonly agentConfig: AgentConfig<Chain>,
    public readonly chainName: Chain,
  ) {}

  // Credentials are only needed if AWS keys are needed -- otherwise, the
  // key is pulled from GCP Secret Manager by the helm chart
  keyConfig(role: KEY_ROLE_ENUM): KeyConfig {
    if (this.awsKeys) {
      const key = new AgentAwsKey(this.agentConfig, role, this.chainName);
      return key.keyConfig;
    }
    return {
      type: KeyType.Hex,
    };
  }

  signers(role: KEY_ROLE_ENUM) {
    return this.agentConfig.contextChainNames.map((name) => ({
      name,
      keyConfig: this.keyConfig(role),
    }));
  }

  async validatorConfigs(): Promise<Array<ValidatorConfig> | undefined> {
    if (!this.validatorEnabled) {
      return undefined;
    }
    const baseConfig = getChainOverriddenConfig(
      this.agentConfig.validator!,
      this.chainName,
    );

    return Promise.all(
      this.validatorSet.validators.map(async (val, i) => {
        let validator: KeyConfig = {
          type: KeyType.Hex,
        };

        if (val.checkpointSyncer.type === CheckpointSyncerType.S3) {
          const awsUser = new ValidatorAgentAwsUser(
            this.agentConfig.environment,
            this.agentConfig.context,
            this.chainName,
            i,
            val.checkpointSyncer.region,
            val.checkpointSyncer.bucket,
          );
          await awsUser.createIfNotExists();
          await awsUser.createBucketIfNotExists();

          if (this.awsKeys) {
            const key = await awsUser.createKeyIfNotExists(this.agentConfig);
            validator = key.keyConfig;
          }
        } else {
          console.warn(
            `Validator ${val.address}'s checkpoint syncer is not S3-based. Be sure this is a non-k8s-based environment!`,
          );
        }

        return {
          ...baseConfig,
          checkpointSyncer: val.checkpointSyncer,
          validator,
        };
      }),
    );
  }

  get validatorEnabled(): boolean {
    return this.agentConfig.validator !== undefined;
  }

  // Returns whetehr the relayer requires AWS credentials, creating them if required.
  async relayerRequiresAwsCredentials(): Promise<boolean> {
    // If there is an S3 checkpoint syncer, we need AWS credentials.
    // We ensure they are created here, but they are actually read from using `external-secrets`
    // on the cluster.
    const firstS3Syncer = this.validatorSet.validators.find(
      (validator) =>
        validator.checkpointSyncer.type === CheckpointSyncerType.S3,
    )?.checkpointSyncer as S3CheckpointSyncerConfig | undefined;

    // If AWS is present on the agentConfig, we are using AWS keys and need credentials regardless.
    // This is undefined if AWS is not required
    const awsRegion: string | undefined =
      this.agentConfig.aws?.region ?? firstS3Syncer?.region;

    if (awsRegion !== undefined) {
      const awsUser = new AgentAwsUser(
        this.agentConfig.environment,
        this.agentConfig.context,
        KEY_ROLE_ENUM.Relayer,
        awsRegion,
        this.chainName,
      );
      await awsUser.createIfNotExists();
      // If we're using AWS keys, ensure the key is created and the user can use it
      if (this.awsKeys) {
        await awsUser.createKeyIfNotExists(this.agentConfig);
      }
      return true;
    }
    return false;
  }

  async relayerSigners() {
    if (!this.relayerEnabled) {
      return undefined;
    }

    if (!this.awsKeys) {
      return this.signers(KEY_ROLE_ENUM.Relayer);
    }
    const awsUser = new AgentAwsUser(
      this.agentConfig.environment,
      this.agentConfig.context,
      KEY_ROLE_ENUM.Relayer,
      this.agentConfig.aws!.region,
      this.chainName,
    );
    await awsUser.createIfNotExists();
    const key = await awsUser.createKeyIfNotExists(this.agentConfig);
    return this.agentConfig.contextChainNames.map((name) => ({
      name,
      keyConfig: key.keyConfig,
    }));
  }

  get relayerConfig(): RelayerConfig | undefined {
    if (!this.relayerEnabled) {
      return undefined;
    }

    const baseConfig = getChainOverriddenConfig(
      this.agentConfig.relayer!,
      this.chainName,
    );

    const checkpointSyncers = this.validatorSet.validators.reduce(
      (agg, val) => ({
        ...agg,
        [val.address]: val.checkpointSyncer,
      }),
      {},
    );

    const obj: RelayerConfig = {
      signedCheckpointPollingInterval:
        baseConfig.signedCheckpointPollingInterval,
      maxProcessingRetries: baseConfig.maxProcessingRetries,
      multisigCheckpointSyncer: {
        threshold: this.validatorSet.threshold,
        checkpointSyncers,
      },
    };
    if (baseConfig.whitelist) {
      obj.whitelist = JSON.stringify(baseConfig.whitelist);
    }

    return obj;
  }

  get relayerEnabled(): boolean {
    return this.agentConfig.relayer !== undefined;
  }

  // Gets signer info, creating them if necessary
  async kathySigners() {
    if (!this.kathyEnabled) {
      return [];
    }

    let keyConfig;

    if (this.awsKeys) {
      const awsUser = new AgentAwsUser(
        this.agentConfig.environment,
        this.agentConfig.context,
        KEY_ROLE_ENUM.Kathy,
        this.agentConfig.aws!.region,
        this.chainName,
      );
      await awsUser.createIfNotExists();
      const key = await awsUser.createKeyIfNotExists(this.agentConfig);
      keyConfig = key.keyConfig;
    } else {
      keyConfig = this.keyConfig(KEY_ROLE_ENUM.Kathy);
    }

    return [
      {
        name: this.chainName,
        keyConfig,
      },
    ];
  }

  get kathyRequiresAwsCredentials() {
    return this.awsKeys;
  }

  get kathyConfig(): KathyConfig | undefined {
    if (!this.agentConfig.kathy) {
      return undefined;
    }
    return getChainOverriddenConfig(this.agentConfig.kathy, this.chainName);
  }

  get kathyEnabled() {
    const kathyConfig = this.kathyConfig;
    return kathyConfig !== undefined && kathyConfig.enabled;
  }

  get validatorSet(): ValidatorSet {
    return this.agentConfig.validatorSets[this.chainName];
  }

  // Returns true if any of the validators in the validator set are using an S3 checkpoint syncer.
  get s3CheckpointSyncerExists(): boolean {
    return (
      this.validatorSet.validators.find(
        (validator) =>
          validator.checkpointSyncer.type === CheckpointSyncerType.S3,
      ) !== undefined
    );
  }

  get awsKeys(): boolean {
    return this.agentConfig.aws !== undefined;
  }
}
