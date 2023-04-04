import {
  LegacyMultisigIsm__factory,
  Mailbox__factory,
  ProxyAdmin__factory,
  ValidatorAnnounce__factory,
} from '@hyperlane-xyz/core';

export const coreFactories = {
  validatorAnnounce: new ValidatorAnnounce__factory(),
  proxyAdmin: new ProxyAdmin__factory(),
  multisigIsm: new LegacyMultisigIsm__factory(),
  mailbox: new Mailbox__factory(),
};

export type CoreFactories = typeof coreFactories;
