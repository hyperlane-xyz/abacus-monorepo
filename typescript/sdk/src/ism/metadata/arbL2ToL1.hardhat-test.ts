import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers.js';
import hre from 'hardhat';
import { before } from 'mocha';
import sinon from 'sinon';

import {
  MerkleTreeHook,
  MerkleTreeHook__factory,
  MockArbBridge__factory,
  TestRecipient,
} from '@hyperlane-xyz/core';
import {
  Address,
  BaseValidator,
  Checkpoint,
  CheckpointWithId,
  Domain,
  S3CheckpointWithId,
  addressToBytes32,
  eqAddress,
  objMap,
  randomElement,
} from '@hyperlane-xyz/utils';

import { testChains } from '../../consts/testChains.js';
import {
  HyperlaneAddresses,
  HyperlaneContracts,
} from '../../contracts/types.js';
import { HyperlaneCore } from '../../core/HyperlaneCore.js';
import { TestCoreDeployer } from '../../core/TestCoreDeployer.js';
import { TestRecipientDeployer } from '../../core/TestRecipientDeployer.js';
import { HyperlaneProxyFactoryDeployer } from '../../deploy/HyperlaneProxyFactoryDeployer.js';
import { ProxyFactoryFactories } from '../../deploy/contracts.js';
import { EvmHookModule } from '../../hook/EvmHookModule.js';
import {
  ArbL2ToL1HookConfig,
  HookType,
  MerkleTreeHookConfig,
} from '../../hook/types.js';
import { MultiProvider } from '../../providers/MultiProvider.js';
import { randomAddress } from '../../test/testUtils.js';
import { ChainMap, ChainName } from '../../types.js';
import { EvmIsmReader } from '../EvmIsmReader.js';
import { randomIsmConfig } from '../HyperlaneIsmFactory.hardhat-test.js';
import { HyperlaneIsmFactory } from '../HyperlaneIsmFactory.js';

import { BaseMetadataBuilder, MetadataContext } from './builder.js';

const MAX_ISM_DEPTH = 5;
const MAX_NUM_VALIDATORS = 5;
const NUM_RUNS = 5;

