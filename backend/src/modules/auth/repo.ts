import type { EmailTokenPurpose } from '../../generated/prisma/client.js';
import { getDb, type Tx } from '../../lib/db.js';
import { clock } from '../../lib/clock.js';
import { FAILURE_WINDOW_MINUTES, LOCK_GROWTH_FACTOR, LOCK_THRESHOLD, MAX_LOCK_MINUTES } from '../../config/auth.js';

export function findUserByEmail(email: string) {
  return getDb().user.findUnique({ where: { email } });
}

/** Utilisateur et ses adhésions, pour `GET /auth/me` et les réponses de session. */
export function findUserWithMemberships(userId: string) {
  return getDb().user.findUnique({
    where: { id: userId },
    select: {
      id: true, email: true, displayName: true, emailVerifiedAt: true, isPlatformAdmin: true, tokenVersion: true,
      memberships: {
        select: { role: true, organization: { select: { id: true, name: true, slug: true } } },
        orderBy: { createdAt: 'asc' },
      },
    },
  });
}

/**
 * Réserve une tentative de mot de passe AVANT toute vérification (UPDATE atomique) :
 * - compte verrouillé ⇒ aucune réservation (null) : la tentative est refusée sans évaluation ;
 * - le compteur repart à 1 après 15 min sans échec (fenêtre glissante) ;
 * - dès le seuil (5), le verrou est posé immédiatement (1 min, puis 2, 4… plafonné à 15 min) :
 *   une rafale parallèle ne peut donc jamais obtenir plus de 5 évaluations.
 * Une tentative réussie efface ensuite compteur et verrou (recordLoginSuccess).
 */
export async function reserveLoginAttempt(userId: string): Promise<boolean> {
  const now = clock.now();
  // Expressions évaluées sur la version COURANTE de la ligne (re-vérifiée après attente du verrou
  // de ligne) : aucune lecture préalable susceptible d'être périmée en cas de rafale concurrente.
  const rows = await getDb().$queryRaw<{ failedLoginCount: number }[]>`
    UPDATE "users"
    SET "failedLoginCount" = CASE
          WHEN "lastFailedLoginAt" IS NULL OR "lastFailedLoginAt" < ${now}::timestamptz - make_interval(mins => ${FAILURE_WINDOW_MINUTES}) THEN 1
          ELSE "failedLoginCount" + 1
        END,
        "lockedUntil" = CASE
          WHEN (CASE
                  WHEN "lastFailedLoginAt" IS NULL OR "lastFailedLoginAt" < ${now}::timestamptz - make_interval(mins => ${FAILURE_WINDOW_MINUTES}) THEN 1
                  ELSE "failedLoginCount" + 1
                END) >= ${LOCK_THRESHOLD}
            THEN ${now}::timestamptz + make_interval(mins => LEAST(${MAX_LOCK_MINUTES}, power(${LOCK_GROWTH_FACTOR}::int, "failedLoginCount" + 1 - ${LOCK_THRESHOLD})::int))
          ELSE NULL
        END,
        "lastFailedLoginAt" = ${now},
        "updatedAt" = ${now}
    WHERE "id" = ${userId}::uuid AND ("lockedUntil" IS NULL OR "lockedUntil" <= ${now})
    RETURNING "failedLoginCount"`;
  return rows.length === 1;
}

export async function recordLoginSuccess(userId: string): Promise<void> {
  await getDb().user.update({ where: { id: userId }, data: { failedLoginCount: 0, lockedUntil: null, lastFailedLoginAt: null } });
}

/** Invalide les jetons mail encore valides d'un usage donné (un seul lien actif à la fois). */
export async function invalidateEmailTokens(tx: Tx, userId: string, purpose: EmailTokenPurpose): Promise<void> {
  await tx.emailToken.updateMany({ where: { userId, purpose, usedAt: null }, data: { usedAt: clock.now() } });
}

export async function createEmailToken(
  tx: Tx, userId: string, email: string, purpose: EmailTokenPurpose, tokenHash: string, expiresAt: Date,
): Promise<void> {
  await tx.emailToken.create({ data: { userId, email, purpose, tokenHash, expiresAt } });
}

/** Mails d'authentification déjà émis pour ce compte depuis `since` (registre = table des jetons). */
export function countEmailTokensSince(tx: Tx, userId: string, since: Date): Promise<number> {
  return tx.emailToken.count({ where: { userId, createdAt: { gt: since } } });
}

