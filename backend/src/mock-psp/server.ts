import 'dotenv/config';
import { EnvValidationError, getEnv } from '../config/env.js';
import { getLogger } from '../lib/logger.js';
import { createMockPsp } from './app.js';

/** Serveur du PSP simulé : refuse de démarrer en production. */
function main(): void {
  let env;
  try {
    env = getEnv();
  } catch (err) {
    if (err instanceof EnvValidationError) {
      process.stderr.write(`${err.message}\nDémarrage refusé.\n`);
      process.exit(1);
    }
    throw err;
  }
  if (env.nodeEnv === 'production') {
    process.stderr.write('Le PSP simulé ne peut pas être démarré en production.\n');
    process.exit(1);
  }
  const logger = getLogger().child({ component: 'mock-psp' });
  const psp = createMockPsp({
    apiKey: env.psp.apiKey,
    webhookSecret: env.psp.webhookSecret,
    publicUrl: env.psp.baseUrl,
    allowedRedirectOrigins: [env.frontUrl],
    nodeEnv: env.nodeEnv,
    deliver: async (rawBody, signature) => {
      const res = await fetch(env.psp.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Psp-Signature': signature },
        body: rawBody,
        signal: AbortSignal.timeout(10_000),
      });
      logger.info({ status: res.status }, 'webhook livré');
      return res.status;
    },
  });
  psp.app.listen(env.psp.port, '127.0.0.1', () => {
    logger.info({ port: env.psp.port }, 'PSP simulé démarré');
  });
}

main();
