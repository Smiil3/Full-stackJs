import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from 'dotenv';
import { resetEnvCache } from '../../src/config/env.js';
import { assertTestDatabaseUrl } from './guard.js';

/**
 * Environnement de test : secrets aléatoires générés à chaque exécution (aucun secret en dur),
 * base de test dédiée, clés Ed25519 éphémères.
 */
config({ quiet: true });
const testDbUrl = assertTestDatabaseUrl(process.env['TEST_DATABASE_URL'], process.env['DATABASE_URL']);

const keyDir = mkdtempSync(join(tmpdir(), 'nuits-keys-'));
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
writeFileSync(join(keyDir, 'private.pem'), privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
writeFileSync(join(keyDir, 'public.pem'), publicKey.export({ type: 'spki', format: 'pem' }));

Object.assign(process.env, {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  DATABASE_URL: testDbUrl,
  FRONT_URL: 'http://localhost:5173',
  API_PUBLIC_URL: 'http://localhost:4000',
  TRUST_PROXY_HOPS: '0',
  JWT_ACCESS_SECRET: randomBytes(48).toString('base64url'),
  JWT_ISSUER: 'nuits-api',
  JWT_AUDIENCE: 'nuits-web',
  REFRESH_COOKIE_SECURE: 'false',
  DATA_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  TICKET_SIGNING_PRIVATE_KEY_FILE: join(keyDir, 'private.pem'),
  TICKET_SIGNING_PUBLIC_KEY_FILE: join(keyDir, 'public.pem'),
  SMTP_HOST: '127.0.0.1',
  SMTP_PORT: '1025',
  MAIL_FROM: 'Tests <tests@nuits.test>',
  PSP_BASE_URL: 'http://127.0.0.1:4999',
  PSP_API_KEY: randomBytes(32).toString('base64url'),
  PSP_WEBHOOK_SECRET: randomBytes(32).toString('base64url'),
  PSP_WEBHOOK_URL: 'http://127.0.0.1:4000/api/v1/webhooks/psp',
  // Plancher réduit pour la vitesse de la suite ; un test dédié vérifie le vrai plancher.
  AUTH_RESPONSE_FLOOR_MS: '0',
  // Valeurs de production : un .env de développement local (multiplicateur e2e) ne doit pas fausser les tests.
  RATE_LIMIT_MULTIPLIER: '1',
});
resetEnvCache();
