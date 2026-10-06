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

export const authHandlers = [
  route('post', '/auth/register', async ({ request }) => {
    const v = await readBody(request, ['email', 'password', 'displayName']);
    const email = v.email('email');
    const password = v.str('password', { min: 12, max: 128 });
    const displayName = v.str('displayName', { min: 1, max: 80 });
    v.done();
    const db = mock.db;
    if (email && password && displayName && !db.users.some((u) => u.email === norm(email))) {
      const user: MockUser = { id: crypto.randomUUID(), email: norm(email), password, displayName: displayName.trim(), emailVerified: false, isPlatformAdmin: false };
      db.users.push(user);
      const token = crypto.randomUUID();
      db.verifyTokens.set(token, user.id);
      mockOutbox.push({ to: user.email, kind: 'verify', token });
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
