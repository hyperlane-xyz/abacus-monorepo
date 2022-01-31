import { AgentConfig } from '../agents';
import {
  CreateAliasCommand,
  CreateKeyCommand,
  DeleteAliasCommand,
  GetPublicKeyCommand,
  KeySpec,
  KeyUsageType,
  KMSClient,
  ListAliasesCommand,
  OriginType,
  UpdateAliasCommand,
} from '@aws-sdk/client-kms';
import { getEthereumAddress } from '../utils';

interface UnfetchedKey {
  fetched: false;
}

interface FetchedKey {
  fetched: true;
  address: string;
}

type RemoteKey = UnfetchedKey | FetchedKey;

export class AwsKey {
  private environment: string;
  private client: KMSClient;
  public remoteKey: RemoteKey = { fetched: false };

  constructor(
    agentConfig: AgentConfig,
    public readonly role: string,
    public readonly chainName: string,
  ) {
    if (
      !agentConfig.awsRegion ||
      !agentConfig.awsKeyId ||
      !agentConfig.awsSecretAccessKey
    ) {
      throw new Error('No AWS env vars set');
    }
    this.environment = agentConfig.environment;
    this.client = new KMSClient({
      region: agentConfig.awsRegion,
      credentials: {
        accessKeyId: agentConfig.awsKeyId,
        secretAccessKey: agentConfig.awsSecretAccessKey,
      },
    });
  }

  aliasName() {
    return `alias/${this.environment}-${this.chainName}-${this.role}`;
  }

  address() {
    this.requireFetched();
    // @ts-ignore
    return this.remoteKey.address;
  }

  async fetchFromAws() {
    const address = await this.fetchAddressFromAws()
    this.remoteKey = {
      fetched: true,
      address
    };
  }

  async create() {
    this._create(false);
  }

  /**
   * Creates the new key but doesn't acutally rotate it
   * @returns The address of the new key
   */
  async update() {
    return this._create(true);
  }

  /**
   * Requires update to have been called on this key prior
   */
  async rotate() {
    const canonicalAlias = this.aliasName();
    const newAlias = canonicalAlias + '-new';
    const oldAlias = canonicalAlias + '-old';

    // Get the key IDs
    const listAliasResponse = await this.client.send(
      new ListAliasesCommand({ Limit: 100 }),
    );
    const canonicalMatch = listAliasResponse.Aliases!.find(
      (_) => _.AliasName === canonicalAlias,
    );
    const newMatch = listAliasResponse.Aliases!.find(
      (_) => _.AliasName === newAlias,
    );
    const oldMatch = listAliasResponse.Aliases!.find(
      (_) => _.AliasName === oldAlias,
    );
    if (!canonicalMatch || !newMatch) {
      throw new Error(
        `Attempted to rotate keys but one of them does not exist. Old: ${canonicalMatch}, New: ${newMatch}`,
      );
    }

    if (oldMatch) {
      throw new Error(
        `Old alias ${oldAlias} points to a key, please remove manually before proceeding`,
      );
    }

    const oldKeyId = canonicalMatch.TargetKeyId!;
    const newKeyId = newMatch.TargetKeyId!;

    // alias the current with oldAlias
    await this.client.send(
      new CreateAliasCommand({ TargetKeyId: oldKeyId, AliasName: oldAlias }),
    );

    // alias the newKey with canonicalAlias
    await this.client.send(
      new UpdateAliasCommand({
        TargetKeyId: newKeyId,
        AliasName: canonicalAlias,
      }),
    );

    // Remove the old alias
    await this.client.send(new DeleteAliasCommand({ AliasName: newAlias }));

    // Address should have changed now
    this.fetchFromAws()
  }

  private requireFetched() {
    if (!this.remoteKey.fetched) {
      throw new Error("Can't persist without address");
    }
  }

  // Creates a new key and returns its address
  private async _create(rotate: boolean) {
    const alias = this.aliasName();
    if (!rotate) {
      // Make sure the alias is not currently in use
      const listAliasResponse = await this.client.send(
        new ListAliasesCommand({ Limit: 100 }),
      );
      const match = listAliasResponse.Aliases!.find(
        (_) => _.AliasName === alias,
      );
      if (match) {
        throw new Error(
          `Attempted to create new key but alias ${alias} already exists`,
        );
      }
    }

    const command = new CreateKeyCommand({
      Description: `${this.environment} ${this.chainName} ${this.role}`,
      KeyUsage: KeyUsageType.SIGN_VERIFY,
      Origin: OriginType.AWS_KMS,
      BypassPolicyLockoutSafetyCheck: false,
      KeySpec: KeySpec.ECC_SECG_P256K1,
      Tags: [{ TagKey: 'environment', TagValue: this.environment }],
    });

    const createResponse = await this.client.send(command);
    if (!createResponse.KeyMetadata) {
      throw new Error('KeyMetadata was not returned when creating the key');
    }
    const keyId = createResponse.KeyMetadata?.KeyId;

    const newAliasName = rotate ? `${alias}-new` : alias;
    await this.client.send(
      new CreateAliasCommand({ TargetKeyId: keyId, AliasName: newAliasName }),
    );

    const address = this.fetchAddressFromAws(keyId)
    return address
  }


  private async fetchAddressFromAws(keyId?: string) {
    const alias = this.aliasName();

    if (!keyId) {
      const listAliasResponse = await this.client.send(
        new ListAliasesCommand({ Limit: 100 }),
      );
  
      const match = listAliasResponse.Aliases!.find((_) => _.AliasName === alias);
  
      if (!match || !match.TargetKeyId) {
        throw new Error('Couldnt find key');
      }
      keyId = match.TargetKeyId
    }
    
    const publicKeyResponse = await this.client.send(
      new GetPublicKeyCommand({ KeyId: keyId }),
    );

    return getEthereumAddress(Buffer.from(publicKeyResponse.PublicKey!))
  }

}
