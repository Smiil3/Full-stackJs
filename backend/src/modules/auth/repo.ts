import type { EmailTokenPurpose } from '../../generated/prisma/client.js';
import { getDb, transaction, type Tx } from '../../lib/db.js';
import { getEnv } from '../../config/env.js';
import { enqueueEmail } from '../../lib/outbox.js';
import { clock } from '../../lib/clock.js';
import { ACCOUNT_FAILURE_WINDOW_MINUTES, ACCOUNT_LOCK_MINUTES, ACCOUNT_LOCK_THRESHOLD, FAILURE_WINDOW_MINUTES, LOCK_GROWTH_FACTOR, LOCK_NOTICE_INTERVAL_MS, LOCK_THRESHOLD, MAX_LOCK_MINUTES } from '../../config/auth.js';

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

/** Signal interne : compte verrouillé ⇒ la transaction est annulée (le couple n'est pas débité). */
class AccountLocked extends Error {}

/**
 * Réserve une tentative de mot de passe AVANT toute vérification, en UNE transaction (deux niveaux) :
 * 1. couple (compte, empreinte d'IP) — `login_lockouts` : le compteur repart à 1 après 15 min sans échec ; dès le
 *    seuil (5) le verrou est posé immédiatement (1 min, puis 2, 4… plafonné à 15 min) : une rafale parallèle ne
 *    peut jamais obtenir plus de 5 évaluations. Un tiers ne verrouille que SON couple, pas le titulaire ;
 * 2. compte, toutes IP — `users` : 50 échecs dans l'heure qui suit le PREMIER échec ⇒ verrou de 15 min ; à
 *    l'expiration du verrou (ou de la fenêtre), le compteur repart à 1 : une requête de temps en temps ne suffit
 *    plus à maintenir le compte fermé (audit M'1). Verrou posé ⇒ mail au titulaire (au plus un par 24 h).
 * Couple ou compte verrouillé ⇒ false, sans évaluation ; un compte verrouillé annule la transaction : le couple
 * n'est pas débité d'une tentative fantôme (audit B'12). Expressions évaluées sur la version COURANTE des lignes.
 */
export async function reserveLoginAttempt(userId: string, fingerprint: string): Promise<boolean> {
  const now = clock.now();
  try {
    return await transaction(async (tx) => {
      const pair = await tx.$queryRaw<{ failedCount: number }[]>`
        INSERT INTO "login_lockouts" AS l ("userId", "fingerprint", "failedCount", "lastFailedAt", "lockedUntil")
        VALUES (${userId}::uuid, ${fingerprint}, 1, ${now}, NULL)
        ON CONFLICT ("userId", "fingerprint") DO UPDATE SET
          "failedCount" = CASE
              WHEN l."lastFailedAt" IS NULL OR l."lastFailedAt" < ${now}::timestamptz - make_interval(mins => ${FAILURE_WINDOW_MINUTES}) THEN 1
              ELSE l."failedCount" + 1
            END,
          "lockedUntil" = CASE
              WHEN (CASE
                      WHEN l."lastFailedAt" IS NULL OR l."lastFailedAt" < ${now}::timestamptz - make_interval(mins => ${FAILURE_WINDOW_MINUTES}) THEN 1
                      ELSE l."failedCount" + 1
                    END) >= ${LOCK_THRESHOLD}
                THEN ${now}::timestamptz + make_interval(mins => LEAST(${MAX_LOCK_MINUTES}, power(${LOCK_GROWTH_FACTOR}::int, l."failedCount" + 1 - ${LOCK_THRESHOLD})::int))
              ELSE NULL
            END,
          "lastFailedAt" = ${now}
        WHERE l."lockedUntil" IS NULL OR l."lockedUntil" <= ${now}
        RETURNING "failedCount"`;
      if (pair.length !== 1) return false;
      // Nouvelle fenêtre si : aucune en cours, fenêtre d'une heure écoulée, ou verrou précédent expiré
      // (le WHERE garantit qu'un verrou présent est échu).
      const account = await tx.$queryRaw<{ lockedUntil: Date | null; lockNoticeSentAt: Date | null; email: string; displayName: string }[]>`
        UPDATE "users"
        SET "failedLoginCount" = CASE
              WHEN "failureWindowStartAt" IS NULL OR "lockedUntil" IS NOT NULL
                OR "failureWindowStartAt" < ${now}::timestamptz - make_interval(mins => ${ACCOUNT_FAILURE_WINDOW_MINUTES}) THEN 1
              ELSE "failedLoginCount" + 1
            END,
            "failureWindowStartAt" = CASE
              WHEN "failureWindowStartAt" IS NULL OR "lockedUntil" IS NOT NULL
                OR "failureWindowStartAt" < ${now}::timestamptz - make_interval(mins => ${ACCOUNT_FAILURE_WINDOW_MINUTES}) THEN ${now}
              ELSE "failureWindowStartAt"
            END,
            "lockedUntil" = CASE
              WHEN "failureWindowStartAt" IS NOT NULL AND "lockedUntil" IS NULL
                AND "failureWindowStartAt" >= ${now}::timestamptz - make_interval(mins => ${ACCOUNT_FAILURE_WINDOW_MINUTES})
                AND "failedLoginCount" + 1 >= ${ACCOUNT_LOCK_THRESHOLD}
                THEN ${now}::timestamptz + make_interval(mins => ${ACCOUNT_LOCK_MINUTES})
              ELSE NULL
            END,
            "lastFailedLoginAt" = ${now},
            "updatedAt" = ${now}
        WHERE "id" = ${userId}::uuid AND ("lockedUntil" IS NULL OR "lockedUntil" <= ${now})
        RETURNING "lockedUntil", "lockNoticeSentAt", "email", "displayName"`;
      const row = account[0];
      if (!row) throw new AccountLocked();
      if (row.lockedUntil !== null && (row.lockNoticeSentAt === null || row.lockNoticeSentAt.getTime() <= now.getTime() - LOCK_NOTICE_INTERVAL_MS)) {
        await tx.user.update({ where: { id: userId }, data: { lockNoticeSentAt: now } });
        await enqueueEmail(tx, row.email, 'accountLocked', {
          displayName: row.displayName, minutes: ACCOUNT_LOCK_MINUTES, resetLink: `${getEnv().frontUrl}/forgot-password`,
        });
      }
      return true;
    });
  } catch (err) {
    if (err instanceof AccountLocked) return false;
    throw err;
  }
}

/** Tentative réussie : compteur du couple supprimé, compteur global du compte remis à zéro. */
export async function recordLoginSuccess(userId: string, fingerprint: string): Promise<void> {
  const db = getDb();
  await db.loginLockout.deleteMany({ where: { userId, fingerprint } });
  await db.user.update({ where: { id: userId }, data: { failedLoginCount: 0, lockedUntil: null, lastFailedLoginAt: null, failureWindowStartAt: null } });
}

/** Réinitialisation du mot de passe (preuve de possession de l'adresse) : TOUS les verrous du compte sont levés. */
export async function clearAllLocks(tx: Tx, userId: string): Promise<void> {
  await tx.loginLockout.deleteMany({ where: { userId } });
  await tx.user.update({ where: { id: userId }, data: { failedLoginCount: 0, lockedUntil: null, lastFailedLoginAt: null, failureWindowStartAt: null } });
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
