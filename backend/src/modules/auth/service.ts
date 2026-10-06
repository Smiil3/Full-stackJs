import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { getEnv } from '../../config/env.js';
import { transaction, type Tx } from '../../lib/db.js';
import { errors } from '../../lib/errors.js';
import { randomToken, sha256Hex } from '../../lib/crypto.js';
import { ACCESS_TOKEN_TTL_SECONDS, signAccessToken } from '../../lib/jwt.js';
import { enqueueEmail } from '../../lib/outbox.js';
import { addMinutes } from '../../lib/time.js';
import * as repo from './repo.js';

export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const EMAIL_TOKEN_TTL_MINUTES = 30;
const ARGON2_OPTIONS = { type: argon2.argon2id } as const;

export const GENERIC_ACCEPTED_MESSAGE =
  'Si cette adresse peut recevoir un message, un email vient de lui être envoyé.';

export interface UserView {
  id: string;
  email: string;
  displayName: string;
  emailVerified: boolean;
  isPlatformAdmin: boolean;
  memberships: { orgId: string; orgName: string; orgSlug: string; role: 'OWNER' | 'MANAGER' | 'SCANNER' }[];
}

export interface AuthSession {
  accessToken: string;
  expiresIn: number;
  user: UserView;
}

export interface SessionResult {
  session: AuthSession;
  refreshToken: string;
}

/** Normalisation unique des emails (unicité insensible à la casse). */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

let dummyHash: Promise<string> | null = null;
/** Hash factice : un email inconnu coûte le même temps de calcul qu'un email connu (anti-énumération par timing). */
function getDummyHash(): Promise<string> {
  dummyHash ??= argon2.hash(randomToken(32), ARGON2_OPTIONS);
  return dummyHash;
}

export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, ARGON2_OPTIONS);
}

async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

/** Les access tokens émis avant ce moment seront refusés (seconde courante, cf. middleware). */
function tokensCutoff(): Date {
  return new Date();
}

async function issueEmailToken(tx: Tx, userId: string, purpose: 'VERIFY_EMAIL' | 'RESET_PASSWORD'): Promise<string> {
  const raw = randomToken(32);
  await repo.invalidateEmailTokens(tx, userId, purpose);
  await repo.createEmailToken(tx, userId, purpose, sha256Hex(raw), addMinutes(new Date(), EMAIL_TOKEN_TTL_MINUTES));
  return raw;
}

function link(path: string, token: string): string {
  return `${getEnv().frontUrl}${path}?token=${encodeURIComponent(token)}`;
}

async function loadUserView(userId: string): Promise<UserView> {
  const user = await repo.findUserWithMemberships(userId);
  if (!user) throw errors.unauthenticated();
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    emailVerified: user.emailVerifiedAt !== null,
    isPlatformAdmin: user.isPlatformAdmin,
    memberships: user.memberships.map((m) => ({ orgId: m.organization.id, orgName: m.organization.name, orgSlug: m.organization.slug, role: m.role })),
  };
}

async function createRefreshToken(tx: Tx, userId: string, familyId: string): Promise<{ id: string; raw: string }> {
  const raw = randomToken(32);
  const row = await tx.refreshToken.create({
    data: { userId, familyId, tokenHash: sha256Hex(raw), expiresAt: new Date(Date.now() + REFRESH_TTL_MS) },
    select: { id: true },
  });
  return { id: row.id, raw };
}

async function buildSession(userId: string, refreshToken: string): Promise<SessionResult> {
  const [accessToken, user] = await Promise.all([signAccessToken(userId), loadUserView(userId)]);
  return { session: { accessToken, expiresIn: ACCESS_TOKEN_TTL_SECONDS, user }, refreshToken };
}

/**
 * Inscription : réponse identique que l'email existe ou non. Le hash du mot de passe est calculé
 * dans tous les cas (même coût). Compte existant : mail « vous avez déjà un compte » ou nouveau lien
 * de vérification, jamais d'erreur visible.
 */
export async function register(input: { email: string; password: string; displayName: string }): Promise<void> {
  const email = normalizeEmail(input.email);
  const passwordHash = await hashPassword(input.password);
  const displayName = input.displayName.trim();
  if (displayName === '') throw errors.validation([{ path: 'displayName', message: '"displayName" est requis' }]);
  try {
    await transaction(async (tx) => {
      const existing = await tx.user.findUnique({ where: { email } });
      if (existing) {
        if (existing.emailVerifiedAt) {
          const raw = await issueEmailToken(tx, existing.id, 'RESET_PASSWORD');
          await enqueueEmail(tx, existing.email, 'accountExists', { displayName: existing.displayName, resetLink: link('/reset-password', raw) });
        } else {
          const raw = await issueEmailToken(tx, existing.id, 'VERIFY_EMAIL');
          await enqueueEmail(tx, existing.email, 'verifyEmail', { displayName: existing.displayName, link: link('/verify-email', raw) });
        }
        return;
      }
      const user = await tx.user.create({ data: { email, passwordHash, displayName } });
      const raw = await issueEmailToken(tx, user.id, 'VERIFY_EMAIL');
      await enqueueEmail(tx, email, 'verifyEmail', { displayName, link: link('/verify-email', raw) });
    });
  } catch (err) {
    // Deux inscriptions simultanées avec le même email : la seconde échoue sur l'unicité ; réponse inchangée.
    if (isUniqueViolation(err)) return;
    throw err;
  }
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err).code === 'P2002';
}

