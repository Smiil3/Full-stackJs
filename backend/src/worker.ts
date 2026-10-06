import 'dotenv/config';
import { setTimeout as sleep } from 'node:timers/promises';
import { EnvValidationError, getEnv } from './config/env.js';
import { disconnectDb } from './lib/db.js';
import { getLogger } from './lib/logger.js';
import { createSmtpTransport } from './lib/mailer.js';
import { processOutboxBatch } from './lib/outbox.js';
import { purgeExpiredBuckets } from './lib/rateLimitStore.js';
import { expireOrders } from './jobs/expireOrders.js';
import { processRefunds } from './jobs/processRefunds.js';
import { expireWaitlistOffers, sweepWaitlist } from './modules/waitlist/service.js';

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
// SIGTERM / SIGINT interrompent immédiatement l'attente entre deux passages (arrêt propre et rapide).
const stop = new AbortController();

async function tick(): Promise<void> {
  const jobs: [string, () => Promise<unknown>][] = [
    ['expireOrders', () => expireOrders()],
    ['expireWaitlistOffers', () => expireWaitlistOffers()],
    ['sweepWaitlist', () => sweepWaitlist()],
    ['refunds', () => processRefunds()],
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
  while (!stop.signal.aborted) {
    await tick();
    await sleep(env.workerIntervalMs, undefined, { signal: stop.signal }).catch(() => undefined);
  }
  await disconnectDb();
  logger.info('worker arrêté');
}

process.on('SIGTERM', () => {
  stop.abort();
});
process.on('SIGINT', () => {
  stop.abort();
});
await main();
