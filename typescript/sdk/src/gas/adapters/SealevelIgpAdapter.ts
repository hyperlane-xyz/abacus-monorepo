import {
  Message,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  VersionedTransaction,
} from '@solana/web3.js';
import { deserializeUnchecked, serialize } from 'borsh';

import { Address, Domain } from '@hyperlane-xyz/utils';

import { BaseSealevelAdapter } from '../../app/MultiProtocolApp.js';
import { MultiProtocolProvider } from '../../providers/MultiProtocolProvider.js';
import { ChainName } from '../../types.js';
import {
  SealevelAccountDataWrapper,
  SealevelInstructionWrapper,
} from '../../utils/sealevelSerialization.js';

import {
  SealeveIgpInstruction,
  SealevelIgpQuoteGasPaymentInstruction,
  SealevelIgpQuoteGasPaymentResponse,
  SealevelIgpQuoteGasPaymentResponseSchema,
  SealevelIgpQuoteGasPaymentSchema,
  SealevelOverheadIgpData,
  SealevelOverheadIgpDataSchema,
} from './serialization.js';

export abstract class SealevelIgpProgramAdapter extends BaseSealevelAdapter {
  protected readonly programId: PublicKey;

  constructor(
    public readonly chainName: ChainName,
    public readonly multiProvider: MultiProtocolProvider,
    public readonly addresses: { programId: Address },
  ) {
    super(chainName, multiProvider, addresses);

    this.programId = new PublicKey(addresses.programId);
  }

  abstract quoteGasPayment(
    destination: Domain,
    gasAmount: bigint,
    payerKey: PublicKey,
  ): Promise<bigint>;

  // Simulating a transaction requires a payer to have sufficient balance to pay for tx fees.
  protected async quoteGasPaymentForIgpAccounts(
    destination: Domain,
    gasAmount: bigint,
    payerKey: PublicKey,
    igpAccount: PublicKey,
    overheadIgpAccount?: PublicKey,
  ): Promise<bigint> {
    let keys = [
      // 0. `[executable]` The system program.
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      // 1. `[]` The IGP account.
      {
        pubkey: igpAccount,
        isSigner: false,
        isWritable: false,
      },
    ];
    if (overheadIgpAccount) {
      // 2. `[]` The overhead IGP account (optional).
      keys.push({
        pubkey: overheadIgpAccount,
        isSigner: false,
        isWritable: false,
      });
    }
    const value = new SealevelInstructionWrapper({
      instruction: SealeveIgpInstruction.QuoteGasPayment,
      data: new SealevelIgpQuoteGasPaymentInstruction({
        destination_domain: destination,
        gas_amount: BigInt(gasAmount),
      }),
    });
    const quoteGasPaymentInstruction = new TransactionInstruction({
      keys,
      programId: this.programId,
      data: Buffer.from(serialize(SealevelIgpQuoteGasPaymentSchema, value)),
    });

    const message = Message.compile({
      // This is ignored
      recentBlockhash: PublicKey.default.toBase58(),
      instructions: [quoteGasPaymentInstruction],
      payerKey,
    });

    const tx = new VersionedTransaction(message);

    const connection = this.getProvider();
    const simulationResponse = await connection.simulateTransaction(tx, {
      // ignore the recent blockhash we pass in, and have the node use its latest one
      replaceRecentBlockhash: true,
      // ignore signature verification
      sigVerify: false,
    });

    const base64Data = simulationResponse.value.returnData?.data?.[0];
    if (base64Data === undefined) {
      throw Error(
        'No return data when quoting gas payment, may happen if the payer has insufficient funds',
      );
    }

    const data = Buffer.from(base64Data, 'base64');
    const quote = deserializeUnchecked(
      SealevelIgpQuoteGasPaymentResponseSchema,
      SealevelIgpQuoteGasPaymentResponse,
      data,
    );

    return quote.payment_quote;
  }

  // https://github.com/hyperlane-xyz/hyperlane-monorepo/blob/main/rust/sealevel/programs/hyperlane-sealevel-igp/src/pda_seeds.rs#L7
  static deriveIgpProgramPda(igpProgramId: string | PublicKey): PublicKey {
    return super.derivePda(
      ['hyperlane_igp', '-', 'program_data'],
      igpProgramId,
    );
  }

  // https://github.com/hyperlane-xyz/hyperlane-monorepo/blob/main/rust/sealevel/programs/hyperlane-sealevel-igp/src/pda_seeds.rs#L62
  static deriveGasPaymentPda(
    igpProgramId: string | PublicKey,
    randomWalletPubKey: PublicKey,
  ): PublicKey {
    return super.derivePda(
      ['hyperlane_igp', '-', 'gas_payment', '-', randomWalletPubKey.toBuffer()],
      igpProgramId,
    );
  }
}

export class SealevelIgpAdapter extends SealevelIgpProgramAdapter {
  protected readonly igp: PublicKey;

  constructor(
    public readonly chainName: ChainName,
    public readonly multiProvider: MultiProtocolProvider,
    public readonly addresses: { igp: Address; programId: Address },
  ) {
    super(chainName, multiProvider, addresses);

    this.igp = new PublicKey(addresses.igp);
  }

  override async quoteGasPayment(
    destination: Domain,
    gasAmount: bigint,
    payerKey: PublicKey,
  ): Promise<bigint> {
    return super.quoteGasPaymentForIgpAccounts(
      destination,
      gasAmount,
      payerKey,
      this.igp,
    );
  }
}

export class SealevelOverheadIgpAdapter extends SealevelIgpProgramAdapter {
  protected readonly overheadIgp: PublicKey;

  constructor(
    public readonly chainName: ChainName,
    public readonly multiProvider: MultiProtocolProvider,
    public readonly addresses: { overheadIgp: Address; programId: Address },
  ) {
    super(chainName, multiProvider, addresses);

    this.overheadIgp = new PublicKey(addresses.overheadIgp);
  }

  async getAccountInfo(): Promise<SealevelOverheadIgpData> {
    const address = this.addresses.overheadIgp;
    const connection = this.getProvider();

    const accountInfo = await connection.getAccountInfo(new PublicKey(address));
    if (!accountInfo) throw new Error(`No account info found for ${address}}`);

    const accountData = deserializeUnchecked(
      SealevelOverheadIgpDataSchema,
      SealevelAccountDataWrapper,
      accountInfo.data,
    );
    return accountData.data as SealevelOverheadIgpData;
  }

  // Simulating a transaction requires a payer to have sufficient balance to pay for tx fees.
  override async quoteGasPayment(
    destination: Domain,
    gasAmount: bigint,
    payerKey: PublicKey,
  ): Promise<bigint> {
    const igpData = await this.getAccountInfo();
    return super.quoteGasPaymentForIgpAccounts(
      destination,
      gasAmount,
      payerKey,
      igpData.inner_pub_key,
      this.overheadIgp,
    );
  }
}
