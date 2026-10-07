import { pino, type DestinationStream, type Logger } from 'pino';
import { getEnv } from '../config/env.js';
import { Prisma } from '../generated/prisma/client.js';

/** Clés sensibles masquées de 0 à 4 niveaux de profondeur (clés exactes ; les textes libres passent par `scrub`). */
const SENSITIVE_KEYS = [
  'password', 'currentPassword', 'newPassword', 'passwordHash',
  'token', 'tokenHash', 'accessToken', 'refreshToken',
  'iban', 'bankIbanEncrypted', 'transferIbanEncrypted', 'bankBeneficiary', 'transferReference',
  'email', 'buyerEmail', 'contactEmail', 'ownerEmail', 'to', 'displayName',
  'payload', 'qrPayload', 'secret', 'idempotencyKey', 'link',
];
const SENSITIVE_HEADERS = ['authorization', 'cookie', 'set-cookie', 'x-api-key', 'psp-signature'];

function buildRedactPaths(): string[] {
  const paths: string[] = [];
  for (const key of SENSITIVE_KEYS) {
    paths.push(key, `*.${key}`, `*.*.${key}`, `*.*.*.${key}`, `*.*.*.*.${key}`);
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

/** Expurge un texte libre (message, stack) des données personnelles ou secrètes reconnaissables. */
export function scrub(text: string): string {
  return text
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]')
    .replace(/\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g, '[iban]')
    .replace(/\$argon2[^\s"']*/g, '[hash]')
    .replace(/[A-Za-z0-9_-]{32,}/g, '[secret]');
}

/** pino-http passe au sérialiseur une erreur DÉJÀ sérialisée ; l'erreur d'origine est dans `.raw`. */
function unwrap(input: unknown): unknown {
  if (input instanceof Error) return input;
  if (typeof input === 'object' && input !== null && 'raw' in input) {
    const raw = (input).raw;
    if (raw instanceof Error) return raw;
  }
  return input;
}

/**
 * Sérialiseur d'erreur :
 * - erreur Prisma : seulement type, code, modèle et contrainte (son message embarque les arguments : emails, hashs…) ;
 * - autre erreur : nom, code interne, message expurgé, stack expurgée (hors production), cause (1 niveau).
 */
export function serializeError(input: unknown, depth = 0): Record<string, unknown> {
  const err = unwrap(input);
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
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    const out: Record<string, unknown> = {
      type: err.name,
      code: typeof code === 'string' || typeof code === 'number' ? code : undefined,
      message: scrub(err.message),
    };
    if (getEnv().nodeEnv !== 'production' && err.stack) out['stack'] = scrub(err.stack);
    if (err.cause !== undefined && depth < 1) out['cause'] = serializeError(err.cause, depth + 1);
    return out;
  }
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
