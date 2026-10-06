import 'dotenv/config';
import { setTimeout as sleep } from 'node:timers/promises';
import { EnvValidationError, getEnv } from './config/env.js';
import { disconnectDb } from './lib/db.js';
import { getLogger } from './lib/logger.js';
import { createSmtpTransport } from './lib/mailer.js';
import { processOutboxBatch } from './lib/outbox.js';
import { purgeExpiredBuckets } from './lib/rateLimitStore.js';
import { expireOrders } from './jobs/expireOrders.js';

/**
 * Worker : expirations, envoi des mails (outbox), purge des compteurs.
 * Plusieurs instances peuvent tourner : verrous consultatifs + SKIP LOCKED évitent tout double traitement.
 */
function loadEnvOrExit() {
  try {
    return getEnv();
  } catch (err) {
    if (err instanceof EnvValidationError) {
      process.stderr.write(`${err.message}\nDémarrage refusé.\n`);
      process.exit(1);
    }
    throw err;
  }
}

const env = loadEnvOrExit();
const logger = getLogger().child({ component: 'worker' });
const transport = createSmtpTransport();
let stopping = false;

async function tick(): Promise<void> {
  const jobs: [string, () => Promise<unknown>][] = [
    ['expireOrders', () => expireOrders()],
    ['outbox', () => processOutboxBatch(transport)],
    ['purgeRateLimits', () => purgeExpiredBuckets()],
  ];
  for (const [name, job] of jobs) {
    try {
      const result = await job();
      logger.debug({ job: name, result }, 'job exécuté');
    } catch (err) {
      // Un job en échec n'empêche pas les autres ; il sera retenté au tour suivant.
      logger.error({ err, job: name }, 'échec du job');
    }
  }
}

async function main(): Promise<void> {
  logger.info({ intervalMs: env.workerIntervalMs }, 'worker démarré');
  while (!stopping) {
    await tick();
    await sleep(env.workerIntervalMs);
  }
  await disconnectDb();
  logger.info('worker arrêté');
}

process.on('SIGTERM', () => {
  stopping = true;
});
process.on('SIGINT', () => {
  stopping = true;
});
await main();
