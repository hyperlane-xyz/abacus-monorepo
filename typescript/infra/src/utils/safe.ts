import { JsonRpcSigner } from '@ethersproject/providers';
import SafeApiKit from '@safe-global/api-kit';
import Safe from '@safe-global/protocol-kit';
import {
  MetaTransactionData,
  SafeTransaction,
} from '@safe-global/safe-core-sdk-types';
import { ethers } from 'ethers';

import {
  ChainNameOrId,
  MultiProvider,
  getSafe,
  getSafeService,
} from '@hyperlane-xyz/sdk';
import { Address, CallData } from '@hyperlane-xyz/utils';

export async function getSafeAndService(
  chain: ChainNameOrId,
  multiProvider: MultiProvider,
  safeAddress: Address,
) {
  const safeSdk: Safe.default = await getSafe(
    chain,
    multiProvider,
    safeAddress,
  );
  const safeService: SafeApiKit.default = getSafeService(chain, multiProvider);
  return { safeSdk, safeService };
}

export function createSafeTransactionData(call: CallData): MetaTransactionData {
  return {
    to: call.to,
    data: call.data.toString(),
    value: call.value?.toString() || '0',
  };
}

export async function createSafeTransaction(
  safeSdk: Safe.default,
  safeService: SafeApiKit.default,
  safeAddress: Address,
  safeTransactionData: MetaTransactionData[],
  onlyCalls?: boolean,
): Promise<SafeTransaction> {
  const nextNonce = await safeService.getNextNonce(safeAddress);
  return safeSdk.createTransaction({
    safeTransactionData,
    onlyCalls,
    options: { nonce: nextNonce },
  });
}

export async function proposeSafeTransaction(
  chain: ChainNameOrId,
  safeSdk: Safe.default,
  safeService: SafeApiKit.default,
  safeTransaction: SafeTransaction,
  safeAddress: Address,
  signer: ethers.Signer,
): Promise<void> {
  const safeTxHash = await safeSdk.getTransactionHash(safeTransaction);
  const senderSignature = await safeSdk.signTransactionHash(safeTxHash);
  const senderAddress = await signer.getAddress();

  await safeService.proposeTransaction({
    safeAddress: safeAddress,
    safeTransactionData: safeTransaction.data,
    safeTxHash,
    senderAddress,
    senderSignature: senderSignature.data,
  });

  console.log(`Proposed transaction on ${chain} with hash ${safeTxHash}`);
}

export async function deleteAllPendingSafeTxs(
  chain: ChainNameOrId,
  multiProvider: MultiProvider,
  safeAddress: Address,
): Promise<void> {
  const txServiceUrl =
    multiProvider.getChainMetadata(chain).gnosisSafeTransactionServiceUrl;

  // Fetch all pending transactions
  const pendingTxsUrl = `${txServiceUrl}/api/v1/safes/${safeAddress}/multisig-transactions/?executed=false&limit=100`;
  const pendingTxsResponse = await fetch(pendingTxsUrl, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
  });

  if (!pendingTxsResponse.ok) {
    console.error(`Failed to fetch pending transactions for ${safeAddress}`);
    return;
  }

  const pendingTxs = await pendingTxsResponse.json();

  // Delete each pending transaction
  for (const tx of pendingTxs.results) {
    await deleteSafeTx(chain, multiProvider, safeAddress, tx.safeTxHash);
  }

  console.log(
    `Deleted all pending transactions on ${chain} for ${safeAddress}\n`,
  );
}

export async function deleteSafeTx(
  chain: ChainNameOrId,
  multiProvider: MultiProvider,
  safeAddress: Address,
  safeTxHash: string,
): Promise<void> {
  const signer = multiProvider.getSigner(chain);
  const domainId = multiProvider.getDomainId(chain);
  const txServiceUrl =
    multiProvider.getChainMetadata(chain).gnosisSafeTransactionServiceUrl;

  // Fetch the transaction details to get the proposer
  const txDetailsUrl = `${txServiceUrl}/api/v1/multisig-transactions/${safeTxHash}/`;
  const txDetailsResponse = await fetch(txDetailsUrl, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
  });

  if (!txDetailsResponse.ok) {
    console.error(`Failed to fetch transaction details for ${safeTxHash}`);
    return;
  }

  const txDetails = await txDetailsResponse.json();
  const proposer = txDetails.proposer;

  if (!proposer) {
    console.error(`No proposer found for transaction ${safeTxHash}`);
    return;
  }

  // Compare proposer to signer
  const signerAddress = await signer.getAddress();
  if (proposer !== signerAddress) {
    console.log(
      `Skipping deletion of transaction ${safeTxHash} proposed by ${proposer}`,
    );
    return;
  }
  console.log(`Deleting transaction ${safeTxHash} proposed by ${proposer}`);

  try {
    // Generate the EIP-712 signature
    const totp = Math.floor(Date.now() / 1000 / 3600);
    const typedData = {
      types: {
        EIP712Domain: [
          { name: 'name', type: 'string' },
          { name: 'version', type: 'string' },
          { name: 'chainId', type: 'uint256' },
          { name: 'verifyingContract', type: 'address' },
        ],
        DeleteRequest: [
          { name: 'safeTxHash', type: 'bytes32' },
          { name: 'totp', type: 'uint256' },
        ],
      },
      domain: {
        name: 'Safe Transaction Service',
        version: '1.0',
        chainId: domainId,
        verifyingContract: safeAddress,
      },
      primaryType: 'DeleteRequest',
      message: {
        safeTxHash: safeTxHash,
        totp: totp,
      },
    };

    const signature = await (signer as JsonRpcSigner)._signTypedData(
      typedData.domain,
      { DeleteRequest: typedData.types.DeleteRequest },
      typedData.message,
    );

    // Make the API call to delete the transaction
    const deleteUrl = `${txServiceUrl}/api/v1/multisig-transactions/${safeTxHash}/`;
    const res = await fetch(deleteUrl, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ safeTxHash: safeTxHash, signature: signature }),
    });

    if (res.status === 204) {
      console.log(`Successfully deleted transaction ${safeTxHash} on ${chain}`);
      return;
    }

    const errorBody = await res.text();
    console.error(
      `Failed to delete transaction ${safeTxHash} on ${chain}: Status ${res.status} ${res.statusText}. Response body: ${errorBody}`,
    );
  } catch (error) {
    console.error(
      `Failed to delete transaction ${safeTxHash} on ${chain}:`,
      error,
    );
  }
}
