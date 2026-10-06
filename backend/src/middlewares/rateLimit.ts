import type { RequestHandler } from 'express';
import { rateLimit, type Options } from 'express-rate-limit';

export interface RateLimitConfig {
  /** Multiplie tous les plafonds (1 en production ; élevé en test pour ne pas gêner les autres scénarios). */
  multiplier: number;
}

/**
 * Limiteur en mémoire (une seule instance d'API). Réponse au format d'erreur du contrat + Retry-After.
 * Limite connue : avec plusieurs instances, il faudrait un store partagé (documenté dans SECURITY.md).
 */
export function limiter(config: RateLimitConfig, windowMs: number, max: number, extra: Partial<Options> = {}): RequestHandler {
  return rateLimit({
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
    global: limiter(config, 60_000, 300),
    login: limiter(config, 15 * 60_000, 20),
    register: limiter(config, 60 * 60_000, 10),
    emailActions: limiter(config, 60 * 60_000, 10),
    refresh: limiter(config, 60_000, 30),
    orders: limiter(config, 60_000, 20),
    scan: limiter(config, 60_000, 240),
  };
}

export type Limiters = ReturnType<typeof buildLimiters>;
