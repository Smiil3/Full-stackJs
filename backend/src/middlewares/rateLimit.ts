import type { RequestHandler } from 'express';
import type { Request } from 'express';
import { ipKeyGenerator, rateLimit, type Options } from 'express-rate-limit';
import { verifyAccessToken } from '../lib/jwt.js';
import { PgRateLimitStore } from '../lib/rateLimitStore.js';
import { clock } from '../lib/clock.js';
import { HTTP_STATUS } from '../config/http.js';
import { MIN_RETRY_AFTER_SECONDS, RATE_LIMITS } from '../config/rateLimits.js';
import { ceilSeconds } from '../config/units.js';

export interface RateLimitConfig {
  /** Multiplie tous les plafonds (1 en production ; élevé en test pour ne pas gêner les autres scénarios). */
  multiplier: number;
}

/**
 * Limiteur par IP, compteurs dans PostgreSQL (partagés entre instances, conservés au redémarrage).
 * Réponse au format d'erreur du contrat + Retry-After.
 */
export function limiter(
  config: RateLimitConfig, name: string, { windowMs, max }: { windowMs: number; max: number }, extra: Partial<Options> = {},
): RequestHandler {
  return rateLimit({
    store: new PgRateLimitStore(`ip:${name}`),
    windowMs,
    limit: Math.max(1, Math.floor(max * config.multiplier)),
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (req, res) => {
      const reset = (req as { rateLimit?: { resetTime?: Date } }).rateLimit?.resetTime;
      const retryAfter = reset ? Math.max(MIN_RETRY_AFTER_SECONDS, ceilSeconds(reset.getTime() - clock.now().getTime())) : ceilSeconds(windowMs);
      res.setHeader('Retry-After', String(retryAfter));
      res.status(HTTP_STATUS.TOO_MANY_REQUESTS).json({ error: { code: 'RATE_LIMITED', message: 'Trop de requêtes, veuillez patienter.' } });
    },
    ...extra,
  });
}

const BEARER = /^Bearer (\S{1,4096})$/;

/**
 * Clé du limiteur général : le compte (jeton d'accès VALIDE, vérification HMAC peu coûteuse) sinon l'IP.
 * Des acheteurs derrière un même NAT d'opérateur (CGNAT) ou des contrôleurs sur le wifi d'une salle ne se
 * pénalisent plus mutuellement.
 */
async function accountOrIp(req: Request): Promise<string> {
  const header = req.headers.authorization;
  const token = typeof header === 'string' ? BEARER.exec(header)?.[1] : undefined;
  if (token) {
    const claims = await verifyAccessToken(token);
    if (claims) return `user:${claims.userId}`;
  }
  return `ip:${ipKeyGenerator(req.ip ?? '0.0.0.0')}`;
}

/** Routes qui ont leur PROPRE plafond par compte : exemptées du limiteur général (sinon double comptage). */
const OWN_LIMIT_ROUTES = [
  /^\/orgs\/[^/]+\/events\/[^/]+\/checkin\/(scan|sync)$/,
  /^\/orders\/[^/]+$/,
];

export function buildLimiters(config: RateLimitConfig) {
  return {
    // Filet anti-inondation par IP, large (NAT de salle, CGNAT mobile).
    globalIp: limiter(config, 'global-ip', RATE_LIMITS.globalIp),
    // Plafond général par compte (sinon par IP), hors routes à plafond propre.
    global: limiter(config, 'global', RATE_LIMITS.global, {
      keyGenerator: accountOrIp,
      skip: (req) => OWN_LIMIT_ROUTES.some((re) => re.test(req.path)),
    }),
    // Suivi d'une commande (le front interroge toutes les 2 s après paiement) : par compte.
    orderPoll: limiter(config, 'order-poll', RATE_LIMITS.orderPoll, { keyGenerator: accountOrIp }),
    login: limiter(config, 'login', RATE_LIMITS.login),
    register: limiter(config, 'register', RATE_LIMITS.register),
    emailActions: limiter(config, 'email', RATE_LIMITS.emailActions),
    refresh: limiter(config, 'refresh', RATE_LIMITS.refresh),
    // Réservation : 60 / min par IP (opérateurs mobiles en CGNAT : beaucoup d'acheteurs derrière une IP)
    // ET 10 / min par compte (après authentification).
    orders: limiter(config, 'orders', RATE_LIMITS.orders),
    ordersPerUser: limiter(config, 'orders-user', RATE_LIMITS.ordersPerUser, {
      keyGenerator: (_req, res) => {
        const auth = (res.locals as { auth?: { userId?: string } }).auth;
        return `user:${auth?.userId ?? 'anonyme'}`;
      },
    }),
    // Contrôle : wifi de salle partagé ⇒ plafond IP large ; le vrai plafond est par contrôleur.
    scan: limiter(config, 'scan', RATE_LIMITS.scan),
    scanPerUser: limiter(config, 'scan-user', RATE_LIMITS.scanPerUser, {
      keyGenerator: (_req, res) => {
        const auth = (res.locals as { auth?: { userId?: string } }).auth;
        return `user:${auth?.userId ?? 'anonyme'}`;
      },
    }),
  };
}

export type Limiters = ReturnType<typeof buildLimiters>;
