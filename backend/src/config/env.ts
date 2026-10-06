import Joi from 'joi';
import type { Keyring } from '../lib/crypto.js';

/**
 * Configuration validée au démarrage (fail fast) : une variable manquante,
 * mal formée ou un secret trop court empêche le processus de démarrer.
 */
export interface Env {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
  databaseUrl: string;
  frontUrl: string;
  apiPublicUrl: string;
  trustProxyHops: number;
  /** Trousseau HMAC du JWT : clé courante (signature) + anciennes clés (vérification seulement). */
  jwtKeyring: Keyring;
  jwtIssuer: string;
  jwtAudience: string;
  refreshCookieSecure: boolean;
  /** Trousseau AES-256-GCM : clé courante (chiffrement) + anciennes clés (déchiffrement seulement). */
  dataKeyring: Keyring;
  ticketSigningPrivateKeyFile: string;
  ticketSigningPublicKeyFile: string;
  smtp: { host: string; port: number; secure: boolean; user: string | null; password: string | null };
  mailFrom: string;
  psp: { baseUrl: string; port: number; apiKey: string; webhookSecret: string; webhookUrl: string };
  workerIntervalMs: number;
  authResponseFloorMs: number;
}

const httpUrl = Joi.string().uri({ scheme: ['http', 'https'] });

/** Secret aléatoire : base64url strict décodant en au moins 32 octets (256 bits). */
const secret256 = Joi.string()
  .pattern(/^[A-Za-z0-9_-]+$/)
  .custom((value: string, helpers) => (Buffer.from(value, 'base64url').length >= 32 ? value : helpers.error('secret.short')))
  .messages({
    'string.pattern.base': '{{#label}} doit être encodé en base64url',
    'secret.short': '{{#label}} doit décoder en au moins 32 octets (générer avec : node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64url\'))")',
  });

/** Clé AES-256 : base64 standard encodant exactement 32 octets. */
const key32 = Joi.string().base64()
  .custom((value: string, helpers) => (Buffer.from(value, 'base64').length === 32 ? value : helpers.error('key.length')))
  .messages({ 'key.length': '{{#label}} doit encoder exactement 32 octets' });

/** Variables portant un secret : jamais de valeur d'exemple, toutes distinctes entre elles. */
const SECRET_KEYS = ['JWT_ACCESS_SECRET', 'PSP_API_KEY', 'PSP_WEBHOOK_SECRET', 'DATA_ENCRYPTION_KEY'] as const;
const PLACEHOLDER_KEYS = [...SECRET_KEYS, 'DATABASE_URL', 'SMTP_PASSWORD'] as const;

