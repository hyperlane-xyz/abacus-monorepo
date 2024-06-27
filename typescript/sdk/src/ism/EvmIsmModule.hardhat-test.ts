/* eslint-disable no-console */
import assert from 'assert';
import { expect } from 'chai';
import { Signer } from 'ethers';
import hre from 'hardhat';

import { FallbackDomainRoutingHook__factory } from '@hyperlane-xyz/core';
import { Address, eqAddress, normalizeConfig } from '@hyperlane-xyz/utils';

import { TestChainName, test4, testChains } from '../consts/testChains.js';
import { HyperlaneAddresses, HyperlaneContracts } from '../contracts/types.js';
import { TestCoreDeployer } from '../core/TestCoreDeployer.js';
import { HyperlaneProxyFactoryDeployer } from '../deploy/HyperlaneProxyFactoryDeployer.js';
import { ProxyFactoryFactories } from '../deploy/contracts.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { randomAddress, randomInt } from '../test/testUtils.js';

import { EvmIsmModule } from './EvmIsmModule.js';
import { HyperlaneIsmFactory } from './HyperlaneIsmFactory.js';
import {
  AggregationIsmConfig,
  IsmConfig,
  IsmType,
  ModuleType,
  MultisigIsmConfig,
  RoutingIsmConfig,
  TrustedRelayerIsmConfig,
} from './types.js';

const randomMultisigIsmConfig = (m: number, n: number): MultisigIsmConfig => {
  const emptyArray = new Array<number>(n).fill(0);
  const validators = emptyArray.map(() => randomAddress());
  return {
    type: IsmType.MERKLE_ROOT_MULTISIG,
    validators,
    threshold: m,
  };
};

function randomModuleType(): ModuleType {
  const choices = [
    ModuleType.AGGREGATION,
    ModuleType.MERKLE_ROOT_MULTISIG,
    ModuleType.ROUTING,
    ModuleType.NULL,
  ];
  return choices[randomInt(choices.length)];
}

const randomIsmConfig = (depth = 0, maxDepth = 2): IsmConfig => {
  const moduleType =
    depth == maxDepth ? ModuleType.MERKLE_ROOT_MULTISIG : randomModuleType();
  switch (moduleType) {
    case ModuleType.MERKLE_ROOT_MULTISIG: {
      const n = randomInt(5, 1);
      return randomMultisigIsmConfig(randomInt(n, 1), n);
    }
    case ModuleType.ROUTING: {
      const config: RoutingIsmConfig = {
        type: IsmType.ROUTING,
        owner: randomAddress(),
        domains: Object.fromEntries(
          testChains.map((c) => [c, randomIsmConfig(depth + 1)]),
        ),
      };
      return config;
    }
    case ModuleType.AGGREGATION: {
      const n = randomInt(5, 1);
      const modules = new Array<number>(n)
        .fill(0)
        .map(() => randomIsmConfig(depth + 1));
      const config: AggregationIsmConfig = {
        type: IsmType.AGGREGATION,
        threshold: randomInt(n, 1),
        modules,
      };
      return config;
    }
    case ModuleType.NULL: {
      const config: TrustedRelayerIsmConfig = {
        type: IsmType.TRUSTED_RELAYER,
        relayer: randomAddress(),
      };
      return config;
    }
    default:
      throw new Error(`Unsupported ISM type: ${moduleType}`);
  }
};

