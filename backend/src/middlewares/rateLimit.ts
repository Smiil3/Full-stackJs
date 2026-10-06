import type { RequestHandler } from 'express';
import { rateLimit, type Options } from 'express-rate-limit';
import { PgRateLimitStore } from '../lib/rateLimitStore.js';

export interface RateLimitConfig {
  /** Multiplie tous les plafonds (1 en production ; élevé en test pour ne pas gêner les autres scénarios). */
  multiplier: number;
}

/**
 * Limiteur par IP, compteurs dans PostgreSQL (partagés entre instances, conservés au redémarrage).
 * Réponse au format d'erreur du contrat + Retry-After.
 */
export function limiter(config: RateLimitConfig, name: string, windowMs: number, max: number, extra: Partial<Options> = {}): RequestHandler {
  return rateLimit({
    store: new PgRateLimitStore(`ip:${name}`),
    windowMs,
    limit: Math.max(1, Math.floor(max * config.multiplier)),
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (req, res) => {
      const reset = (req as { rateLimit?: { resetTime?: Date } }).rateLimit?.resetTime;
      const retryAfter = reset ? Math.max(1, Math.ceil((reset.getTime() - Date.now()) / 1000)) : Math.ceil(windowMs / 1000);
      res.setHeader('Retry-After', String(retryAfter));
      res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Trop de requêtes, veuillez patienter.' } });
    },
    ...extra,
  });
}

export function buildLimiters(config: RateLimitConfig) {
  return {
    global: limiter(config, 'global', 60_000, 300),
    login: limiter(config, 'login', 15 * 60_000, 20),
    register: limiter(config, 'register', 60 * 60_000, 10),
    emailActions: limiter(config, 'email', 60 * 60_000, 10),
    refresh: limiter(config, 'refresh', 60_000, 30),
    webhook: limiter(config, 'webhook', 60_000, 120),
    // Réservation : 60 / min par IP (opérateurs mobiles en CGNAT : beaucoup d'acheteurs derrière une IP)
    // ET 10 / min par compte (après authentification).
    orders: limiter(config, 'orders', 60_000, 60),
    ordersPerUser: limiter(config, 'orders-user', 60_000, 10, {
      keyGenerator: (_req, res) => {
        const auth = (res.locals as { auth?: { userId?: string } }).auth;
        return `user:${auth?.userId ?? 'anonyme'}`;
      },
    }),
    scan: limiter(config, 'scan', 60_000, 240),
  };
}

export type Limiters = ReturnType<typeof buildLimiters>;