const schema = Joi.object({
  NODE_ENV: Joi.string().valid('development', 'test', 'production').required(),
  PORT: Joi.number().integer().min(1).max(65535).default(4000),
  LOG_LEVEL: Joi.string().valid('fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent').default('info'),
  DATABASE_URL: Joi.string().uri({ scheme: ['postgresql', 'postgres'] }).required(),
  FRONT_URL: httpUrl.required(),
  API_PUBLIC_URL: httpUrl.required(),
  // Nombre EXACT de proxys de confiance (0–3) : au-delà, un client peut forger son IP via X-Forwarded-For.
  TRUST_PROXY_HOPS: Joi.number().integer().min(0).max(3).default(0),
  JWT_ACCESS_SECRET: secret256.required(),
  JWT_KEY_ID: Joi.string().pattern(/^[a-z0-9]{1,16}$/).default('k1'),
  // Rotation : anciens secrets encore acceptés en vérification, "kid:secret_base64url,…".
  JWT_PREVIOUS_SECRETS: Joi.string().allow('').max(2000).default('')
    .custom((value: string, helpers) => {
      if (value === '') return value;
      for (const entry of value.split(',')) {
        const [kid, secret, ...rest] = entry.split(':');
        if (rest.length > 0 || !kid || !/^[a-z0-9]{1,16}$/.test(kid) || !secret || !/^[A-Za-z0-9_-]+$/.test(secret)
          || Buffer.from(secret, 'base64url').length < 32) {
          return helpers.error('keys.format');
        }
      }
      return value;
    })
    .messages({ 'keys.format': 'JWT_PREVIOUS_SECRETS doit être de la forme kid:secret_base64url(≥ 32 octets),…' }),
  JWT_ISSUER: Joi.string().min(1).max(100).required(),
  JWT_AUDIENCE: Joi.string().min(1).max(100).required(),
  REFRESH_COOKIE_SECURE: Joi.boolean().truthy('true').falsy('false').required()
    .when('NODE_ENV', { is: 'production', then: Joi.valid(true) }),
  DATA_ENCRYPTION_KEY: key32.required(),
  DATA_ENCRYPTION_KEY_ID: Joi.string().pattern(/^[a-z0-9]{1,16}$/).default('k1'),
  // Anciennes clés pour la rotation : "kid:base64,kid:base64" (déchiffrement uniquement).
  DATA_ENCRYPTION_PREVIOUS_KEYS: Joi.string().allow('').max(2000).default('')
    .custom((value: string, helpers) => {
      if (value === '') return value;
      for (const entry of value.split(',')) {
        const [kid, b64, ...rest] = entry.split(':');
        if (rest.length > 0 || !kid || !/^[a-z0-9]{1,16}$/.test(kid) || !b64 || Buffer.from(b64, 'base64').length !== 32) {
          return helpers.error('keys.format');
        }
      }
      return value;
    })
    .messages({ 'keys.format': 'DATA_ENCRYPTION_PREVIOUS_KEYS doit être de la forme kid:base64(32 octets),…' }),
  TICKET_SIGNING_PRIVATE_KEY_FILE: Joi.string().min(1).required(),
  TICKET_SIGNING_PUBLIC_KEY_FILE: Joi.string().min(1).required(),
  SMTP_HOST: Joi.string().hostname().required(),
  SMTP_PORT: Joi.number().integer().min(1).max(65535).required(),
  SMTP_SECURE: Joi.boolean().truthy('true').falsy('false').default(false),
  SMTP_USER: Joi.string().allow('').default(''),
  SMTP_PASSWORD: Joi.string().allow('').default(''),
  MAIL_FROM: Joi.string().min(3).max(200).required(),
  PSP_BASE_URL: httpUrl.required(),
  PSP_PORT: Joi.number().integer().min(1).max(65535).default(4001),
  PSP_API_KEY: secret256.required(),
  PSP_WEBHOOK_SECRET: secret256.required(),
  PSP_WEBHOOK_URL: httpUrl.required(),
  WORKER_INTERVAL_MS: Joi.number().integer().min(500).max(600_000).default(5000),
  // Temps de réponse plancher des actions d'authentification anonymes (anti-oracle de timing).
  // Réductible uniquement en test, pour garder une suite rapide.
  AUTH_RESPONSE_FLOOR_MS: Joi.number().integer().max(5000).default(400)
    .when('NODE_ENV', { is: 'test', then: Joi.number().min(0), otherwise: Joi.number().min(300) }),
})
  // Les autres variables du système (PATH, HOME…) sont ignorées et non recopiées.
  .unknown(true)
  .custom((value: Record<string, unknown>, helpers) => {
    for (const key of PLACEHOLDER_KEYS) {
      const v = value[key];
      if (typeof v === 'string' && /CHANGE_ME/i.test(v)) return helpers.error('env.placeholder', { key });
    }
    const seen = new Map<string, string>();
    for (const key of SECRET_KEYS) {
      const v = value[key];
      if (typeof v !== 'string') continue;
      const other = seen.get(v);
      if (other) return helpers.error('env.duplicate', { key, other });
      seen.set(v, key);
    }
    return value;
  })
  .messages({
    'env.placeholder': '{{#key}} contient une valeur d’exemple (CHANGE_ME) : générer un vrai secret',
    'env.duplicate': '{{#key}} et {{#other}} doivent être des secrets distincts',
  });

interface RawEnv {
  NODE_ENV: Env['nodeEnv'];
  PORT: number;
  LOG_LEVEL: Env['logLevel'];
  DATABASE_URL: string;
  FRONT_URL: string;
  API_PUBLIC_URL: string;
  TRUST_PROXY_HOPS: number;
  JWT_ACCESS_SECRET: string;
  JWT_KEY_ID: string;
  JWT_PREVIOUS_SECRETS: string;
  JWT_ISSUER: string;
  JWT_AUDIENCE: string;
  REFRESH_COOKIE_SECURE: boolean;
  DATA_ENCRYPTION_KEY: string;
  DATA_ENCRYPTION_KEY_ID: string;
  DATA_ENCRYPTION_PREVIOUS_KEYS: string;
  TICKET_SIGNING_PRIVATE_KEY_FILE: string;
  TICKET_SIGNING_PUBLIC_KEY_FILE: string;
  SMTP_HOST: string;
  SMTP_PORT: number;
  SMTP_SECURE: boolean;
  SMTP_USER: string;
  SMTP_PASSWORD: string;
  MAIL_FROM: string;
  PSP_BASE_URL: string;
  PSP_PORT: number;
  PSP_API_KEY: string;
  PSP_WEBHOOK_SECRET: string;
  PSP_WEBHOOK_URL: string;
  WORKER_INTERVAL_MS: number;
  AUTH_RESPONSE_FLOOR_MS: number;
}

