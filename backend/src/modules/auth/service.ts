import { randomUUID } from 'node:crypto';
import { getEnv } from '../../config/env.js';
import { transaction, type Tx } from '../../lib/db.js';
import { errors } from '../../lib/errors.js';
import { randomToken, sha256Hex } from '../../lib/crypto.js';
import { ACCESS_TOKEN_TTL_SECONDS, signAccessToken } from '../../lib/jwt.js';
import { enqueueEmail } from '../../lib/outbox.js';
import { addMinutes } from '../../lib/time.js';
import { withResponseFloor } from '../../lib/timing.js';
import { consumeQuota } from '../../lib/rateLimitStore.js';
import { getDummyHash, hashPassword, verifyPasswordHash } from '../../lib/password.js';
import { normalizePassword } from '../../lib/passwordPolicy.js';
import { normalizeEmail } from '../../lib/email.js';
import * as repo from './repo.js';

const DAY_MS = 24 * 60 * 60 * 1000;
export const REFRESH_TTL_MS = 30 * DAY_MS;
/** Durée de vie absolue d'une famille de refresh : reconnexion obligatoire au-delà. */
export const REFRESH_FAMILY_MAX_MS = 90 * DAY_MS;
/** Délai de grâce de rotation (réponse de refresh perdue sur réseau mobile). */
export const REFRESH_GRACE_MS = 10_000;
const EMAIL_TOKEN_TTL_MINUTES = 30;

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


/** À appeler au démarrage : précalcule le hash factice (la première requête n'est pas plus lente). */
export async function warmUpAuth(): Promise<void> {
  await getDummyHash();
}

function floor<T>(fn: () => Promise<T>): Promise<T> {
  return withResponseFloor(getEnv().authResponseFloorMs, fn);
}

/** Compteurs d'observabilité (exposés pour les tests : nombre d'évaluations réelles d'un mot de passe). */
export const authMetrics = { passwordVerifications: 0 };

const verifyPassword = verifyPasswordHash;

/** Évalue le mot de passe d'un compte réel, après réservation atomique d'une tentative. */
async function checkAccountPassword(user: { id: string; passwordHash: string }, password: string): Promise<boolean> {
  if (!(await repo.reserveLoginAttempt(user.id))) {
    // Compte verrouillé : aucune évaluation, mais même coût apparent qu'une vérification réelle.
    await verifyPassword(await getDummyHash(), password);
    return false;
  }
  authMetrics.passwordVerifications += 1;
  const valid = await verifyPassword(user.passwordHash, password);
  if (valid) await repo.recordLoginSuccess(user.id);
  return valid;
}

/** Plafonds PAR ADRESSE des mails d'authentification (silencieux côté réponse). */
export const MAIL_MIN_INTERVAL_MINUTES = 2;

/** Quotas par adresse email (en plus des quotas par IP), appliqués que le compte existe ou non. */
const QUOTA = {
  login: { windowMs: 15 * 60_000, max: 30 },
  mail: { windowMs: 60 * 60_000, max: 5 },
};
export const MAIL_MAX_PER_DAY = 10;

/**
 * Émet un jeton mail sous verrou de la ligne utilisateur (jamais deux liens actifs concurrents).
 * Retourne null si le plafond par adresse est atteint (1 mail / 2 min, 10 / 24 h) : rien n'est envoyé
 * et le jeton encore frais n'est PAS invalidé — un tiers ne peut ni bombarder la boîte de la victime,
 * ni annuler le lien de réinitialisation qu'elle vient de recevoir.
 */
async function issueEmailToken(
  tx: Tx, user: { id: string; email: string }, purpose: 'VERIFY_EMAIL' | 'RESET_PASSWORD',
): Promise<string | null> {
  await repo.lockUser(tx, user.id);
  const now = Date.now();
  const recent = await repo.countEmailTokensSince(tx, user.id, new Date(now - MAIL_MIN_INTERVAL_MINUTES * 60_000));
  const daily = await repo.countEmailTokensSince(tx, user.id, new Date(now - 24 * 60 * 60_000));
  if (recent > 0 || daily >= MAIL_MAX_PER_DAY) return null;
  const raw = randomToken(32);
  await repo.invalidateEmailTokens(tx, user.id, purpose);
  await repo.createEmailToken(tx, user.id, user.email, purpose, sha256Hex(raw), addMinutes(new Date(now), EMAIL_TOKEN_TTL_MINUTES));
  return raw;
}

