import type { EmailTokenPurpose } from '../../generated/prisma/client.js';
import { getDb, type Tx } from '../../lib/db.js';

export const LOCK_THRESHOLD = 5;
export const MAX_LOCK_MINUTES = 60;

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
 * Échec de connexion : incrément atomique et verrouillage progressif
 * (5 échecs ⇒ 1 min, puis 2, 4, 8… plafonné à 60 min).
 */
export async function recordLoginFailure(userId: string): Promise<void> {
  await getDb().$executeRaw`
    UPDATE "users"
    SET "failedLoginCount" = "failedLoginCount" + 1,
        "lockedUntil" = CASE
          WHEN "failedLoginCount" + 1 >= ${LOCK_THRESHOLD}
            THEN now() + make_interval(mins => LEAST(${MAX_LOCK_MINUTES}, power(2, "failedLoginCount" + 1 - ${LOCK_THRESHOLD})::int))
          ELSE "lockedUntil"
        END,
        "updatedAt" = now()
    WHERE "id" = ${userId}::uuid`;
}

export async function recordLoginSuccess(userId: string): Promise<void> {
  await getDb().user.update({ where: { id: userId }, data: { failedLoginCount: 0, lockedUntil: null } });
}

/** Invalide les jetons mail encore valides d'un usage donné (un seul lien actif à la fois). */
export async function invalidateEmailTokens(tx: Tx, userId: string, purpose: EmailTokenPurpose): Promise<void> {
  await tx.emailToken.updateMany({ where: { userId, purpose, usedAt: null }, data: { usedAt: new Date() } });
}

export async function createEmailToken(tx: Tx, userId: string, purpose: EmailTokenPurpose, tokenHash: string, expiresAt: Date): Promise<void> {
  await tx.emailToken.create({ data: { userId, purpose, tokenHash, expiresAt } });
}

/**
 * Consomme un jeton mail : UPDATE gardé (non utilisé, non expiré, bon usage) ⇒ usage unique même en concurrence.
 * Retourne l'utilisateur concerné ou null.
 */
export async function consumeEmailToken(tx: Tx, tokenHash: string, purpose: EmailTokenPurpose): Promise<string | null> {
  const rows = await tx.$queryRaw<{ userId: string }[]>`
    UPDATE "email_tokens" SET "usedAt" = now()
    WHERE "tokenHash" = ${tokenHash} AND "purpose" = ${purpose}::"EmailTokenPurpose"
      AND "usedAt" IS NULL AND "expiresAt" > now()
    RETURNING "userId"`;
  return rows[0]?.userId ?? null;
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
  await tx.refreshToken.updateMany({ where: { familyId, revokedAt: null }, data: { revokedAt: new Date() } });
}

export async function revokeAllForUser(tx: Tx, userId: string): Promise<void> {
  await tx.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
}
