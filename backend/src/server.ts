import 'dotenv/config';
import { EnvValidationError, getEnv } from './config/env.js';
import { loadTicketKeys, TicketKeyError } from './lib/ticketSigning.js';
import { getLogger } from './lib/logger.js';
import { createApp } from './app.js';
import { disconnectDb } from './lib/db.js';
import { warmUpAuth } from './modules/auth/service.js';

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
const logger = getLogger();
await warmUpAuth();
const server = createApp({ rateLimitMultiplier: env.rateLimitMultiplier }).listen(env.port, () => {
  // Configuration réseau effective journalisée au démarrage (aucun secret).
  logger.info(
    { port: env.port, env: env.nodeEnv, trustProxyHops: env.trustProxyHops, frontUrl: env.frontUrl, refreshCookieSecure: env.refreshCookieSecure },
    'API démarrée',
  );
});

function shutdown(signal: string): void {
  logger.info({ signal }, 'arrêt de l’API');
  server.close(() => {
    void disconnectDb().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => {
  shutdown('SIGTERM');
});
process.on('SIGINT', () => {
  shutdown('SIGINT');
});
