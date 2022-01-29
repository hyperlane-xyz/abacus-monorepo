import { Wallet } from 'ethers';
import { rm, writeFile } from 'fs/promises';
import { KEY_ROLES } from '../agents';
import { Chain, replaceDeployer } from '../chain';
import { CoreConfig } from '../core/CoreDeploy';
import { execCmd, include, strip0x } from '../utils';

function isAttestationKey(role: string) {
  return role.endsWith('attestation');
}

// This is the type for how the keys are persisted in GCP
export interface SecretManagerPersistedKeys {
  privateKey: string;
  address: string;
  role: string;
  environment: string;
  // Exists if key is an attestation key
  // TODO: Add this to the type
  chainName?: string;
}

function identifier(
  environment: string,
  role: string,
  chainName: string,
) {
  return isAttestationKey(role)
    ? `optics-key-${environment}-${chainName}-${role}`
    : `optics-key-${environment}-${role}`;
}

interface UnfetchedKey {
  fetched: false;
}

interface FetchedKey {
  fetched: true;
  privateKey: string;
  address: string;
}

type RemoteKey = UnfetchedKey | FetchedKey;

export class AgentGCPKey {
  constructor(
    public readonly environment: string,
    public readonly role: string,
    public readonly chainName: string,
    private remoteKey: RemoteKey = { fetched: false },
  ) {}

  static async create(environment: string, role: string, chainName: string) {
    const key = new AgentGCPKey(environment, role, chainName);
    await key.create();
    return key;
  }

  serializeAsAddress() {
    this.requireFetched()
    return {
      role: isAttestationKey(this.role)
        ? `${this.chainName}-${this.role}`
        : this.role,
      // @ts-ignore
      address: this.remoteKey.address,
    };
  }

  isAttestationKey() {
    return isAttestationKey(this.role);
  }

  identifier() {
    return identifier(this.environment, this.role, this.chainName);
  }

  // The identifier for this key within a set of keys for an enrivonment
  memoryKeyIdentifier() {
    return isAttestationKey(this.role)
      ? `${this.chainName}-${this.role}`
      : this.role;
  }

  privateKey() {
    this.requireFetched()
    // @ts-ignore
    return this.remoteKey.privateKey;
  }

  address() {
    this.requireFetched()
    // @ts-ignore
    return this.remoteKey.address;
  }

  async fetchFromGCP() {
    const [secretRaw] = await execCmd(
      `gcloud secrets versions access latest --secret ${this.identifier()}`,
    );
    const secret: SecretManagerPersistedKeys = JSON.parse(secretRaw);
    this.remoteKey = {
      fetched: true,
      privateKey: secret.privateKey,
      address: secret.address,
    };
  }

  async create() {
    this.remoteKey = await this._create(false);
  }

  // Creates a rotation of this key
  async update() {
    this.remoteKey = await this._create(true);
    const addressesIdentifier = `optics-key-${this.environment}-addresses`;
    const fileName = `${addressesIdentifier}.txt`;
    const [addressesRaw] = await execCmd(
      `gcloud secrets versions access latest --secret ${addressesIdentifier}`,
    );
    const addresses = JSON.parse(addressesRaw);
    const filteredAddresses = addresses.filter((_: any) => {
      const matchingRole = memoryKeyIdentifier(this.role, this.chainName);
      return _.role !== matchingRole;
    });

    filteredAddresses.push(this.serializeAsAddress());

    await writeFile(fileName, JSON.stringify(filteredAddresses));
    await execCmd(
      `gcloud secrets versions add ${addressesIdentifier} --data-file=${fileName}`,
    );
    await rm(fileName);
  }

  async delete() {
    await execCmd(`gcloud secrets delete ${this.identifier()} --quiet`);
  }

  private requireFetched() {
    if (!this.remoteKey.fetched) {
      throw new Error("Can't persist without address");
    }
  }

