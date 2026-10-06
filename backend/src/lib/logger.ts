import { pino, type Logger } from 'pino';
import { getEnv } from '../config/env.js';

/** Chemins masqués dans tous les logs (en-têtes sensibles, secrets, données bancaires). */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["psp-signature"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.currentPassword',
  '*.newPassword',
  '*.passwordHash',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.iban',
  '*.qrPayload',
  'password',
  'token',
  'iban',
];

let instance: Logger | null = null;

export function getLogger(): Logger {
  if (!instance) {
    const env = getEnv();
    instance = pino({
      level: env.logLevel,
      redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
      base: { service: 'nuits-api' },
      timestamp: pino.stdTimeFunctions.isoTime,
    });
  }
  return instance;
}
