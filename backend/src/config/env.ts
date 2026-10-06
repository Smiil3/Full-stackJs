import Joi from 'joi';

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
  jwtAccessSecret: string;
  jwtIssuer: string;
  jwtAudience: string;
  refreshCookieSecure: boolean;
  dataEncryptionKey: Buffer;
  ticketSigningPrivateKeyFile: string;
  ticketSigningPublicKeyFile: string;
  smtp: { host: string; port: number; secure: boolean; user: string | null; password: string | null };
  mailFrom: string;
  psp: { baseUrl: string; port: number; apiKey: string; webhookSecret: string; webhookUrl: string };
  workerIntervalMs: number;
}

const httpUrl = Joi.string().uri({ scheme: ['http', 'https'] });

const schema = Joi.object({
  NODE_ENV: Joi.string().valid('development', 'test', 'production').required(),
  PORT: Joi.number().integer().min(1).max(65535).default(4000),
  LOG_LEVEL: Joi.string().valid('fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent').default('info'),
  DATABASE_URL: Joi.string().uri({ scheme: ['postgresql', 'postgres'] }).required(),
  FRONT_URL: httpUrl.required(),
  API_PUBLIC_URL: httpUrl.required(),
  TRUST_PROXY_HOPS: Joi.number().integer().min(0).max(5).default(0),
  // 256 bits minimum : 43 caractères base64url.
  JWT_ACCESS_SECRET: Joi.string().min(43).required(),
  JWT_ISSUER: Joi.string().min(1).max(100).required(),
  JWT_AUDIENCE: Joi.string().min(1).max(100).required(),
  REFRESH_COOKIE_SECURE: Joi.boolean().truthy('true').falsy('false').required()
    .when('NODE_ENV', { is: 'production', then: Joi.valid(true) }),
  DATA_ENCRYPTION_KEY: Joi.string().base64().required()
    .custom((value: string, helpers) => (Buffer.from(value, 'base64').length === 32 ? value : helpers.error('any.invalid')))
    .messages({ 'any.invalid': 'DATA_ENCRYPTION_KEY doit encoder exactement 32 octets' }),
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
  PSP_API_KEY: Joi.string().min(32).required(),
  PSP_WEBHOOK_SECRET: Joi.string().min(32).required(),
  PSP_WEBHOOK_URL: httpUrl.required(),
  WORKER_INTERVAL_MS: Joi.number().integer().min(500).max(600_000).default(5000),
})
  // Les autres variables du système (PATH, HOME…) sont ignorées et non recopiées.
  .unknown(true);

interface RawEnv {
  NODE_ENV: Env['nodeEnv'];
  PORT: number;
  LOG_LEVEL: Env['logLevel'];
  DATABASE_URL: string;
  FRONT_URL: string;
  API_PUBLIC_URL: string;
  TRUST_PROXY_HOPS: number;
  JWT_ACCESS_SECRET: string;
  JWT_ISSUER: string;
  JWT_AUDIENCE: string;
  REFRESH_COOKIE_SECURE: boolean;
  DATA_ENCRYPTION_KEY: string;
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
    jwtAccessSecret: raw.JWT_ACCESS_SECRET,
    jwtIssuer: raw.JWT_ISSUER,
    jwtAudience: raw.JWT_AUDIENCE,
    refreshCookieSecure: raw.REFRESH_COOKIE_SECURE,
    dataEncryptionKey: Buffer.from(raw.DATA_ENCRYPTION_KEY, 'base64'),
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
  };
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
