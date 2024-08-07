import { ChildToParentMessageStatus } from '@arbitrum/sdk';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers.js';
import { BigNumber } from 'ethers';
import hre from 'hardhat';
import { before } from 'mocha';
import sinon from 'sinon';

import {
  ArbL2ToL1Hook,
  ArbL2ToL1Hook__factory,
  MockArbBridge,
  MockArbBridge__factory,
  MockArbSys__factory,
  TestRecipient,
} from '@hyperlane-xyz/core';
import { Address, WithAddress, objMap } from '@hyperlane-xyz/utils';
import { bytes32ToAddress } from '@hyperlane-xyz/utils';

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
import { ArbL2ToL1HookConfig, HookType } from '../../hook/types.js';
import { MultiProvider } from '../../providers/MultiProvider.js';
import { ChainMap, ChainName } from '../../types.js';
import { EvmIsmReader } from '../EvmIsmReader.js';
import { HyperlaneIsmFactory } from '../HyperlaneIsmFactory.js';
import { ArbL2ToL1IsmConfig } from '../types.js';

import { BaseMetadataBuilder, MetadataContext } from './builder.js';

const NUM_RUNS = 5;

describe('BaseMetadataBuilder', () => {
  const origin: ChainName = 'test1';
  const destination: ChainName = 'test2';
  let core: HyperlaneCore;
  let ismFactory: HyperlaneIsmFactory;
  let hookConfig: ChainMap<ArbL2ToL1HookConfig>;
  let arbL2ToL1Hook: ArbL2ToL1Hook;
  let arbBridge: MockArbBridge;
  let testRecipients: Record<ChainName, TestRecipient>;
  let proxyFactoryAddresses: HyperlaneAddresses<ProxyFactoryFactories>;
  let factoryContracts: HyperlaneContracts<ProxyFactoryFactories>;
  let relayer: SignerWithAddress;
  let metadataBuilder: BaseMetadataBuilder;
  let context: MetadataContext<
    WithAddress<ArbL2ToL1IsmConfig>,
    WithAddress<ArbL2ToL1HookConfig>
  >;

  before(async () => {
    [relayer] = await hre.ethers.getSigners();
    const multiProvider = MultiProvider.createTestMultiProvider({
      signer: relayer,
    });
    const ismFactoryDeployer = new HyperlaneProxyFactoryDeployer(multiProvider);
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

    const mockArbSys = await multiProvider.handleDeploy(
      origin,
      new MockArbSys__factory(),
      [],
    );
    hookConfig = {
      test1: {
        type: HookType.ARB_L2_TO_L1,
        arbSys: mockArbSys.address,
        destinationChain: destination,
        gasOverhead: 200_000,
      },
    };

    factoryContracts = contractsMap.test1;
    proxyFactoryAddresses = Object.keys(factoryContracts).reduce((acc, key) => {
      acc[key] =
        contractsMap[origin][key as keyof ProxyFactoryFactories].address;
      return acc;
    }, {} as Record<string, Address>) as HyperlaneAddresses<ProxyFactoryFactories>;
    arbBridge = await multiProvider.handleDeploy(
      origin,
      new MockArbBridge__factory(),
      [],
    );
    hookConfig.test1.arbBridge = arbBridge.address;

    const hookModule = await EvmHookModule.create({
      chain: origin,
      config: hookConfig.test1,
      proxyFactoryFactories: proxyFactoryAddresses,
      coreAddresses: core.getAddresses(origin),
      multiProvider,
    });
    const hookAddress = hookModule.serialize().deployedHook;

    arbL2ToL1Hook = ArbL2ToL1Hook__factory.connect(hookAddress, relayer);

    metadataBuilder = new BaseMetadataBuilder(core);

    sinon
      .stub(metadataBuilder.arbL2ToL1MetadataBuilder, 'getArbitrumBridgeStatus')
      .callsFake(async (): Promise<ChildToParentMessageStatus> => {
        return ChildToParentMessageStatus.CONFIRMED;
      });

    sinon
      .stub(metadataBuilder.arbL2ToL1MetadataBuilder, 'getArbitrumOutboxProof')
      .callsFake(async (): Promise<string[]> => {
        await arbBridge.setL2ToL1Sender(arbL2ToL1Hook.address);
        return [];
      });
  });

  describe('#build', () => {
    let metadata: string;

    beforeEach(async () => {
      const testRecipient = testRecipients[destination];
      const deployedIsmAddress = bytes32ToAddress(await arbL2ToL1Hook.ism());

      await testRecipient.setInterchainSecurityModule(deployedIsmAddress);
      const { dispatchTx, message } = await core.sendMessage(
        origin,
        destination,
        testRecipient.address,
        '0xdeadbeef',
        arbL2ToL1Hook.address,
      );

      const derivedIsm = await new EvmIsmReader(
        core.multiProvider,
        destination,
      ).deriveIsmConfig(deployedIsmAddress);

      context = {
        hook: { ...hookConfig[origin], address: arbL2ToL1Hook.address },
        ism: derivedIsm as WithAddress<ArbL2ToL1IsmConfig>,
        message,
        dispatchTx,
      };

      metadata = await metadataBuilder.build(context);
    });

    for (let i = 0; i < NUM_RUNS; i++) {
      it(`should build valid metadata using direct executeTransaction call (run #${i})`, async () => {
        await core
          .getContracts(destination)
          .mailbox.process(metadata, context.message.message);
      });

      it(`should build valid metadata if already preverified by 3rd party relayer (run #${i})`, async () => {
        const calldata =
          await metadataBuilder.arbL2ToL1MetadataBuilder.buildArbitrumBridgeCalldata(
            context,
          );
        await arbBridge.executeTransaction(
          calldata.proof,
          calldata.index,
          calldata.l2Sender,
          calldata.to,
          calldata.l2Block,
          calldata.l1Block,
          calldata.l2Timestamp,
          BigNumber.from(0),
          calldata.data,
        );
        metadata = await metadataBuilder.build(context);
        await core
          .getContracts(destination)
          .mailbox.process(metadata, context.message.message);
      });

      it(`should decode metadata (run #${i})`, async () => {
        BaseMetadataBuilder.decode(metadata, context);
      });
    }
  });
});