function link(path: string, token: string): string {
  return `${getEnv().frontUrl}${path}?token=${encodeURIComponent(token)}`;
}

async function loadUser(userId: string): Promise<{ view: UserView; tokenVersion: number }> {
  const user = await repo.findUserWithMemberships(userId);
  if (!user) throw errors.unauthenticated();
  const view: UserView = {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    emailVerified: user.emailVerifiedAt !== null,
    isPlatformAdmin: user.isPlatformAdmin,
    memberships: user.memberships.map((m) => ({ orgId: m.organization.id, orgName: m.organization.name, orgSlug: m.organization.slug, role: m.role })),
  };
  return { view, tokenVersion: user.tokenVersion };
}

interface FamilyInfo {
  familyId: string;
  familyCreatedAt: Date;
  tokenVersion: number;
}

/** Émet un refresh token : expiration glissante de 30 jours, plafonnée par la fin de vie de la famille. */
async function createRefreshToken(tx: Tx, userId: string, family: FamilyInfo): Promise<{ id: string; raw: string }> {
  const raw = randomToken(32);
  const familyEnd = family.familyCreatedAt.getTime() + REFRESH_FAMILY_MAX_MS;
  const row = await tx.refreshToken.create({
    data: {
      userId,
      familyId: family.familyId,
      familyCreatedAt: family.familyCreatedAt,
      tokenVersion: family.tokenVersion,
      tokenHash: sha256Hex(raw),
      expiresAt: new Date(Math.min(Date.now() + REFRESH_TTL_MS, familyEnd)),
    },
    select: { id: true },
  });
  return { id: row.id, raw };
}

async function buildSession(userId: string, refreshToken: string): Promise<SessionResult> {
  const { view, tokenVersion } = await loadUser(userId);
  const accessToken = await signAccessToken(userId, tokenVersion);
  return { session: { accessToken, expiresIn: ACCESS_TOKEN_TTL_SECONDS, user: view }, refreshToken };
}

/**
 * Inscription : réponse identique que l'email existe ou non. Le hash du mot de passe est calculé
 * dans tous les cas (même coût).
 * - compte vérifié : mail « vous avez déjà un compte », rien d'autre ne change ;
 * - compte NON vérifié (anti pré-détournement) : la dernière inscription gagne — mot de passe et nom
 *   remplacés, anciens liens de vérification invalidés, sessions révoquées, nouveau lien envoyé.
 *   Un attaquant qui aurait inscrit l'adresse de sa victime perd tout accès dès qu'elle s'inscrit.
 */
export function register(input: { email: string; password: string; displayName: string }): Promise<void> {
  return floor(() => registerInner(input));
}

async function registerInner(input: { email: string; password: string; displayName: string }): Promise<void> {
  const email = normalizeEmail(input.email);
  await consumeQuota('acct:register', email, QUOTA.mail.windowMs, QUOTA.mail.max);
  const passwordHash = await hashPassword(input.password);
  const displayName = input.displayName.trim();
  if (displayName === '') throw errors.validation([{ path: 'displayName', message: '"displayName" est requis' }]);
  try {
    await transaction(async (tx) => {
      const existing = await tx.user.findUnique({ where: { email } });
      if (existing) {
        if (existing.emailVerifiedAt) {
          const raw = await issueEmailToken(tx, existing, 'RESET_PASSWORD');
          if (raw) await enqueueEmail(tx, existing.email, 'accountExists', { displayName: existing.displayName, resetLink: link('/reset-password', raw) });
        } else {
          await tx.user.update({
            where: { id: existing.id },
            data: { passwordHash, displayName, tokenVersion: { increment: 1 }, failedLoginCount: 0, lockedUntil: null, lastFailedLoginAt: null },
          });
          await repo.revokeAllForUser(tx, existing.id);
          // Les liens de l'inscription précédente ne doivent plus fonctionner, même si le plafond d'envoi
          // empêche d'en émettre un nouveau tout de suite (le renvoi reste possible après 2 min).
          await repo.invalidateEmailTokens(tx, existing.id, 'VERIFY_EMAIL');
          const raw = await issueEmailToken(tx, existing, 'VERIFY_EMAIL');
          if (raw) await enqueueEmail(tx, existing.email, 'verifyEmail', { displayName, link: link('/verify-email', raw) });
        }
        return;
      }
      const user = await tx.user.create({ data: { email, passwordHash, displayName } });
      const raw = await issueEmailToken(tx, user, 'VERIFY_EMAIL');
      if (raw) await enqueueEmail(tx, email, 'verifyEmail', { displayName, link: link('/verify-email', raw) });
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
    // Ceinture et bretelles : toute session ouverte avant la vérification est révoquée.
    await tx.user.update({ where: { id: userId }, data: { emailVerifiedAt: new Date(), tokenVersion: { increment: 1 } } });
    await repo.revokeAllForUser(tx, userId);
    return true;
  });
  if (!ok) throw errors.validation([{ path: 'token', message: 'Lien invalide ou expiré.' }], 'Lien invalide ou expiré.');
}

export function resendVerification(rawEmail: string): Promise<void> {
  return floor(() => resendVerificationInner(rawEmail));
}

async function resendVerificationInner(rawEmail: string): Promise<void> {
  const email = normalizeEmail(rawEmail);
  await consumeQuota('acct:resend', email, QUOTA.mail.windowMs, QUOTA.mail.max);
  await transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { email } });
    if (!user || user.emailVerifiedAt) return;
    const raw = await issueEmailToken(tx, user, 'VERIFY_EMAIL');
    if (raw) await enqueueEmail(tx, user.email, 'verifyEmail', { displayName: user.displayName, link: link('/verify-email', raw) });
  });
}

