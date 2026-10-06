import type { RequestHandler } from 'express';
import type { Request } from 'express';
import { ipKeyGenerator, rateLimit, type Options } from 'express-rate-limit';
import { verifyAccessToken } from '../lib/jwt.js';
import { PgRateLimitStore } from '../lib/rateLimitStore.js';
import { clock } from '../lib/clock.js';

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
      const retryAfter = reset ? Math.max(1, Math.ceil((reset.getTime() - clock.now().getTime()) / 1000)) : Math.ceil(windowMs / 1000);
      res.setHeader('Retry-After', String(retryAfter));
      res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Trop de requêtes, veuillez patienter.' } });
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
    globalIp: limiter(config, 'global-ip', 60_000, 3000),
    // Plafond général par compte (sinon par IP), hors routes à plafond propre.
    global: limiter(config, 'global', 60_000, 300, {
      keyGenerator: accountOrIp,
      skip: (req) => OWN_LIMIT_ROUTES.some((re) => re.test(req.path)),
    }),
    // Suivi d'une commande (le front interroge toutes les 2 s après paiement) : par compte.
    orderPoll: limiter(config, 'order-poll', 60_000, 120, { keyGenerator: accountOrIp }),
    login: limiter(config, 'login', 15 * 60_000, 20),
    register: limiter(config, 'register', 60 * 60_000, 10),
    emailActions: limiter(config, 'email', 60 * 60_000, 10),
    refresh: limiter(config, 'refresh', 60_000, 30),
    // Réservation : 60 / min par IP (opérateurs mobiles en CGNAT : beaucoup d'acheteurs derrière une IP)
    // ET 10 / min par compte (après authentification).
    orders: limiter(config, 'orders', 60_000, 60),
    ordersPerUser: limiter(config, 'orders-user', 60_000, 10, {
      keyGenerator: (_req, res) => {
        const auth = (res.locals as { auth?: { userId?: string } }).auth;
        return `user:${auth?.userId ?? 'anonyme'}`;
      },
    }),
    // Contrôle : wifi de salle partagé ⇒ plafond IP large ; le vrai plafond est par contrôleur.
    scan: limiter(config, 'scan', 60_000, 2400),
    scanPerUser: limiter(config, 'scan-user', 60_000, 240, {
      keyGenerator: (_req, res) => {
        const auth = (res.locals as { auth?: { userId?: string } }).auth;
        return `user:${auth?.userId ?? 'anonyme'}`;
      },
    }),
  };
}

export type Limiters = ReturnType<typeof buildLimiters>;
