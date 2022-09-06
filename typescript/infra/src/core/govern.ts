import { prompts } from 'prompts';

import {
  AbacusConnectionManagerViolation,
  AbacusConnectionManagerViolationType,
  AbacusCoreChecker,
  ChainMap,
  ChainName,
  ChainNameToDomainId,
  CoreViolationType,
  EnrolledInboxesViolation,
  EnrolledValidatorsViolation,
  OwnerViolation,
  ValidatorManagerViolation,
  ValidatorManagerViolationType,
  ViolationType,
  objMap,
} from '@abacus-network/sdk';
import { types, utils } from '@abacus-network/utils';

import { canProposeSafeTransactions } from '../utils/safe';

import {
  ManualMultiSend,
  MultiSend,
  SafeMultiSend,
  SignerMultiSend,
} from './multisend';

enum SubmissionType {
  MANUAL = 'MANUAL',
  SIGNER = 'SIGNER',
  SAFE = 'SAFE',
}

type AnnotatedCallData = types.CallData & {
  submissionType?: SubmissionType;
  description: string;
};

export class AbacusCoreGovernor<Chain extends ChainName> {
  readonly checker: AbacusCoreChecker<Chain>;
  private calls: ChainMap<Chain, AnnotatedCallData[]>;

  constructor(checker: AbacusCoreChecker<Chain>) {
    this.checker = checker;
    this.calls = objMap(this.checker.app.contractsMap, () => []);
  }

  async govern() {
    // 1. Produce calls from checker violations.
    await this.mapViolationsToCalls();

    // 2. For each call, infer how it should be submitted on-chain.
    await this.inferCallSubmissionTypes();

    // 3. Prompt the user to confirm that the count, description,
    // and submission methods look correct before submitting.
    for (const chain of Object.keys(this.calls) as Chain[]) {
      await this.sendCalls(chain);
    }
  }

  protected async sendCalls(chain: Chain) {
    const calls = this.calls[chain];
    console.log(`\nFound ${calls.length} transactions for ${chain}`);
    const filterCalls = (submissionType: SubmissionType) =>
      calls.filter((call) => call.submissionType == submissionType);
    const summarizeCalls = async (
      submissionType: SubmissionType,
      calls: AnnotatedCallData[],
    ): Promise<boolean> => {
      if (calls.length > 0) {
        console.log(
          `> ${calls.length} calls will be submitted via ${submissionType}`,
        );
        calls.map((c) => console.log(`> > ${c.description}`));
        const response = await prompts.confirm({
          type: 'confirm',
          name: 'value',
          message: 'Can you confirm?',
          initial: false,
        });
        return response as unknown as boolean;
      }
      return false;
    };

    const sendCallsForType = async (
      submissionType: SubmissionType,
      multiSend: MultiSend,
    ) => {
      const calls = filterCalls(submissionType);
      if (calls.length > 0) {
        const confirmed = await summarizeCalls(submissionType, calls);
        if (confirmed) {
          console.log(`Submitting calls on ${chain} via ${submissionType}`);
          await multiSend.sendTransactions(calls);
        } else {
          console.log(
            `Skipping submission of calls on ${chain} via ${submissionType}`,
          );
        }
      }
    };

    const connection = this.checker.multiProvider.getChainConnection(chain);

    await sendCallsForType(
      SubmissionType.SIGNER,
      new SignerMultiSend(connection),
    );
    const owner = this.checker.configMap[chain!].owner!;
    await sendCallsForType(
      SubmissionType.SAFE,
      new SafeMultiSend(connection, chain, owner),
    );
    await sendCallsForType(SubmissionType.MANUAL, new ManualMultiSend(chain));
  }

  protected pushCall(chain: Chain, call: AnnotatedCallData) {
    this.calls[chain].push(call);
  }

  protected async mapViolationsToCalls() {
    for (const violation of this.checker.violations) {
      switch (violation.type) {
        case CoreViolationType.ValidatorManager: {
          this.handleValidatorManagerViolation(
            violation as ValidatorManagerViolation,
          );
          break;
        }
        case ViolationType.Owner: {
          this.handleOwnerViolation(violation as OwnerViolation);
          break;
        }
        case CoreViolationType.AbacusConnectionManager: {
          this.handleAbacusConnectionManagerViolation(
            violation as AbacusConnectionManagerViolation,
          );
          break;
        }
        default:
          throw new Error(`Unsupported violation type ${violation.type}`);
      }
    }
  }

  protected async inferCallSubmissionTypes() {
    for (const chain of Object.keys(this.calls) as Chain[]) {
      for (const call of this.calls[chain]) {
        const submissionType = await this.inferCallSubmissionType(chain, call);
        call.submissionType = submissionType;
      }
    }
  }