export class EnvValidationError extends Error {
  constructor(public readonly problems: string[]) {
    // Les messages Joi citent la variable fautive, jamais sa valeur.
    super(`Configuration invalide : ${problems.join(' ; ')}`);
    this.name = 'EnvValidationError';
  }
}

export function parseEnv(source: NodeJS.ProcessEnv): Env {
  const result = schema.validate(source, { abortEarly: false, convert: true, errors: { wrap: { label: false } } });
  if (result.error) {
    throw new EnvValidationError(result.error.details.map((d) => d.message.replace(/ with value .*$/, '')));
  }
  const raw = result.value as RawEnv;
  return {
    nodeEnv: raw.NODE_ENV,
    port: raw.PORT,
    logLevel: raw.LOG_LEVEL,
    databaseUrl: raw.DATABASE_URL,
    frontUrl: new URL(raw.FRONT_URL).origin,
    apiPublicUrl: raw.API_PUBLIC_URL.replace(/\/+$/, ''),
    trustProxyHops: raw.TRUST_PROXY_HOPS,
    jwtKeyring: buildJwtKeyring(raw),
    jwtIssuer: raw.JWT_ISSUER,
    jwtAudience: raw.JWT_AUDIENCE,
    refreshCookieSecure: raw.REFRESH_COOKIE_SECURE,
    dataKeyring: buildKeyring(raw),
    ticketSigningPrivateKeyFile: raw.TICKET_SIGNING_PRIVATE_KEY_FILE,
    ticketSigningPublicKeyFile: raw.TICKET_SIGNING_PUBLIC_KEY_FILE,
    smtp: {
      host: raw.SMTP_HOST,
      port: raw.SMTP_PORT,
      secure: raw.SMTP_SECURE,
      user: raw.SMTP_USER === '' ? null : raw.SMTP_USER,
      password: raw.SMTP_PASSWORD === '' ? null : raw.SMTP_PASSWORD,
    },
    mailFrom: raw.MAIL_FROM,
    psp: {
      baseUrl: raw.PSP_BASE_URL.replace(/\/+$/, ''),
      port: raw.PSP_PORT,
      apiKey: raw.PSP_API_KEY,
      webhookSecret: raw.PSP_WEBHOOK_SECRET,
      webhookUrl: raw.PSP_WEBHOOK_URL,
    },
    workerIntervalMs: raw.WORKER_INTERVAL_MS,
    authResponseFloorMs: raw.AUTH_RESPONSE_FLOOR_MS,
  };
}

function buildKeyring(raw: RawEnv): Keyring {
  const current = { id: raw.DATA_ENCRYPTION_KEY_ID, key: Buffer.from(raw.DATA_ENCRYPTION_KEY, 'base64') };
  const byId = new Map<string, Buffer>();
  if (raw.DATA_ENCRYPTION_PREVIOUS_KEYS !== '') {
    for (const entry of raw.DATA_ENCRYPTION_PREVIOUS_KEYS.split(',')) {
      const [id, b64] = entry.split(':');
      if (id && b64) byId.set(id, Buffer.from(b64, 'base64'));
    }
  }
  if (byId.has(current.id)) throw new EnvValidationError([`DATA_ENCRYPTION_PREVIOUS_KEYS réutilise l’identifiant courant ${current.id}`]);
  byId.set(current.id, current.key);
  return { current, byId };
}

function buildJwtKeyring(raw: RawEnv): Keyring {
  // Clé HMAC = octets décodés du secret base64url (et non la chaîne UTF-8).
  const current = { id: raw.JWT_KEY_ID, key: Buffer.from(raw.JWT_ACCESS_SECRET, 'base64url') };
  const byId = new Map<string, Buffer>();
  if (raw.JWT_PREVIOUS_SECRETS !== '') {
    for (const entry of raw.JWT_PREVIOUS_SECRETS.split(',')) {
      const [id, secret] = entry.split(':');
      if (id && secret) byId.set(id, Buffer.from(secret, 'base64url'));
    }
  }
  if (byId.has(current.id)) throw new EnvValidationError([`JWT_PREVIOUS_SECRETS réutilise l’identifiant courant ${current.id}`]);
  byId.set(current.id, current.key);
  return { current, byId };
}

let cached: Env | null = null;

/** Configuration du processus courant, validée au premier accès. */
export function getEnv(): Env {
  cached ??= parseEnv(process.env);
  return cached;
}

/** Réservé aux tests : force une nouvelle lecture de process.env. */
export function resetEnvCache(): void {
  cached = null;
}