describe('BaseMetadataBuilder', () => {
  let core: HyperlaneCore;
  let ismFactory: HyperlaneIsmFactory;
  const merkleHooks: Record<Domain, MerkleTreeHook> = {};
  let testRecipients: Record<ChainName, TestRecipient>;
  let proxyFactoryAddresses: HyperlaneAddresses<ProxyFactoryFactories>;
  let factoryContracts: HyperlaneContracts<ProxyFactoryFactories>;
  let relayer: SignerWithAddress;
  let validators: SignerWithAddress[];
  let metadataBuilder: BaseMetadataBuilder;

  before(async () => {
    [relayer, ...validators] = await hre.ethers.getSigners();
    const multiProvider = MultiProvider.createTestMultiProvider({
      signer: relayer,
    });
    const ismFactoryDeployer = new HyperlaneProxyFactoryDeployer(multiProvider);
    // const origin = 'test1';
    // const remote = 'test2';
    const contractsMap = await ismFactoryDeployer.deploy(
      multiProvider.mapKnownChains(() => ({})),
    );
    ismFactory = new HyperlaneIsmFactory(contractsMap, multiProvider);
    const coreDeployer = new TestCoreDeployer(multiProvider, ismFactory);
    const recipientDeployer = new TestRecipientDeployer(multiProvider);
    testRecipients = objMap(
      await recipientDeployer.deploy(
        Object.fromEntries(testChains.map((c) => [c, {}])),
      ),
      (_, { testRecipient }) => testRecipient,
    );
    core = await coreDeployer.deployApp();
    console.log('core config', Object.keys(core.chainMap));
    const hookConfig: ChainMap<ArbL2ToL1HookConfig> = {
      test1: {
        type: HookType.ARB_L2_TO_L1,
        arbSys: randomAddress(),
        destinationChain: randomElement(testChains),
        gasOverhead: 200_000,
      },
    };

    factoryContracts = contractsMap.test1;
    proxyFactoryAddresses = Object.keys(factoryContracts).reduce((acc, key) => {
      acc[key] =
        contractsMap[origin][key as keyof ProxyFactoryFactories].address;
      return acc;
    }, {} as Record<string, Address>) as HyperlaneAddresses<ProxyFactoryFactories>;
    const bridge = await multiProvider.handleDeploy(
      origin,
      new MockArbBridge__factory(),
      [],
    );
    hookConfig.test1.arbBridge = bridge.address;

    const hookModule = await EvmHookModule.create({
      chain: origin,
      config: hookConfig.test1,
      proxyFactoryFactories: proxyFactoryAddresses,
      coreAddresses: core.getAddresses(origin),
      multiProvider,
    });
    const hookAddress = hookModule.serialize().deployedHook;
    console.log('CHEESESLICE1:', hookAddress);

    return;

    metadataBuilder = new BaseMetadataBuilder(core);

    sinon
      .stub(metadataBuilder.multisigMetadataBuilder, 'getS3Checkpoints')
      .callsFake(
        async (multisigAddresses, match): Promise<S3CheckpointWithId[]> => {
          const merkleHook = merkleHooks[match.origin];
          const checkpoint: Checkpoint = {
            root: await merkleHook.root(),
            merkle_tree_hook_address: addressToBytes32(merkleHook.address),
            index: match.index,
            mailbox_domain: match.origin,
          };
          const checkpointWithId: CheckpointWithId = {
            checkpoint,
            message_id: match.messageId,
          };
          const digest = BaseValidator.messageHash(checkpoint, match.messageId);
          const checkpoints: S3CheckpointWithId[] = [];
          for (const validator of multisigAddresses) {
            const signature = await validators
              .find((s) => eqAddress(s.address, validator))!
              .signMessage(digest);
            checkpoints.push({ value: checkpointWithId, signature });
          }
          return checkpoints;
        },
      );
  });

  describe('#build', () => {
    let origin: ChainName;
    let destination: ChainName;
    let context: MetadataContext;
    let metadata: string;

    beforeEach(async () => {
      return;
      origin = randomElement(testChains);
      destination = randomElement(testChains.filter((c) => c !== origin));
      const testRecipient = testRecipients[destination];

      const addresses = validators
        .map((s) => s.address)
        .slice(0, MAX_NUM_VALIDATORS);
      const config = randomIsmConfig(MAX_ISM_DEPTH, addresses, relayer.address);
      console.log('CHEESECAKE3', JSON.stringify(config, null, 2));
      const deployedIsm = await ismFactory.deploy({
        destination,
        config,
        mailbox: core.getAddresses(destination).mailbox,
      });
      // const deployedIsm =
      await testRecipient.setInterchainSecurityModule(deployedIsm.address);

      const merkleHookAddress =
        merkleHooks[core.multiProvider.getDomainId(origin)].address;
      const { dispatchTx, message } = await core.sendMessage(
        origin,
        destination,
        testRecipient.address,
        '0xdeadbeef',
        merkleHookAddress,
      );

      const derivedIsm = await new EvmIsmReader(
        core.multiProvider,
        destination,
      ).deriveIsmConfig(deployedIsm.address);

      context = {
        hook: {
          type: HookType.MERKLE_TREE,
          address: merkleHookAddress,
        },
        ism: derivedIsm,
        message,
        dispatchTx,
      };

      metadata = await metadataBuilder.build(context, MAX_ISM_DEPTH);
    });

    for (let i = 0; i < NUM_RUNS; i++) {
      it(`should build valid metadata for random ism config (${i})`, async () => {
        // must call process for trusted relayer to be able to verify'
        return;
        await core
          .getContracts(destination)
          .mailbox.process(metadata, context.message.message);
      });

      // it(`should decode metadata for random ism config (${i})`, async () => {
      //   BaseMetadataBuilder.decode(metadata, context);
      // });
    }
  });
});
