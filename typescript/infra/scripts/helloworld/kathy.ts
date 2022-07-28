import { ethers } from 'ethers';
import { Counter, Gauge, Registry } from 'prom-client';
import { format } from 'util';

import { HelloWorldApp } from '@abacus-network/helloworld';
import {
  ChainName,
  Chains,
  InterchainGasCalculator,
} from '@abacus-network/sdk';

import { debug, error, log } from '../../src/utils/logging';
import { startMetricsServer } from '../../src/utils/metrics';
import { diagonalize, sleep } from '../../src/utils/utils';
import { getCoreEnvironmentConfig, getEnvironment } from '../utils';

import { getApp } from './utils';

const metricsRegister = new Registry();
const messagesSendCount = new Counter({
  name: 'abacus_kathy_messages',
  help: 'Count of messages sent; records successes and failures by status label',
  registers: [metricsRegister],
  labelNames: ['origin', 'remote', 'status'],
});
const currentPairingIndexGauge = new Gauge({
  name: 'abacus_kathy_pairing_index',
  help: 'The current message pairing index kathy is on, this is useful for seeing if kathy is always crashing around the same pairing as pairings are deterministically ordered.',
  registers: [metricsRegister],
  labelNames: [],
});
const messageSendSeconds = new Counter({
  name: 'abacus_kathy_message_send_seconds',
  help: 'Total time spent waiting on messages to get sent including time spent waiting on it to be received.',
  registers: [metricsRegister],
  labelNames: ['origin', 'remote'],
});

metricsRegister.registerMetric(messagesSendCount);
metricsRegister.registerMetric(currentPairingIndexGauge);
metricsRegister.registerMetric(messageSendSeconds);

/** How long we should take to go through all the message pairings in milliseconds. 6hrs by default. */
const FULL_CYCLE_TIME =
  parseInt(process.env['KATHY_FULL_CYCLE_TIME'] as string) ||
  1000 * 60 * 60 * 6;

/** How long we should wait for a message to be received in milliseconds. 10 min by default. */
const MESSAGE_RECEIPT_TIMEOUT =
  parseInt(process.env['KATHY_MESSAGE_RECEIPT_TIMEOUT'] as string) ||
  10 * 60 * 1000;

async function main() {
  startMetricsServer(metricsRegister);
  const environment = await getEnvironment();
  const coreConfig = getCoreEnvironmentConfig(environment);
  const app = await getApp(coreConfig);
  const gasCalc = InterchainGasCalculator.fromEnvironment(
    environment,
    app.multiProvider as any,
  );
  const chains = app.chains() as Chains[];
  const skip = process.env.CHAINS_TO_SKIP?.split(',').filter(
    (skipChain) => skipChain.length > 0,
  );

  const invalidChains = skip?.filter(
    (skipChain: any) => !chains.includes(skipChain),
  );
  if (invalidChains && invalidChains.length > 0) {
    throw new Error(`Invalid chains to skip ${invalidChains}`);
  }

  const origins = chains.filter((chain) => !skip || !skip.includes(chain));
  const pairings = diagonalize(
    origins.map((origin) =>
      origins.map((destination) =>
        origin == destination ? null : { origin, destination },
      ),
    ),
  )
    .filter((v) => v !== null)
    .map((v) => v!);

  // default to once every 6 hours getting through all pairs
  if (!Number.isSafeInteger(FULL_CYCLE_TIME) || FULL_CYCLE_TIME <= 0) {
    error('Invalid cycle time provided');
    process.exit(1);
  }

  // track how many we are still allowed to send in case some messages send slower than expected.
  let allowedToSend = 0;
  setInterval(() => {
    allowedToSend++;
  }, FULL_CYCLE_TIME / pairings.length);

  for (
    // in case we are restarting kathy, keep it from always running the exact same messages first
    let currentPairingIndex = Date.now() % pairings.length;
    ;
    currentPairingIndex = (currentPairingIndex + 1) % pairings.length
  ) {
    currentPairingIndexGauge.set(currentPairingIndex);
    // wait until we are allowed to send the message
    while (allowedToSend <= 0) await sleep(1000);
    allowedToSend--;

    const { origin, destination } = pairings[currentPairingIndex];
    const labels = {
      origin,
      remote: destination,
    };
    const startTime = Date.now();
    try {
      await sendMessage(app, origin, destination, gasCalc);
      log('Message sent successfully', { origin, destination });
      messagesSendCount.labels({ ...labels, status: 'success' }).inc();
    } catch (e) {
      error(`Error sending message, continuing...`, {
        error: format(e),
        origin,
        destination,
      });
      messagesSendCount.labels({ ...labels, status: 'failure' }).inc();
    }
    messageSendSeconds.labels(labels).inc((Date.now() - startTime) / 1000);

    // print stats once every cycle through the pairings
    if (currentPairingIndex == 0) {
      for (const [origin, destinationStats] of Object.entries(
        await app.stats(),
      )) {
        for (const [destination, counts] of Object.entries(destinationStats)) {
          debug('Message stats', { origin, destination, ...counts });
        }
      }
    }
  }
}

async function sendMessage(
  app: HelloWorldApp<any>,
  origin: ChainName,
  destination: ChainName,
  gasCalc: InterchainGasCalculator<any>,
) {
  const msg = 'Hello!';
  const expected = {
    origin,
    destination,
    sender: app.getContracts(origin).router.address,
    recipient: app.getContracts(destination).router.address,
    body: msg,
  };
  const value = await gasCalc.estimatePaymentForMessage(expected);

  log('Sending message', { origin, destination });

  await new Promise<ethers.ContractReceipt[]>((resolve, reject) => {
    setTimeout(
      () => reject(new Error('Timeout waiting for message receipt')),
      MESSAGE_RECEIPT_TIMEOUT,
    );
    app
      .sendHelloWorld(origin, destination, msg, value, (receipt) => {
        log('Message sent', {
          origin,
          destination,
          events: receipt.events,
          logs: receipt.logs,
        });
      })
      .then(resolve)
      .catch(reject);
  });
}

main()
  .then(() => {
    error('Main exited');
    process.exit(1);
  })
  .catch((e) => {
    error('Error in main', { error: format(e) });
    process.exit(1);
  });