export async function verifyEmail(token: string): Promise<void> {
  const ok = await transaction(async (tx) => {
    const userId = await repo.consumeEmailToken(tx, sha256Hex(token), 'VERIFY_EMAIL');
    if (!userId) return false;
    await tx.user.updateMany({ where: { id: userId, emailVerifiedAt: null }, data: { emailVerifiedAt: new Date() } });
    return true;
  });
  if (!ok) throw errors.validation([{ path: 'token', message: 'Lien invalide ou expiré.' }], 'Lien invalide ou expiré.');
}

export async function resendVerification(rawEmail: string): Promise<void> {
  const email = normalizeEmail(rawEmail);
  await transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { email } });
    if (!user || user.emailVerifiedAt) return;
    const raw = await issueEmailToken(tx, user.id, 'VERIFY_EMAIL');
    await enqueueEmail(tx, user.email, 'verifyEmail', { displayName: user.displayName, link: link('/verify-email', raw) });
  });
}

/**
 * Connexion : message unique pour email inconnu, mot de passe faux ou compte verrouillé ;
 * vérification argon2 systématique (hash factice si l'email est inconnu).
 */
export async function login(rawEmail: string, password: string): Promise<SessionResult> {
  const email = normalizeEmail(rawEmail);
  const user = await repo.findUserByEmail(email);
  if (!user) {
    await verifyPassword(await getDummyHash(), password);
    throw errors.invalidCredentials();
  }
  const locked = user.lockedUntil !== null && user.lockedUntil.getTime() > Date.now();
  const valid = await verifyPassword(user.passwordHash, password);
  if (locked) throw errors.invalidCredentials();
  if (!valid) {
    await repo.recordLoginFailure(user.id);
    throw errors.invalidCredentials();
  }
  if (user.failedLoginCount > 0 || user.lockedUntil) await repo.recordLoginSuccess(user.id);
  const refresh = await transaction((tx) => createRefreshToken(tx, user.id, randomUUID()));
  return buildSession(user.id, refresh.raw);
}

/**
 * Rotation du refresh token. Un jeton déjà utilisé (remplacé) ou révoqué qui revient = vol probable :
 * toute la famille est révoquée et l'utilisateur doit se reconnecter.
 */
export async function refresh(rawToken: string | undefined): Promise<SessionResult> {
  if (!rawToken || !/^[A-Za-z0-9_-]{43}$/.test(rawToken)) throw errors.invalidRefreshToken();
  const outcome = await transaction(async (tx) => {
    const row = await repo.lockRefreshToken(tx, sha256Hex(rawToken));
    if (!row) return { ok: false as const };
    if (row.revokedAt !== null || row.replacedById !== null) {
      await repo.revokeFamily(tx, row.familyId);
      return { ok: false as const };
    }
    if (row.expiresAt.getTime() <= Date.now()) {
      await repo.revokeFamily(tx, row.familyId);
      return { ok: false as const };
    }
    const next = await createRefreshToken(tx, row.userId, row.familyId);
    await tx.refreshToken.update({ where: { id: row.id }, data: { revokedAt: new Date(), replacedById: next.id } });
    return { ok: true as const, userId: row.userId, raw: next.raw };
  });
  if (!outcome.ok) throw errors.invalidRefreshToken();
  return buildSession(outcome.userId, outcome.raw);
}

export async function logout(rawToken: string | undefined): Promise<void> {
  if (!rawToken || !/^[A-Za-z0-9_-]{43}$/.test(rawToken)) return;
  await transaction(async (tx) => {
    const row = await repo.lockRefreshToken(tx, sha256Hex(rawToken));
    if (row) await repo.revokeFamily(tx, row.familyId);
  });
}

export async function forgotPassword(rawEmail: string): Promise<void> {
  const email = normalizeEmail(rawEmail);
  await transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { email } });
    if (!user) return;
    const raw = await issueEmailToken(tx, user.id, 'RESET_PASSWORD');
    await enqueueEmail(tx, user.email, 'resetPassword', { displayName: user.displayName, link: link('/reset-password', raw) });
  });
}

export async function resetPassword(token: string, password: string): Promise<void> {
  const passwordHash = await hashPassword(password);
  const ok = await transaction(async (tx) => {
    const userId = await repo.consumeEmailToken(tx, sha256Hex(token), 'RESET_PASSWORD');
    if (!userId) return false;
    const user = await tx.user.update({
      where: { id: userId },
      // Le lien reçu par mail prouve aussi la possession de l'adresse.
      data: { passwordHash, failedLoginCount: 0, lockedUntil: null, tokensValidAfter: tokensCutoff(), emailVerifiedAt: new Date() },
    });
    await repo.revokeAllForUser(tx, userId);
    await repo.invalidateEmailTokens(tx, userId, 'RESET_PASSWORD');
    await enqueueEmail(tx, user.email, 'passwordChanged', { displayName: user.displayName });
    return true;
  });
  if (!ok) throw errors.validation([{ path: 'token', message: 'Lien invalide ou expiré.' }], 'Lien invalide ou expiré.');
}

export async function changePassword(userId: string, currentPassword: string, newPassword: string): Promise<void> {
  const user = await transaction((tx) => tx.user.findUnique({ where: { id: userId } }));
  if (!user || !(await verifyPassword(user.passwordHash, currentPassword))) throw errors.invalidCredentials();
  const passwordHash = await hashPassword(newPassword);
  await transaction(async (tx) => {
    await tx.user.update({ where: { id: userId }, data: { passwordHash, tokensValidAfter: tokensCutoff() } });
    await repo.revokeAllForUser(tx, userId);
    await enqueueEmail(tx, user.email, 'passwordChanged', { displayName: user.displayName });
  });
}

export function me(userId: string): Promise<UserView> {
  return loadUserView(userId);
}
