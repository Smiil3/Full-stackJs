import 'dotenv/config';
import { EnvValidationError, getEnv } from './config/env.js';
import { loadTicketKeys, TicketKeyError } from './lib/ticketSigning.js';
import { disconnectDb } from './lib/db.js';
import { getLogger } from './lib/logger.js';
import { createSmtpTransport } from './lib/mailer.js';
import { runWorker } from './jobs/schedule.js';

/**
 * Worker : expirations, envoi des mails (outbox), purge des compteurs.
 * Plusieurs instances peuvent tourner : verrous consultatifs + SKIP LOCKED évitent tout double traitement.
 */
function loadEnvOrExit() {
  try {
    const loaded = getEnv();
    // Clés de signature des billets chargées et contrôlées au démarrage (fail-fast).
    loadTicketKeys();
    return loaded;
  } catch (err) {
    if (err instanceof EnvValidationError || err instanceof TicketKeyError) {
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

async function main(): Promise<void> {
  logger.info({ intervalMs: env.workerIntervalMs }, 'worker démarré');
  await runWorker({ transport, intervalMs: env.workerIntervalMs, signal: stop.signal, logger });
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
