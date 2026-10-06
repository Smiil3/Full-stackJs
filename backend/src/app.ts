import express, { type Express } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { pinoHttp } from 'pino-http';
import Joi from 'joi';
import { getEnv } from './config/env.js';
import type { Logger } from 'pino';
import { getLogger, serializeError } from './lib/logger.js';
import { clientRequestId, genRequestId } from './middlewares/requestId.js';
import { requireJsonContentType } from './middlewares/contentType.js';
import { errorHandler, notFoundHandler } from './middlewares/errorHandler.js';
import { buildLimiters } from './middlewares/rateLimit.js';
import { endpoint } from './middlewares/validate.js';
import { buildApiRouter, buildWebhookRouter } from './routes.js';

export const JSON_BODY_LIMIT = '10kb';
export const WEBHOOK_BODY_LIMIT = '64kb';

const FORBIDDEN_JSON_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Refuse dès le parsing toute clé JSON pouvant servir à une pollution de prototype (⇒ 400). */
function rejectPrototypeKeys(key: string, value: unknown): unknown {
  if (FORBIDDEN_JSON_KEYS.has(key)) throw new SyntaxError('Clé JSON interdite');
  return value;
}

export interface AppOptions {
  /** Multiplicateur des plafonds de rate limiting (tests). */
  rateLimitMultiplier?: number;
  /** Logger injecté (tests : capture des journaux). */
  logger?: Logger;
}

export function createApp(options: AppOptions = {}): Express {
  const env = getEnv();
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', env.trustProxyHops);
  app.set('query parser', 'simple');

  app.use(
    pinoHttp({
      logger: options.logger ?? getLogger(),
      genReqId: genRequestId,
      // Les URL peuvent contenir des jetons (liens de mail rejoués) : on ne journalise que le chemin.
      serializers: {
        err: serializeError,
        req: (req: { id: unknown; method: string; url: string }) => ({ id: req.id, method: req.method, path: req.url.split('?')[0] }),
      },
      // L'identifiant fourni par le client n'est jamais réutilisé comme requestId : il est journalisé à part, filtré.
      customProps: (req) => {
        const fromClient = clientRequestId(req);
        return fromClient ? { clientRequestId: fromClient } : {};
      },
      customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
    }),
  );

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'none'"], formAction: ["'none'"] },
      },
      crossOriginResourcePolicy: { policy: 'same-site' },
      referrerPolicy: { policy: 'no-referrer' },
      strictTransportSecurity: env.nodeEnv === 'production' ? { maxAge: 31_536_000, includeSubDomains: true } : false,
    }),
  );
  app.use((_req, res, next) => {
    // Réponses d'API personnelles : jamais mises en cache par un intermédiaire.
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  app.use(
    cors({
      origin: [env.frontUrl],
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'DELETE'],
      allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'X-Requested-With', 'X-Request-Id'],
      exposedHeaders: ['Retry-After', 'X-Request-Id', 'Content-Disposition'],
      maxAge: 600,
    }),
  );

  const limiters = buildLimiters({ multiplier: options.rateLimitMultiplier ?? 1 });

  app.get('/health', ...endpoint({ response: Joi.object({ status: Joi.string().valid('ok') }) }, () =>
    Promise.resolve({ status: 'ok' }),
  ));

  // Webhook PSP : limiteur dédié puis corps brut (signature HMAC calculée sur les octets exacts),
  // monté AVANT le parseur JSON pour que le corps ne soit jamais réinterprété.
  app.use(
    '/api/v1/webhooks',
    limiters.webhook,
    requireJsonContentType,
    express.raw({ type: 'application/json', limit: WEBHOOK_BODY_LIMIT }),
    buildWebhookRouter(),
  );

  // Le limiteur global passe avant tout parsing : une rafale de corps volumineux ou malformés est coupée tôt.
  app.use('/api/v1', limiters.global);
  app.use(requireJsonContentType);
  app.use(express.json({ limit: JSON_BODY_LIMIT, strict: true, type: 'application/json', reviver: rejectPrototypeKeys }));
  app.use(cookieParser());
  app.use('/api/v1', buildApiRouter(limiters));

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