/**
 * Connexion : message unique pour email inconnu, mot de passe faux ou compte verrouillé ;
 * vérification argon2 systématique (hash factice si l'email est inconnu). Email non vérifié ⇒ 403
 * EMAIL_NOT_VERIFIED, seulement après un mot de passe correct.
 */
export async function login(rawEmail: string, password: string): Promise<SessionResult> {
  const email = normalizeEmail(rawEmail);
  await consumeQuota('acct:login', email, QUOTA.login.windowMs, QUOTA.login.max);
  const user = await repo.findUserByEmail(email);
  if (!user) {
    await verifyPassword(await getDummyHash(), password);
    throw errors.invalidCredentials();
  }
  if (!(await checkAccountPassword(user, password))) throw errors.invalidCredentials();
  // Email non vérifié : révélé UNIQUEMENT à qui connaît le mot de passe, et aucune session n'est créée.
  if (!user.emailVerifiedAt) throw errors.emailNotVerified();
  const refresh = await transaction(async (tx) => {
    // Version lue sous verrou : un reset de mot de passe concurrent ne peut pas laisser une session valide.
    const locked = await repo.lockUser(tx, user.id);
    if (!locked) throw errors.invalidCredentials();
    return createRefreshToken(tx, user.id, { familyId: randomUUID(), familyCreatedAt: new Date(), tokenVersion: locked.tokenVersion });
  });
  return buildSession(user.id, refresh.raw);
}

type RefreshOutcome = { ok: true; userId: string; raw: string } | { ok: false };

/**
 * Rotation du refresh token, sous verrous (utilisateur puis jeton) :
 * - jeton révoqué, expiré, famille de plus de 90 jours ou version ≠ User.tokenVersion ⇒ 401 ;
 * - jeton déjà remplacé : délai de grâce de 10 s si le successeur n'a JAMAIS servi (réponse perdue) —
 *   le successeur est révoqué et une nouvelle paire est émise dans la même famille ; sinon c'est une
 *   réutilisation (vol probable) ⇒ toute la famille est révoquée.
 */
