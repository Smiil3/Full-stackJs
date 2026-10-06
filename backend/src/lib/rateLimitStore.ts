import type { ClientRateLimitInfo, Options, Store } from 'express-rate-limit';
import { sha256Hex } from './crypto.js';
import { getDb } from './db.js';
import { AppError } from './errors.js';
import { getEnv } from '../config/env.js';
import { clock } from './clock.js';
import { MIN_RETRY_AFTER_SECONDS, RATE_BUCKET_KEY_MAX_LENGTH, RATE_BUCKET_RETENTION_MS } from '../config/rateLimits.js';
import { DEFAULT_RATE_WINDOW_MS, HTTP_STATUS } from '../config/http.js';
import { ceilSeconds } from '../config/units.js';

/** Clé stockée : hash du préfixe et de l'identifiant (IP, email…) — aucune donnée personnelle en clair. */
function bucketKey(prefix: string, id: string): string {
  return `${prefix}:${sha256Hex(id)}`.slice(0, RATE_BUCKET_KEY_MAX_LENGTH);
}

/** Incrément atomique d'un compteur à fenêtre fixe (réinitialisé à l'expiration). */
export async function hit(prefix: string, id: string, windowMs: number, cost = 1): Promise<ClientRateLimitInfo & { resetTime: Date }> {
  const key = bucketKey(prefix, id);
  const now = clock.now();
  const resetAt = new Date(now.getTime() + windowMs);
  const rows = await getDb().$queryRaw<{ hits: number; resetAt: Date }[]>`
    INSERT INTO "rate_limit_buckets" ("key", "hits", "resetAt")
    VALUES (${key}, ${cost}, ${resetAt})
    ON CONFLICT ("key") DO UPDATE SET
      "hits" = CASE WHEN "rate_limit_buckets"."resetAt" <= ${now} THEN ${cost} ELSE "rate_limit_buckets"."hits" + ${cost} END,
      "resetAt" = CASE WHEN "rate_limit_buckets"."resetAt" <= ${now}
                    THEN ${resetAt} ELSE "rate_limit_buckets"."resetAt" END
    RETURNING "hits", "resetAt"`;
  const row = rows[0];
  if (!row) throw new Error('Compteur de rate limiting introuvable');
  return { totalHits: row.hits, resetTime: row.resetAt };
}

/**
 * Store PostgreSQL pour express-rate-limit : compteurs partagés entre instances et conservés
 * au redémarrage (un limiteur en mémoire se contourne en relançant / multipliant les instances).
 */
export class PgRateLimitStore implements Store {
  private windowMs = DEFAULT_RATE_WINDOW_MS;
  readonly localKeys = false;

  constructor(readonly prefix: string) {}

  init(options: Options): void {
    this.windowMs = options.windowMs;
  }

  increment(key: string): Promise<ClientRateLimitInfo> {
    return hit(this.prefix, key, this.windowMs);
  }

  async decrement(key: string): Promise<void> {
    await getDb().$executeRaw`
      UPDATE "rate_limit_buckets" SET "hits" = GREATEST(0, "hits" - 1) WHERE "key" = ${bucketKey(this.prefix, key)}`;
  }

  async resetKey(key: string): Promise<void> {
    await getDb().$executeRaw`DELETE FROM "rate_limit_buckets" WHERE "key" = ${bucketKey(this.prefix, key)}`;
  }
}

/**
 * Quota applicatif (par compte / par adresse email) : même store partagé.
 * Dépassement ⇒ 429 RATE_LIMITED avec Retry-After. Appliqué que l'adresse existe ou non (pas d'énumération).
 */
export async function consumeQuota(prefix: string, id: string, windowMs: number, max: number, cost = 1): Promise<void> {
  const { totalHits, resetTime } = await hit(prefix, id, windowMs, cost);
  if (totalHits > Math.max(1, Math.floor(max * getEnv().rateLimitMultiplier))) {
    const retryAfter = Math.max(MIN_RETRY_AFTER_SECONDS, ceilSeconds(resetTime.getTime() - clock.now().getTime()));
    throw new AppError(HTTP_STATUS.TOO_MANY_REQUESTS, 'RATE_LIMITED', 'Trop de requêtes, veuillez patienter.', { retryAfterSeconds: retryAfter });
  }
}

/** Purge des compteurs expirés (worker). */
export async function purgeExpiredBuckets(): Promise<number> {
  return getDb().$executeRaw`DELETE FROM "rate_limit_buckets" WHERE "resetAt" < ${new Date(clock.now().getTime() - RATE_BUCKET_RETENTION_MS)}`;
}