  protected async inferCallSubmissionType(
    chain: Chain,
    call: AnnotatedCallData,
  ): Promise<SubmissionType> {
    const connection = this.checker.multiProvider.getChainConnection(chain);
    // 1. Check if the call will succeed with the default signer.
    try {
      await connection.estimateGas(call);
      return SubmissionType.SIGNER;
    } catch (_) {} // eslint-disable-line no-empty

    try {
      // 2. Check if the call will succeed via Gnosis Safe.

      // 2a. Check if calling from the owner will succeed.
      const safeAddress = this.checker.configMap[chain!].owner;
      if (!safeAddress) throw new Error(`Safe address not found for ${chain}`);
      await connection.provider.estimateGas({
        ...call,
        from: safeAddress,
      });

      // 2b. Confirm that the signer is a Safe owner or delegate.
      // This should implicitly check whether or not the owner is a gnosis
      // safe.
      const signer = connection.signer;
      if (!signer) throw new Error(`no signer found`);
      const signerAddress = await signer.getAddress();
      const proposer = await canProposeSafeTransactions(
        signerAddress,
        chain,
        connection,
        safeAddress,
      );
      if (!proposer)
        throw new Error(
          `${signerAddress} is not an owner or delegate for Safe ${safeAddress}`,
        );
      return SubmissionType.SAFE;
    } catch (_) {} // eslint-disable-line no-empty

    return SubmissionType.MANUAL;
  }

  // pushes calls which reconcile actual and expected sets on chain
  protected pushSetReconcilationCalls<T>(reconcile: {
    chain: ChainName;
    actual: Set<T>;
    expected: Set<T>;
    add: (elem: T) => AnnotatedCallData;
    remove: (elem: T) => AnnotatedCallData;
  }) {
    // add expected - actual elements
    utils
      .difference(reconcile.expected, reconcile.actual)
      .forEach((elem) =>
        this.pushCall(reconcile.chain as Chain, reconcile.add(elem)),
      );

    // remote actual - expected elements
    utils
      .difference(reconcile.actual, reconcile.expected)
      .forEach((elem) =>
        this.pushCall(reconcile.chain as Chain, reconcile.remove(elem)),
      );
  }

  handleAbacusConnectionManagerViolation(
    violation: AbacusConnectionManagerViolation,
  ) {
    const abacusConnectionManager = violation.contract;
    switch (violation.abacusConnectionManagerType) {
      case AbacusConnectionManagerViolationType.EnrolledInboxes: {
        const typedViolation = violation as EnrolledInboxesViolation;
        const remoteId = ChainNameToDomainId[typedViolation.remote];
        const baseDescription = `as ${typedViolation.remote} Inbox on ${typedViolation.chain}`;
        this.pushSetReconcilationCalls({
          ...typedViolation,
          add: (inbox) => ({
            to: abacusConnectionManager.address,
            data: abacusConnectionManager.interface.encodeFunctionData(
              'enrollInbox',
              [remoteId, inbox],
            ),
            description: `Enroll ${inbox} ${baseDescription}`,
          }),
          remove: (inbox) => ({
            to: abacusConnectionManager.address,
            data: abacusConnectionManager.interface.encodeFunctionData(
              'unenrollInbox',
              [inbox],
            ),
            description: `Unenroll ${inbox} ${baseDescription}`,
          }),
        });
        break;
      }
      default:
        throw new Error(
          `Unsupported abacus connection manager violation type ${violation.abacusConnectionManagerType}`,
        );
    }
  }

  handleValidatorManagerViolation(violation: ValidatorManagerViolation) {
    const validatorManager = violation.contract;
    switch (violation.validatorManagerType) {
      case ValidatorManagerViolationType.EnrolledValidators: {
        const baseDescription = `as ${violation.remote} validator on ${violation.chain}`;
        this.pushSetReconcilationCalls({
          ...(violation as EnrolledValidatorsViolation),
          add: (validator) => ({
            to: validatorManager.address,
            data: validatorManager.interface.encodeFunctionData(
              'enrollValidator',
              [validator],
            ),
            description: `Enroll ${validator} ${baseDescription}`,
          }),
          remove: (validator) => ({
            to: validatorManager.address,
            data: validatorManager.interface.encodeFunctionData(
              'unenrollValidator',
              [validator],
            ),
            description: `Unenroll ${validator} ${baseDescription}`,
          }),
        });
        break;
      }
      case ValidatorManagerViolationType.Threshold: {
        this.pushCall(violation.chain as Chain, {
          to: validatorManager.address,
          data: validatorManager.interface.encodeFunctionData('setThreshold', [
            violation.expected,
          ]),
          description: `Set threshold to ${violation.expected} for ${violation.remote} on ${violation.chain}`,
        });
        break;
      }
      default:
        throw new Error(
          `Unsupported validator manager violation type ${violation.validatorManagerType}`,
        );
    }
  }

  handleOwnerViolation(violation: OwnerViolation) {
    this.pushCall(violation.chain as Chain, {
      to: violation.contract.address,
      data: violation.contract.interface.encodeFunctionData(
        'transferOwnership',
        [violation.expected],
      ),
      description: `Transfer ownership of ${violation.contract.address} to ${violation.expected}`,
    });
  }
}