  private async _create(rotate: boolean) {
    const wallet = Wallet.createRandom();
    const address = await wallet.getAddress();
    const identifier = this.identifier();
    const fileName = `${identifier}.txt`;

    let labels = `environment=${this.environment},role=${this.role}`;
    if (this.isAttestationKey()) labels += `,chain=${this.chainName}`;

    await writeFile(
      fileName,
      JSON.stringify({
        role: this.role,
        environment: this.environment,
        privateKey: wallet.privateKey,
        address,
        ...include(this.isAttestationKey(), { chainName: this.chainName }),
      }),
    );

    if (rotate) {
      await execCmd(
        `gcloud secrets versions add ${identifier} --data-file=${fileName}`,
      );
    } else {
      await execCmd(
        `gcloud secrets create ${identifier} --data-file=${fileName} --replication-policy=automatic --labels=${labels}`,
      );
    }

    await rm(fileName);
    return {
      fetched: true,
      privateKey: wallet.privateKey,
      address,
    };
  }
}

export async function deleteAgentGCPKeys(
  environment: string,
  chainNames: string[],
) {
  await Promise.all(
    KEY_ROLES.map(async (role) => {
      if (isAttestationKey(role)) {
        await Promise.all(
          chainNames.map((chainName) => {
            const key = new AgentGCPKey(environment, role, chainName);
            return key.delete();
          }),
        );
      } else {
        const key = new AgentGCPKey(environment, role, 'any');
        await key.delete();
      }
    }),
  );
  await execCmd(
    `gcloud secrets delete optics-key-${environment}-addresses --quiet`,
  );
}

// The identifier for a key within a memory representation
export function memoryKeyIdentifier(role: string, chainName: string) {
  return isAttestationKey(role) ? `${chainName}-${role}` : role;
}

export async function createAgentGCPKeys(
  environment: string,
  chainNames: string[],
) {
  const keys: AgentGCPKey[] = await Promise.all(
    KEY_ROLES.flatMap((role) => {
      if (isAttestationKey(role)) {
        return chainNames.map(async (chainName) =>
          AgentGCPKey.create(environment, role, chainName),
        );
      } else {
        // Chain name doesnt matter for non attestation keys
        return [AgentGCPKey.create(environment, role, 'any')];
      }
    }),
  );
  const fileName = `optics-key-${environment}-addresses.txt`;

  await writeFile(
    fileName,
    JSON.stringify(keys.map((_) => _.serializeAsAddress)),
  );
  await execCmd(
    `gcloud secrets create optics-key-${environment}-addresses --data-file=${fileName} --replication-policy=automatic --labels=environment=${environment}`,
  );
  await rm(fileName);
}

// This function returns all the GCP keys for a given home chain in a dictionary where the key is either the role or `${chainName}-${role}` in the case of attestation keys
export async function fetchAgentGCPKeys(
  environment: string,
  chainName: string,
): Promise<Record<string, AgentGCPKey>> {
  const secrets = await Promise.all(
    KEY_ROLES.map(async (role) => {
      const key = new AgentGCPKey(environment, role, chainName);
      await key.fetchFromGCP();
      return [key.memoryKeyIdentifier(), key];
    }),
  );
  return Object.fromEntries(secrets);
}

// Modifies a Chain configuration with the deployer key pulled from GCP
export async function addDeployerGCPKey(environment: string, chain: Chain) {
  const [deployerSecretRaw] = await execCmd(
    `gcloud secrets versions access latest --secret optics-key-${environment}-deployer`,
  );
  const deployerSecret = JSON.parse(deployerSecretRaw).privateKey;
  return replaceDeployer(chain, strip0x(deployerSecret));
}

// Modifies a Core configuration with the relevant watcher/updater addresses pulled from GCP
export async function addAgentGCPAddresses(
  environment: string,
  chain: Chain,
  config: CoreConfig,
): Promise<CoreConfig> {
  const [addressesRaw] = await execCmd(
    `gcloud secrets versions access latest --secret optics-key-${environment}-addresses`,
  );
  const addresses = JSON.parse(addressesRaw);
  const watcher = addresses.find(
    (_: any) => _.role === `${chain.name}-watcher-attestation`,
  ).address;
  const updater = addresses.find(
    (_: any) => _.role === `${chain.name}-updater-attestation`,
  ).address;
  const deployer = addresses.find((_: any) => _.role === 'deployer').address;
  return {
    ...config,
    updater: updater,
    recoveryManager: deployer,
    watchers: [watcher],
  };
}