export async function refresh(rawToken: string | undefined): Promise<SessionResult> {
  if (!rawToken || !/^[A-Za-z0-9_-]{43}$/.test(rawToken)) throw errors.invalidRefreshToken();
  const tokenHash = sha256Hex(rawToken);
  const outcome = await transaction(async (tx): Promise<RefreshOutcome> => {
    const ownerId = await repo.refreshOwner(tx, tokenHash);
    if (!ownerId) return { ok: false };
    const user = await repo.lockUser(tx, ownerId);
    const row = await repo.lockRefreshToken(tx, tokenHash);
    if (!user || !row) return { ok: false };
    // Révoqué : déconnexion, changement de mot de passe, réutilisation, ou successeur supplanté pendant la grâce.
    if (row.revokedAt !== null) return { ok: false };
    const now = Date.now();
    if (
      row.expiresAt.getTime() <= now
      || row.familyCreatedAt.getTime() + REFRESH_FAMILY_MAX_MS <= now
      || row.tokenVersion !== user.tokenVersion
    ) {
      await repo.revokeFamily(tx, row.familyId);
      return { ok: false };
    }
    const family: FamilyInfo = { familyId: row.familyId, familyCreatedAt: row.familyCreatedAt, tokenVersion: row.tokenVersion };
    if (row.replacedById !== null) {
      const successor = await repo.lockRefreshTokenById(tx, row.replacedById);
      const withinGrace = row.rotatedAt !== null && now - row.rotatedAt.getTime() <= REFRESH_GRACE_MS;
      const successorUnused = successor !== null && successor.revokedAt === null && successor.replacedById === null;
      if (!withinGrace || !successorUnused) {
        await repo.revokeFamily(tx, row.familyId);
        return { ok: false };
      }
      await tx.refreshToken.update({ where: { id: successor.id }, data: { revokedAt: new Date() } });
      const next = await createRefreshToken(tx, row.userId, family);
      // rotatedAt inchangé : la grâce reste bornée à 10 s après la première rotation.
      await tx.refreshToken.update({ where: { id: row.id }, data: { replacedById: next.id } });
      return { ok: true, userId: row.userId, raw: next.raw };
    }
    const next = await createRefreshToken(tx, row.userId, family);
    await tx.refreshToken.update({ where: { id: row.id }, data: { replacedById: next.id, rotatedAt: new Date() } });
    return { ok: true, userId: row.userId, raw: next.raw };
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

export function forgotPassword(rawEmail: string): Promise<void> {
  return floor(() => forgotPasswordInner(rawEmail));
}

async function forgotPasswordInner(rawEmail: string): Promise<void> {
  const email = normalizeEmail(rawEmail);
  await consumeQuota('acct:forgot', email, QUOTA.mail.windowMs, QUOTA.mail.max);
  await transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { email } });
    if (!user) return;
    const raw = await issueEmailToken(tx, user, 'RESET_PASSWORD');
    if (raw) await enqueueEmail(tx, user.email, 'resetPassword', { displayName: user.displayName, link: link('/reset-password', raw) });
  });
}

export async function resetPassword(token: string, password: string): Promise<void> {
  const invalid = () => errors.validation([{ path: 'token', message: 'Lien invalide ou expiré.' }], 'Lien invalide ou expiré.');
  // Jeton vérifié AVANT le calcul argon2 : un jeton bidon ne coûte rien au serveur.
  if (!(await repo.isEmailTokenUsable(sha256Hex(token), 'RESET_PASSWORD'))) throw invalid();
  const passwordHash = await hashPassword(password);
  const ok = await transaction(async (tx) => {
    const userId = await repo.consumeEmailToken(tx, sha256Hex(token), 'RESET_PASSWORD');
    if (!userId) return false;
    const user = await tx.user.update({
      where: { id: userId },
      // Le lien reçu par mail prouve aussi la possession de l'adresse.
      data: { passwordHash, failedLoginCount: 0, lockedUntil: null, lastFailedLoginAt: null, tokenVersion: { increment: 1 }, emailVerifiedAt: new Date() },
    });
    await repo.revokeAllForUser(tx, userId);
    await repo.invalidateEmailTokens(tx, userId, 'RESET_PASSWORD');
    await enqueueEmail(tx, user.email, 'passwordChanged', { displayName: user.displayName });
    return true;
  });
  // Jeton consommé entre-temps par une requête concurrente : la consommation gardée fait foi.
  if (!ok) throw invalid();
}

export async function changePassword(userId: string, currentPassword: string, newPassword: string): Promise<void> {
  if (normalizePassword(newPassword) === normalizePassword(currentPassword)) {
    throw errors.validation([{ path: 'newPassword', message: 'Le nouveau mot de passe doit être différent de l’actuel.' }]);
  }
  const user = await transaction((tx) => tx.user.findUnique({ where: { id: userId } }));
  // Même compteur et même verrou que la connexion : pas de force brute via une session volée.
  if (!user || !(await checkAccountPassword(user, currentPassword))) throw errors.invalidCredentials();
  const passwordHash = await hashPassword(newPassword);
  await transaction(async (tx) => {
    await tx.user.update({ where: { id: userId }, data: { passwordHash, tokenVersion: { increment: 1 } } });
    await repo.revokeAllForUser(tx, userId);
    await enqueueEmail(tx, user.email, 'passwordChanged', { displayName: user.displayName });
  });
}

export async function me(userId: string): Promise<UserView> {
  return (await loadUser(userId)).view;
}
