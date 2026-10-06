import type { AuthSession } from '../../api/types';
import { currentUser, fail, json, mock, noContent, readBody, requireCsrf, route } from '../core';
import { toUser } from '../serializers';
import type { MockUser } from '../state';

/** Mails simulés (lien de vérification / réinitialisation), consultables en dev:mock et en test. */
export const mockOutbox: { to: string; kind: 'verify' | 'reset'; token: string }[] = [];

const GENERIC_202 = { message: 'Si cette adresse est valide, un email vient de vous être envoyé.' };

function issueSession(user: MockUser): AuthSession {
  const db = mock.db;
  const accessToken = `mock-at-${crypto.randomUUID()}`;
  db.accessTokens.set(accessToken, { userId: user.id, expiresAt: Date.now() + db.accessTtlSeconds * 1000 });
  db.refreshCookie = { token: crypto.randomUUID(), userId: user.id };
  return { accessToken, expiresIn: db.accessTtlSeconds, user: toUser(user) };
}

function revokeAll(userId: string): void {
  const db = mock.db;
  for (const [t, s] of db.accessTokens) if (s.userId === userId) db.accessTokens.delete(t);
  if (db.refreshCookie?.userId === userId) db.refreshCookie = null;
}

const norm = (email: string) => email.trim().toLowerCase();

/** Extrait de liste de mots de passe courants (le back utilise une liste complète). */
const COMMON_PASSWORDS = new Set(['motdepasse123', 'password1234', '123456789012', 'azertyuiop12', 'qwertyuiop12', 'motdepasse2026', 'bordeaux2026!']);

export const authHandlers = [
  route('post', '/auth/register', async ({ request }) => {
    const v = await readBody(request, ['email', 'password', 'displayName']);
    const email = v.str('email', { max: 254, pattern: /^[\x21-\x7e]+@[\x21-\x7e]+\.[\x21-\x7e]+$/ }); // ASCII uniquement (contrat v1.5)
    const password = v.str('password', { min: 12, max: 128 });
    const displayName = v.str('displayName', { min: 1, max: 80 });
    if (typeof password === 'string' && new TextEncoder().encode(password).length > 256) v.custom('password', 'Mot de passe trop long');
    if (typeof password === 'string' && COMMON_PASSWORDS.has(password.toLowerCase())) v.custom('password', 'Mot de passe trop courant');
    v.done();
    const db = mock.db;
    if (email && password && displayName) {
      const existing = db.users.find((u) => u.email === norm(email));
      if (!existing || !existing.emailVerified) {
        // Compte non vérifié existant : la dernière inscription gagne, les anciens liens sont invalidés.
        const user: MockUser = existing ?? { id: crypto.randomUUID(), email: norm(email), password, displayName: '', emailVerified: false, isPlatformAdmin: false };
        user.password = password;
        user.displayName = displayName.trim();
        if (!existing) db.users.push(user);
        for (const [t, uid] of db.verifyTokens) if (uid === user.id) db.verifyTokens.delete(t);
        const token = crypto.randomUUID();
        db.verifyTokens.set(token, user.id);
        mockOutbox.push({ to: user.email, kind: 'verify', token });
      }
    }
    return json(GENERIC_202, 202);
  }),

  route('post', '/auth/verify-email', async ({ request }) => {
    const v = await readBody(request, ['token']);
    const token = v.str('token', { min: 1, max: 256 });
    v.done();
    const userId = token ? mock.db.verifyTokens.get(token) : undefined;
    const user = mock.db.users.find((u) => u.id === userId);
    if (!user || !token) return fail(400, 'VALIDATION_ERROR', 'Lien invalide ou expiré', { fields: [{ path: 'token', message: 'Lien invalide ou expiré' }] });
    user.emailVerified = true;
    mock.db.verifyTokens.delete(token);
    revokeAll(user.id); // contrat v1.5 : toutes les sessions existantes sont révoquées
    return noContent();
  }),

  route('post', '/auth/resend-verification', async ({ request }) => {
    const v = await readBody(request, ['email']);
    const email = v.email('email');
    v.done();
    const user = mock.db.users.find((u) => u.email === norm(email ?? ''));
    if (user && !user.emailVerified) {
      const token = crypto.randomUUID();
      mock.db.verifyTokens.set(token, user.id);
      mockOutbox.push({ to: user.email, kind: 'verify', token });
    }
    return json(GENERIC_202, 202);
  }),

  route('post', '/auth/login', async ({ request }) => {
    const v = await readBody(request, ['email', 'password']);
    const email = v.str('email', { min: 1, max: 254 });
    const password = v.str('password', { min: 1, max: 128 });
    v.done();
    const user = mock.db.users.find((u) => u.email === norm(email ?? ''));
    if (!user || user.password !== password) return fail(401, 'INVALID_CREDENTIALS', 'Identifiants invalides');
    if (!user.emailVerified) return fail(403, 'EMAIL_NOT_VERIFIED', 'Email non vérifié'); // contrat v1.5 : aucune session créée
    return json(issueSession(user));
  }),

  route('post', '/auth/refresh', ({ request }) => {
    requireCsrf(request);
    const db = mock.db;
    const cookie = db.refreshCookie;
    if (!cookie) return fail(401, 'INVALID_REFRESH_TOKEN', 'Session expirée');
    const user = db.users.find((u) => u.id === cookie.userId);
    if (!user) return fail(401, 'INVALID_REFRESH_TOKEN', 'Session expirée');
    db.usedRefreshTokens.add(cookie.token); // rotation
    return json(issueSession(user));
  }),

  route('post', '/auth/logout', ({ request }) => {
    requireCsrf(request);
    const db = mock.db;
    const header = request.headers.get('Authorization');
    if (header?.startsWith('Bearer ')) db.accessTokens.delete(header.slice(7));
    db.refreshCookie = null;
    return noContent();
  }),

  route('post', '/auth/forgot-password', async ({ request }) => {
    const v = await readBody(request, ['email']);
    const email = v.email('email');
    v.done();
    const user = mock.db.users.find((u) => u.email === norm(email ?? ''));
    if (user) {
      const token = crypto.randomUUID();
      mock.db.resetTokens.set(token, user.id);
      mockOutbox.push({ to: user.email, kind: 'reset', token });
    }
    return json(GENERIC_202, 202);
  }),

  route('post', '/auth/reset-password', async ({ request }) => {
    const v = await readBody(request, ['token', 'password']);
    const token = v.str('token', { min: 1, max: 256 });
    const password = v.str('password', { min: 12, max: 128 });
    v.done();
    const userId = token ? mock.db.resetTokens.get(token) : undefined;
    const user = mock.db.users.find((u) => u.id === userId);
    if (!user || !token || !password) return fail(400, 'VALIDATION_ERROR', 'Lien invalide ou expiré', { fields: [{ path: 'token', message: 'Lien invalide ou expiré' }] });
    user.password = password;
    mock.db.resetTokens.delete(token);
    revokeAll(user.id);
    return noContent();
  }),

  route('post', '/auth/change-password', async ({ request }) => {
    const user = currentUser(request);
    const v = await readBody(request, ['currentPassword', 'newPassword']);
    const current = v.str('currentPassword', { min: 1, max: 128 });
    const next = v.str('newPassword', { min: 12, max: 128 });
    v.done();
    if (current !== user.password) return fail(401, 'INVALID_CREDENTIALS', 'Identifiants invalides');
    user.password = next ?? user.password;
    revokeAll(user.id);
    return noContent();
  }),

  route('get', '/auth/me', ({ request }) => json(toUser(currentUser(request)))),
];
