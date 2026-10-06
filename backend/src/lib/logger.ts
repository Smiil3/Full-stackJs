import { pino, type DestinationStream, type Logger } from 'pino';
import { getEnv } from '../config/env.js';
import { Prisma } from '../generated/prisma/client.js';

/** Clés sensibles masquées à toute profondeur raisonnable (0 à 3 niveaux). */
const SENSITIVE_KEYS = [
  'password', 'currentPassword', 'newPassword', 'passwordHash',
  'token', 'tokenHash', 'accessToken', 'refreshToken',
  'iban', 'bankIbanEncrypted', 'transferIbanEncrypted',
  'email', 'payload', 'qrPayload', 'secret',
];
const SENSITIVE_HEADERS = ['authorization', 'cookie', 'set-cookie', 'x-api-key', 'psp-signature'];

function buildRedactPaths(): string[] {
  const paths: string[] = [];
  for (const key of SENSITIVE_KEYS) {
    paths.push(key, `*.${key}`, `*.*.${key}`, `*.*.*.${key}`);
  }
  for (const header of SENSITIVE_HEADERS) {
    paths.push(`req.headers["${header}"]`, `res.headers["${header}"]`, `*.headers["${header}"]`);
  }
  return paths;
}

export const REDACT_PATHS = buildRedactPaths();

const PRISMA_ERRORS = [
  Prisma.PrismaClientKnownRequestError,
  Prisma.PrismaClientUnknownRequestError,
  Prisma.PrismaClientValidationError,
  Prisma.PrismaClientInitializationError,
  Prisma.PrismaClientRustPanicError,
];

/**
 * Sérialiseur d'erreur : une erreur Prisma embarque la requête et ses arguments (emails, hashs…) dans
 * son message ; on ne garde que son type, son code et le modèle / la contrainte en cause.
 */
export function serializeError(err: unknown): Record<string, unknown> {
  if (PRISMA_ERRORS.some((cls) => err instanceof cls)) {
    const e = err as { name: string; code?: unknown; meta?: Record<string, unknown> };
    const meta = e.meta ?? {};
    return {
      type: e.name,
      code: typeof e.code === 'string' ? e.code : undefined,
      modelName: typeof meta['modelName'] === 'string' ? meta['modelName'] : undefined,
      target: meta['target'] ?? undefined,
    };
  }
  if (err instanceof Error) return pino.stdSerializers.err(err);
  return { type: typeof err };
}

export function buildLogger(destination?: DestinationStream): Logger {
  const env = getEnv();
  const options = {
    level: env.logLevel,
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    base: { service: 'nuits-api' },
    timestamp: pino.stdTimeFunctions.isoTime,
    serializers: { err: serializeError, error: serializeError },
  };
  return destination ? pino(options, destination) : pino(options);
}

let instance: Logger | null = null;

export function getLogger(): Logger {
  instance ??= buildLogger();
  return instance;
}
