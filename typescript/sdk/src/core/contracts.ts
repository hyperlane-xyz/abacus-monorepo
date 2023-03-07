import {
  Create2Factory__factory,
  InterchainAccountRouter__factory,
  InterchainQueryRouter__factory,
  Mailbox,
  Mailbox__factory,
  MultisigIsm,
  MultisigIsm__factory,
  ProxyAdmin,
  ProxyAdmin__factory,
  ValidatorAnnounce,
  ValidatorAnnounce__factory,
} from '@hyperlane-xyz/core';
import { types } from '@hyperlane-xyz/utils';

import { ProxiedContract, TransparentProxyAddresses } from '../proxy';

export type CoreContracts = {
  mailbox: ProxiedContract<Mailbox, TransparentProxyAddresses>;
  multisigIsm: MultisigIsm;
  proxyAdmin: ProxyAdmin;
  validatorAnnounce: ValidatorAnnounce;
};

export type CoreAddresses = {
  mailbox: types.Address | TransparentProxyAddresses;
  multisigIsm: types.Address;
  proxyAdmin?: types.Address;
  validatorAnnounce: types.Address;
};

export const coreFactories = {
  interchainAccountRouter: new InterchainAccountRouter__factory(),
  interchainQueryRouter: new InterchainQueryRouter__factory(),
  validatorAnnounce: new ValidatorAnnounce__factory(),
  create2Factory: new Create2Factory__factory(),
  proxyAdmin: new ProxyAdmin__factory(),
  multisigIsm: new MultisigIsm__factory(),
  mailbox: new Mailbox__factory(),
};