/**
 * Consomme un jeton mail : UPDATE gardé (non utilisé, non expiré, bon usage) ⇒ usage unique même en concurrence.
 * Retourne l'utilisateur concerné ou null.
 */
export async function consumeEmailToken(tx: Tx, tokenHash: string, purpose: EmailTokenPurpose): Promise<string | null> {
  // Le jeton n'est valable que si l'adresse du compte est toujours celle à laquelle il a été envoyé.
  const rows = await tx.$queryRaw<{ userId: string }[]>`
    UPDATE "email_tokens" t SET "usedAt" = ${clock.now()}
    FROM "users" u
    WHERE t."tokenHash" = ${tokenHash} AND t."purpose" = ${purpose}::"EmailTokenPurpose"
      AND t."usedAt" IS NULL AND t."expiresAt" > ${clock.now()}
      AND u."id" = t."userId" AND u."email" = t."email"
    RETURNING t."userId"`;
  return rows[0]?.userId ?? null;
}

/** Pré-contrôle (sans consommation) d'un jeton mail : existe, bon usage, non utilisé, non expiré, même adresse. */
export async function isEmailTokenUsable(tokenHash: string, purpose: EmailTokenPurpose): Promise<boolean> {
  const rows = await getDb().$queryRaw<{ ok: number }[]>`
    SELECT 1 AS ok FROM "email_tokens" t JOIN "users" u ON u."id" = t."userId"
    WHERE t."tokenHash" = ${tokenHash} AND t."purpose" = ${purpose}::"EmailTokenPurpose"
      AND t."usedAt" IS NULL AND t."expiresAt" > ${clock.now()} AND u."email" = t."email"`;
  return rows.length === 1;
}

export interface RefreshRow {
  id: string;
  userId: string;
  familyId: string;
  expiresAt: Date;
  revokedAt: Date | null;
  replacedById: string | null;
  rotatedAt: Date | null;
  familyCreatedAt: Date;
  tokenVersion: number;
}

/** Propriétaire d'un refresh token (lecture sans verrou, pour verrouiller ensuite dans l'ordre user → jetons). */
export async function refreshOwner(tx: Tx, tokenHash: string): Promise<string | null> {
  const row = await tx.refreshToken.findUnique({ where: { tokenHash }, select: { userId: true } });
  return row?.userId ?? null;
}

/**
 * Verrouille la ligne utilisateur. Ordre de verrouillage commun à tout le module (utilisateur, puis
 * jetons) : la rotation et un changement de mot de passe concurrents se sérialisent sans interblocage.
 */
export async function lockUser(tx: Tx, userId: string): Promise<{ tokenVersion: number } | null> {
  const rows = await tx.$queryRaw<{ tokenVersion: number }[]>`
    SELECT "tokenVersion" FROM "users" WHERE "id" = ${userId}::uuid FOR UPDATE`;
  return rows[0] ?? null;
}

/** Verrouille un refresh token par son hash. */
export async function lockRefreshToken(tx: Tx, tokenHash: string): Promise<RefreshRow | null> {
  const rows = await tx.$queryRaw<RefreshRow[]>`
    SELECT "id", "userId", "familyId", "expiresAt", "revokedAt", "replacedById", "rotatedAt", "familyCreatedAt", "tokenVersion"
    FROM "refresh_tokens" WHERE "tokenHash" = ${tokenHash} FOR UPDATE`;
  return rows[0] ?? null;
}

/** Verrouille un refresh token par son identifiant (successeur dans la chaîne de rotation). */
export async function lockRefreshTokenById(tx: Tx, id: string): Promise<RefreshRow | null> {
  const rows = await tx.$queryRaw<RefreshRow[]>`
    SELECT "id", "userId", "familyId", "expiresAt", "revokedAt", "replacedById", "rotatedAt", "familyCreatedAt", "tokenVersion"
    FROM "refresh_tokens" WHERE "id" = ${id}::uuid FOR UPDATE`;
  return rows[0] ?? null;
}

export async function revokeFamily(tx: Tx, familyId: string): Promise<void> {
  await tx.refreshToken.updateMany({ where: { familyId, revokedAt: null }, data: { revokedAt: clock.now() } });
}

export async function revokeAllForUser(tx: Tx, userId: string): Promise<void> {
  await tx.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: clock.now() } });
}