describe('EvmIsmModule', async () => {
  let multiProvider: MultiProvider;
  let exampleRoutingConfig: RoutingIsmConfig;
  let mailboxAddress: Address;
  let newMailboxAddress: Address;
  let fundingAccount: Signer;

  const chain = 'test4';
  let factoryAddresses: HyperlaneAddresses<ProxyFactoryFactories>;
  let factoryContracts: HyperlaneContracts<ProxyFactoryFactories>;

  beforeEach(async () => {
    const [signer, funder] = await hre.ethers.getSigners();
    fundingAccount = funder;
    multiProvider = MultiProvider.createTestMultiProvider({ signer });
    multiProvider.addChain(test4);

    const contractsMap = await new HyperlaneProxyFactoryDeployer(
      multiProvider,
    ).deploy(multiProvider.mapKnownChains(() => ({})));

    // get addresses of factories for the chain
    factoryContracts = contractsMap[chain];
    factoryAddresses = Object.keys(factoryContracts).reduce((acc, key) => {
      acc[key] =
        contractsMap[chain][key as keyof ProxyFactoryFactories].address;
      return acc;
    }, {} as Record<string, Address>) as HyperlaneAddresses<ProxyFactoryFactories>;

    // legacy HyperlaneIsmFactory is required to do a core deploy
    const legacyIsmFactory = new HyperlaneIsmFactory(
      contractsMap,
      multiProvider,
    );

    // mailbox
    mailboxAddress = (
      await new TestCoreDeployer(multiProvider, legacyIsmFactory).deployApp()
    ).getContracts(chain).mailbox.address;

    // new mailbox
    newMailboxAddress = (
      await new TestCoreDeployer(multiProvider, legacyIsmFactory).deployApp()
    ).getContracts(chain).mailbox.address;

    // example routing config
    exampleRoutingConfig = {
      type: IsmType.ROUTING,
      owner: await multiProvider.getSignerAddress(chain),
      domains: Object.fromEntries(
        testChains.map((c) => [c, randomMultisigIsmConfig(3, 5)]),
      ),
    };
  });

  // Helper method for create a new multiprovider with an impersonated account
  async function impersonateAccount(account: Address): Promise<MultiProvider> {
    await hre.ethers.provider.send('hardhat_impersonateAccount', [account]);
    await fundingAccount.sendTransaction({
      to: account,
      value: hre.ethers.utils.parseEther('1.0'),
    });
    const multiProvider = MultiProvider.createTestMultiProvider({
      signer: hre.ethers.provider.getSigner(account),
    });
    multiProvider.addChain(test4);
    return multiProvider;
  }

  // Helper method to expect exactly N updates to be applied
  async function expectTxsAndUpdate(
    ism: EvmIsmModule,
    config: IsmConfig,
    n: number,
  ) {
    const txs = await ism.update(config);
    expect(txs.length).to.equal(n);

    for (const tx of txs) {
      await multiProvider.sendTransaction(chain, tx);
    }
  }

  // ism module and config for testing
  let testIsm: EvmIsmModule;
  let testConfig: IsmConfig;

  // expect that the ISM matches the config after all tests
  afterEach(async () => {
    const normalizedDerivedConfig = normalizeConfig(await testIsm.read());
    const normalizedConfig = normalizeConfig(testConfig);
    assert.deepStrictEqual(normalizedDerivedConfig, normalizedConfig);
  });

  // create a new ISM and verify that it matches the config
  async function createIsm(
    config: IsmConfig,
  ): Promise<{ ism: EvmIsmModule; initialIsmAddress: Address }> {
    const ism = await EvmIsmModule.create({
      chain,
      config,
      proxyFactoryFactories: factoryAddresses,
      mailbox: mailboxAddress,
      multiProvider,
    });
    testIsm = ism;
    testConfig = config;
    return { ism, initialIsmAddress: ism.serialize().deployedIsm };
  }

  describe('create', async () => {
    it('deploys a simple ism', async () => {
      const config = randomMultisigIsmConfig(3, 5);
      await createIsm(config);
    });

    it('deploys a trusted relayer ism', async () => {
      const relayer = randomAddress();
      const config: TrustedRelayerIsmConfig = {
        type: IsmType.TRUSTED_RELAYER,
        relayer,
      };
      await createIsm(config);
    });

    for (const type of [IsmType.ROUTING, IsmType.FALLBACK_ROUTING]) {
      it(`deploys ${type} routingIsm with correct routes`, async () => {
        exampleRoutingConfig.type = type as
          | IsmType.ROUTING
          | IsmType.FALLBACK_ROUTING;
        await createIsm(exampleRoutingConfig);
      });
    }

    for (let i = 0; i < 16; i++) {
      it(`deploys a random ism config #${i}`, async () => {
        const config = randomIsmConfig();
        await createIsm(config);
      });
    }
  });

  describe('update', async () => {
    for (const type of [IsmType.ROUTING, IsmType.FALLBACK_ROUTING]) {
      beforeEach(() => {
        exampleRoutingConfig.type = type as
          | IsmType.ROUTING
          | IsmType.FALLBACK_ROUTING;
      });

      it(`should skip deployment with warning if no chain metadata configured ${type}`, async () => {
        // create a new ISM
        const { ism } = await createIsm(exampleRoutingConfig);

        // add config for a domain the multiprovider doesn't have
        exampleRoutingConfig.domains['test5'] = {
          type: IsmType.MESSAGE_ID_MULTISIG,
          threshold: 1,
          validators: [randomAddress()],
        };

        // expect 0 txs, as adding test5 domain is no-op
        await expectTxsAndUpdate(ism, exampleRoutingConfig, 0);
      });

      it(`update route in an existing ${type}`, async () => {
        // create a new ISM
        const { ism, initialIsmAddress } = await createIsm(
          exampleRoutingConfig,
        );

        // changing the type of a domain should enroll the domain
        (
          exampleRoutingConfig.domains[TestChainName.test2] as MultisigIsmConfig
        ).type = IsmType.MESSAGE_ID_MULTISIG;

        // expect 1 tx to enroll test2 domain
        await expectTxsAndUpdate(ism, exampleRoutingConfig, 1);

        // check that the ISM address is the same
        expect(eqAddress(initialIsmAddress, ism.serialize().deployedIsm)).to.be
          .true;
      });

      it(`deletes route in an existing ${type}`, async () => {
        // create a new ISM
        const { ism, initialIsmAddress } = await createIsm(
          exampleRoutingConfig,
        );

        // deleting the domain should unenroll the domain
        delete exampleRoutingConfig.domains[TestChainName.test3];

        // expect 1 tx to unenroll test3 domain
        await expectTxsAndUpdate(ism, exampleRoutingConfig, 1);

        // expect the ISM address to be the same
        expect(eqAddress(initialIsmAddress, ism.serialize().deployedIsm)).to.be
          .true;
      });

      it(`deletes route in an existing ${type} even if not in multiprovider`, async () => {
        // create a new ISM
        const { ism } = await createIsm(exampleRoutingConfig);

        // keep track of the domains before deleting
        const numDomainsBefore = Object.keys(
          ((await ism.read()) as RoutingIsmConfig).domains,
        ).length;

        // deleting the domain and removing from multiprovider should unenroll the domain
        delete exampleRoutingConfig.domains[TestChainName.test3];
        multiProvider = multiProvider.intersect(
          // remove test3 from multiprovider
          testChains.filter((c) => c !== TestChainName.test3),
        ).result;

        // expect 1 tx to unenroll test3 domain
        await expectTxsAndUpdate(ism, exampleRoutingConfig, 1);

        // domains should have decreased by 1
        const numDomainsAfter = Object.keys(
          ((await ism.read()) as RoutingIsmConfig).domains,
        ).length;
        console.log(numDomainsBefore, numDomainsAfter);
        expect(numDomainsBefore - 1).to.equal(numDomainsAfter);
      });

      it(`updates owner in an existing ${type}`, async () => {
        // create a new ISM
        const { ism, initialIsmAddress } = await createIsm(
          exampleRoutingConfig,
        );

        // change the config owner
        exampleRoutingConfig.owner = randomAddress();

        // expect 1 tx to transfer ownership
        await expectTxsAndUpdate(ism, exampleRoutingConfig, 1);

        // expect the ISM address to be the same
        expect(eqAddress(initialIsmAddress, ism.serialize().deployedIsm)).to.be
          .true;
      });

      it(`no changes to an existing ${type} means no redeployment or updates`, async () => {
        // create a new ISM
        const { ism, initialIsmAddress } = await createIsm(
          exampleRoutingConfig,
        );

        // expect 0 updates
        await expectTxsAndUpdate(ism, exampleRoutingConfig, 0);

        // expect the ISM address to be the same
        expect(eqAddress(initialIsmAddress, ism.serialize().deployedIsm)).to.be
          .true;
      });

      it(`update owner in an existing ${type} not owned by deployer`, async () => {
        // ISM owner is not the deployer
        exampleRoutingConfig.owner = randomAddress();
        const originalOwner = exampleRoutingConfig.owner;

        // create a new ISM
        const { ism, initialIsmAddress } = await createIsm(
          exampleRoutingConfig,
        );

        // update the config owner and impersonate the original owner
        exampleRoutingConfig.owner = randomAddress();
        multiProvider = await impersonateAccount(originalOwner);

        // expect 1 tx to transfer ownership
        await expectTxsAndUpdate(ism, exampleRoutingConfig, 1);

        // expect the ISM address to be unchanged
        expect(eqAddress(initialIsmAddress, ism.serialize().deployedIsm)).to.be
          .true;
      });

      it(`update validators in an existing ${type}`, async () => {
        // create a new ISM
        const { ism, initialIsmAddress } = await createIsm(
          exampleRoutingConfig,
        );

        // update the validators for a domain
        (
          exampleRoutingConfig.domains[TestChainName.test2] as MultisigIsmConfig
        ).validators = [randomAddress(), randomAddress()];

        // expect 1 tx to update validator set for test2 domain
        await expectTxsAndUpdate(ism, exampleRoutingConfig, 1);

        // expect the ISM address to be the same
        expect(eqAddress(initialIsmAddress, ism.serialize().deployedIsm)).to.be
          .true;
      });

      it(`update threshold in an existing ${type}`, async () => {
        // create a new ISM
        const { ism, initialIsmAddress } = await createIsm(
          exampleRoutingConfig,
        );

        // update the threshold for a domain
        (
          exampleRoutingConfig.domains[TestChainName.test2] as MultisigIsmConfig
        ).threshold = 2;

        // expect 1 tx to update threshold for test2 domain
        await expectTxsAndUpdate(ism, exampleRoutingConfig, 1);

        // expect the ISM address to be the same
        expect(eqAddress(initialIsmAddress, ism.serialize().deployedIsm)).to.be
          .true;
      });
    }

    it(`redeploy same config if the mailbox address changes for defaultFallbackRoutingIsm`, async () => {
      exampleRoutingConfig.type = IsmType.FALLBACK_ROUTING;

      // create a new ISM
      const { ism, initialIsmAddress } = await createIsm(exampleRoutingConfig);

      // point to new mailbox
      ism.setNewMailbox(newMailboxAddress);

      // expect a new ISM to be deployed, so no in-place updates to return
      await expectTxsAndUpdate(ism, exampleRoutingConfig, 0);

      // expect the ISM address to be different
      expect(eqAddress(initialIsmAddress, ism.serialize().deployedIsm)).to.be
        .false;

      // expect that the ISM is configured with the new mailbox
      const onchainIsm = FallbackDomainRoutingHook__factory.connect(
        ism.serialize().deployedIsm,
        multiProvider.getSigner(chain),
      );
      const onchainMailbox = await onchainIsm['mailbox()']();
      expect(eqAddress(onchainMailbox, newMailboxAddress)).to.be.true;
    });
  });
});
