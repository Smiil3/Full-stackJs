import { describe, expect, it } from 'vitest';
import { SignJWT, UnsecuredJWT } from 'jose';
import supertest from 'supertest';
import { createApp } from '../../src/app.js';
import { authMetrics } from '../../src/modules/auth/service.js';
import { getDb } from '../../src/lib/db.js';
import { api, createUser, csrfHeaders, lastMail, login, loggedInUser, PASSWORD, refreshCookieOf, tokenFromMail } from '../helpers.js';

const A = '/api/v1/auth';

function expectNoSecrets(body: unknown): void {
  const raw = JSON.stringify(body);
  expect(raw).not.toMatch(/passwordHash|argon2|tokenHash|failedLoginCount|lockedUntil/);
}

describe('inscription et vérification d’email', () => {
  it('réponse identique que l’email existe ou non (anti-énumération)', async () => {
    const fresh = await api().post(`${A}/register`).send({ email: 'nouveau@test.fr', password: PASSWORD, displayName: 'Nouveau' });
    await createUser({ email: 'existant@test.fr' });
    const dup = await api().post(`${A}/register`).send({ email: 'Existant@Test.fr', password: PASSWORD, displayName: 'Autre' });
    expect(fresh.status).toBe(202);
    expect(dup.status).toBe(202);
    expect(dup.body).toEqual(fresh.body);
    expectNoSecrets(fresh.body);
    // Le compte existant reçoit un mail d'avertissement, aucun doublon n'est créé.
    expect(await lastMail('existant@test.fr', 'accountExists')).not.toBeNull();
    expect(await getDb().user.count({ where: { email: 'existant@test.fr' } })).toBe(1);
  });

  it('email normalisé et mot de passe hashé en argon2id', async () => {
    await api().post(`${A}/register`).send({ email: 'Camille@Exemple.FR', password: PASSWORD, displayName: 'Camille' }).expect(202);
    const user = await getDb().user.findUniqueOrThrow({ where: { email: 'camille@exemple.fr' } });
    expect(user.passwordHash.startsWith('$argon2id$')).toBe(true);
    expect(user.emailVerifiedAt).toBeNull();
  });

  it('refuse un mot de passe hors 12–128 caractères et les champs inconnus', async () => {
    const short = await api().post(`${A}/register`).send({ email: 'a@test.fr', password: 'court', displayName: 'A' });
    expect(short.status).toBe(400);
    const long = await api().post(`${A}/register`).send({ email: 'a@test.fr', password: 'x'.repeat(129), displayName: 'A' });
    expect(long.status).toBe(400);
    const extra = await api().post(`${A}/register`).send({ email: 'a@test.fr', password: PASSWORD, displayName: 'A', isPlatformAdmin: true });
    expect(extra.status).toBe(400);
    expect(extra.body.error.details.fields[0].path).toBe('isPlatformAdmin');
  });

  it('vérification : jeton à usage unique, stocké hashé', async () => {
    await api().post(`${A}/register`).send({ email: 'v@test.fr', password: PASSWORD, displayName: 'V' }).expect(202);
    const token = await tokenFromMail('v@test.fr', 'verifyEmail');
    const stored = await getDb().emailToken.findMany();
    expect(stored.every((t) => t.tokenHash !== token && t.tokenHash.length === 64)).toBe(true);
    await api().post(`${A}/verify-email`).send({ token }).expect(204);
    const again = await api().post(`${A}/verify-email`).send({ token });
    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe('VALIDATION_ERROR');
    const user = await getDb().user.findUniqueOrThrow({ where: { email: 'v@test.fr' } });
    expect(user.emailVerifiedAt).not.toBeNull();
  });

  it('vérification : jeton expiré refusé', async () => {
    await api().post(`${A}/register`).send({ email: 'exp@test.fr', password: PASSWORD, displayName: 'E' }).expect(202);
    const token = await tokenFromMail('exp@test.fr', 'verifyEmail');
    await getDb().emailToken.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    await api().post(`${A}/verify-email`).send({ token }).expect(400);
  });

  it('renvoi de vérification : 202 toujours, l’ancien lien est invalidé', async () => {
    await api().post(`${A}/register`).send({ email: 'r@test.fr', password: PASSWORD, displayName: 'R' }).expect(202);
    const first = await tokenFromMail('r@test.fr', 'verifyEmail');
    const a = await api().post(`${A}/resend-verification`).send({ email: 'r@test.fr' });
    const b = await api().post(`${A}/resend-verification`).send({ email: 'inconnu@test.fr' });
    expect(a.status).toBe(202);
    expect(b.status).toBe(202);
    expect(a.body).toEqual(b.body);
    await api().post(`${A}/verify-email`).send({ token: first }).expect(400);
    await api().post(`${A}/verify-email`).send({ token: await tokenFromMail('r@test.fr', 'verifyEmail') }).expect(204);
  });
});

describe('connexion', () => {
  it('renvoie une AuthSession conforme et un cookie de refresh durci', async () => {
    const user = await createUser({ email: 'login@test.fr' });
    const res = await api().post(`${A}/login`).send({ email: 'LOGIN@test.fr', password: PASSWORD }).expect(200);
    expect(res.body).toEqual({
      accessToken: expect.any(String),
      expiresIn: 600,
      user: { id: user.id, email: 'login@test.fr', displayName: 'Jean Test', emailVerified: true, isPlatformAdmin: false, memberships: [] },
    });
    expectNoSecrets(res.body);
    const cookie = (res.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('nuits_rt='))!;
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect(cookie).toMatch(/Path=\/api\/v1\/auth/);
    expect(cookie).toMatch(/Max-Age=2592000/);
    // Le refresh token est stocké hashé.
    const raw = refreshCookieOf(res).split('=')[1]!;
    expect(await getDb().refreshToken.count({ where: { tokenHash: raw } })).toBe(0);
  });

  it('échec générique : même réponse pour email inconnu et mauvais mot de passe', async () => {
    await createUser({ email: 'known@test.fr' });
    const wrong = await api().post(`${A}/login`).send({ email: 'known@test.fr', password: 'mauvais-mot-de-passe' });
    const unknown = await api().post(`${A}/login`).send({ email: 'unknown@test.fr', password: 'mauvais-mot-de-passe' });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body).toEqual(unknown.body);
    expect(wrong.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('verrouillage progressif après 5 échecs, même avec le bon mot de passe', async () => {
    const user = await createUser({ email: 'lock@test.fr' });
    for (let i = 0; i < 5; i += 1) {
      await api().post(`${A}/login`).send({ email: user.email, password: 'mauvais-mot-de-passe' }).expect(401);
    }
    const locked = await getDb().user.findUniqueOrThrow({ where: { id: user.id } });
    expect(locked.failedLoginCount).toBe(5);
    expect(locked.lockedUntil!.getTime()).toBeGreaterThan(Date.now() + 50_000);
    const res = await api().post(`${A}/login`).send({ email: user.email, password: PASSWORD });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
    // 6e échec : verrou doublé (2 min).
    await getDb().user.update({ where: { id: user.id }, data: { lockedUntil: new Date(Date.now() - 1000) } });
    await api().post(`${A}/login`).send({ email: user.email, password: 'mauvais-mot-de-passe' }).expect(401);
    const relocked = await getDb().user.findUniqueOrThrow({ where: { id: user.id } });
    expect(relocked.lockedUntil!.getTime()).toBeGreaterThan(Date.now() + 110_000);
    // Verrou levé : connexion réussie et compteur remis à zéro.
    await getDb().user.update({ where: { id: user.id }, data: { lockedUntil: new Date(Date.now() - 1000) } });
    await api().post(`${A}/login`).send({ email: user.email, password: PASSWORD }).expect(200);
    const reset = await getDb().user.findUniqueOrThrow({ where: { id: user.id } });
    expect(reset.failedLoginCount).toBe(0);
    expect(reset.lockedUntil).toBeNull();
  });

  it('rafale de 20 logins parallèles faux ⇒ au plus 5 évaluations du mot de passe (B2.1 M4)', async () => {
    const user = await createUser({ email: 'burst@test.fr' });
    const before = authMetrics.passwordVerifications;
    const results = await Promise.all(
      Array.from({ length: 20 }, () => api().post(`${A}/login`).send({ email: user.email, password: 'mauvais-mot-de-passe' })),
    );
    expect(results.every((r) => r.status === 401)).toBe(true);
    expect(authMetrics.passwordVerifications - before).toBeLessThanOrEqual(5);
    // Compte verrouillé : même le bon mot de passe est refusé sans évaluation.
    const mid = authMetrics.passwordVerifications;
    await api().post(`${A}/login`).send({ email: user.email, password: PASSWORD }).expect(401);
    expect(authMetrics.passwordVerifications).toBe(mid);
  });

  it('fenêtre glissante : le compteur repart de zéro après 15 min sans échec (B2.1 M4)', async () => {
    const user = await createUser({ email: 'window@test.fr' });
    for (let i = 0; i < 4; i += 1) await api().post(`${A}/login`).send({ email: user.email, password: 'mauvais-mot-de-passe' }).expect(401);
    await getDb().user.update({ where: { id: user.id }, data: { lastFailedLoginAt: new Date(Date.now() - 16 * 60_000) } });
    await api().post(`${A}/login`).send({ email: user.email, password: 'mauvais-mot-de-passe' }).expect(401);
    const after = await getDb().user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.failedLoginCount).toBe(1);
    expect(after.lockedUntil).toBeNull();
  });

  it('verrou plafonné à 15 minutes (B2.1 M4)', async () => {
    const user = await createUser({ email: 'cap@test.fr' });
    await getDb().user.update({ where: { id: user.id }, data: { failedLoginCount: 30, lastFailedLoginAt: new Date(), lockedUntil: new Date(Date.now() - 1000) } });
    await api().post(`${A}/login`).send({ email: user.email, password: 'mauvais-mot-de-passe' }).expect(401);
    const after = await getDb().user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.lockedUntil!.getTime()).toBeLessThanOrEqual(Date.now() + 15 * 60_000 + 1000);
    expect(after.lockedUntil!.getTime()).toBeGreaterThan(Date.now() + 14 * 60_000);
  });

  it('change-password partage compteur et verrou (B2.1 M4)', async () => {
    const u = await loggedInUser();
    for (let i = 0; i < 5; i += 1) {
      await api().post(`${A}/change-password`).set(u.auth).send({ currentPassword: 'faux-mot-de-passe', newPassword: 'nouveau-mot-de-passe-42' }).expect(401);
    }
    // Verrouillé : le bon mot de passe actuel est refusé, et la connexion aussi.
    await api().post(`${A}/change-password`).set(u.auth).send({ currentPassword: PASSWORD, newPassword: 'nouveau-mot-de-passe-42' }).expect(401);
    await api().post(`${A}/login`).send({ email: u.email, password: PASSWORD }).expect(401);
  });

  it('rate limiting sur le login ⇒ 429 RATE_LIMITED avec Retry-After', async () => {
    const strict = supertest(createApp({ rateLimitMultiplier: 0.25 })); // plafond 5 / 15 min
    for (let i = 0; i < 5; i += 1) await strict.post(`${A}/login`).send({ email: 'x@test.fr', password: 'y' });
    const res = await strict.post(`${A}/login`).send({ email: 'x@test.fr', password: 'y' });
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('RATE_LIMITED');
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
  });
});

describe('refresh token rotatif', () => {
  it('rotation : nouveau cookie, l’ancien devient inutilisable', async () => {
    const u = await loggedInUser();
    const r1 = await api().post(`${A}/refresh`).set(csrfHeaders).set('Cookie', u.cookie).expect(200);
    expect(r1.body.user.id).toBe(u.id);
    const c2 = refreshCookieOf(r1);
    expect(c2).not.toBe(u.cookie);
    await api().post(`${A}/refresh`).set(csrfHeaders).set('Cookie', c2).expect(200);
  });

  it('réutilisation d’un ancien refresh token dont le successeur a servi ⇒ toute la famille révoquée', async () => {
    const u = await loggedInUser();
    const r1 = await api().post(`${A}/refresh`).set(csrfHeaders).set('Cookie', u.cookie).expect(200);
    const r2 = await api().post(`${A}/refresh`).set(csrfHeaders).set('Cookie', refreshCookieOf(r1)).expect(200);
    // L'attaquant rejoue le jeton volé (son successeur a déjà été utilisé) : pas de grâce.
    const replay = await api().post(`${A}/refresh`).set(csrfHeaders).set('Cookie', u.cookie);
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe('INVALID_REFRESH_TOKEN');
    // Le jeton légitime le plus récent est lui aussi révoqué.
    await api().post(`${A}/refresh`).set(csrfHeaders).set('Cookie', refreshCookieOf(r2)).expect(401);
    expect(await getDb().refreshToken.count({ where: { userId: u.id, revokedAt: null } })).toBe(0);
  });

  it('rejeu après le délai de grâce de 10 s ⇒ famille révoquée (B2.1 M1)', async () => {
    const u = await loggedInUser();
    const r1 = await api().post(`${A}/refresh`).set(csrfHeaders).set('Cookie', u.cookie).expect(200);
    await getDb().refreshToken.updateMany({ where: { userId: u.id, rotatedAt: { not: null } }, data: { rotatedAt: new Date(Date.now() - 10_001) } });
    await api().post(`${A}/refresh`).set(csrfHeaders).set('Cookie', u.cookie).expect(401);
    await api().post(`${A}/refresh`).set(csrfHeaders).set('Cookie', refreshCookieOf(r1)).expect(401);
  });

  it('réponse de refresh perdue : rejeu dans les 10 s ⇒ nouvelle session, l’ancien successeur est supplanté (B2.1 M1)', async () => {
    const u = await loggedInUser();
    const lost = await api().post(`${A}/refresh`).set(csrfHeaders).set('Cookie', u.cookie).expect(200);
    const retry = await api().post(`${A}/refresh`).set(csrfHeaders).set('Cookie', u.cookie).expect(200);
    // Le successeur perdu ne sert plus, sans pour autant tuer la famille…
    await api().post(`${A}/refresh`).set(csrfHeaders).set('Cookie', refreshCookieOf(lost)).expect(401);
    // … et la chaîne obtenue au rejeu continue de fonctionner.
    await api().post(`${A}/refresh`).set(csrfHeaders).set('Cookie', refreshCookieOf(retry)).expect(200);
  });

  it('deux refresh concurrents avec le même jeton : les deux obtiennent une session, une seule chaîne survit (B2.1 M1)', async () => {
    const u = await loggedInUser();
    const [a, b] = await Promise.all([
      api().post(`${A}/refresh`).set(csrfHeaders).set('Cookie', u.cookie),
      api().post(`${A}/refresh`).set(csrfHeaders).set('Cookie', u.cookie),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    await api().get(`${A}/me`).set('Authorization', `Bearer ${a.body.accessToken as string}`).expect(200);
    await api().get(`${A}/me`).set('Authorization', `Bearer ${b.body.accessToken as string}`).expect(200);
    // Un seul des deux cookies reste utilisable, et l'autre ne révoque pas la famille.
    const statuses: number[] = [];
    for (const r of [a, b]) statuses.push((await api().post(`${A}/refresh`).set(csrfHeaders).set('Cookie', refreshCookieOf(r))).status);
    expect(statuses.sort()).toEqual([200, 401]);
    expect(await getDb().refreshToken.count({ where: { userId: u.id, revokedAt: null, replacedById: null } })).toBe(1);
  });

  it('famille de plus de 90 jours ⇒ reconnexion obligatoire (B2.1 M3)', async () => {
    const u = await loggedInUser();
    await getDb().refreshToken.updateMany({ where: { userId: u.id }, data: { familyCreatedAt: new Date(Date.now() - 90 * 24 * 3600 * 1000 - 1000) } });
    await api().post(`${A}/refresh`).set(csrfHeaders).set('Cookie', u.cookie).expect(401);
    expect(await getDb().refreshToken.count({ where: { userId: u.id, revokedAt: null } })).toBe(0);
  });

  it('l’expiration glissante ne dépasse jamais la fin de vie de la famille (B2.1 M3)', async () => {
    const u = await loggedInUser();
    const familyStart = new Date(Date.now() - 80 * 24 * 3600 * 1000);
    await getDb().refreshToken.updateMany({ where: { userId: u.id }, data: { familyCreatedAt: familyStart } });
    await api().post(`${A}/refresh`).set(csrfHeaders).set('Cookie', u.cookie).expect(200);
    const live = await getDb().refreshToken.findFirstOrThrow({ where: { userId: u.id, revokedAt: null, replacedById: null } });
    expect(live.expiresAt.getTime()).toBeLessThanOrEqual(familyStart.getTime() + 90 * 24 * 3600 * 1000);
    expect(live.familyCreatedAt.getTime()).toBe(familyStart.getTime());
  });

  it('reset de mot de passe et refresh concurrents : aucune session ne survit (B2.1 M2)', async () => {
    const u = await loggedInUser({ email: 'race@test.fr' });
    await api().post(`${A}/forgot-password`).send({ email: u.email }).expect(202);
    const token = await tokenFromMail(u.email, 'resetPassword');
    const [refreshRes] = await Promise.all([
      api().post(`${A}/refresh`).set(csrfHeaders).set('Cookie', u.cookie),
      api().post(`${A}/reset-password`).send({ token, password: 'nouveau-mot-de-passe-42' }).expect(204),
    ]);
    if (refreshRes.status === 200) {
      // Le refresh est passé avant le reset : sa session est quand même invalidée.
      await api().get(`${A}/me`).set('Authorization', `Bearer ${refreshRes.body.accessToken as string}`).expect(401);
      await api().post(`${A}/refresh`).set(csrfHeaders).set('Cookie', refreshCookieOf(refreshRes)).expect(401);
    }
    expect(await getDb().refreshToken.count({ where: { userId: u.id, revokedAt: null } })).toBe(0);
  });

  it('cookie effacé seulement sur 401, pas sur un refus CSRF', async () => {
    const u = await loggedInUser();
    const csrf = await api().post(`${A}/refresh`).set('Origin', csrfHeaders.Origin).set('Cookie', u.cookie).expect(403);
    expect(csrf.headers['set-cookie']).toBeUndefined();
    const unauth = await api().post(`${A}/refresh`).set(csrfHeaders).set('Cookie', 'nuits_rt=' + 'z'.repeat(43)).expect(401);
    expect(String(unauth.headers['set-cookie'])).toMatch(/nuits_rt=;/);
  });

  it('jeton expiré, inconnu ou absent ⇒ 401', async () => {
    const u = await loggedInUser();
    await getDb().refreshToken.updateMany({ where: { userId: u.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await api().post(`${A}/refresh`).set(csrfHeaders).set('Cookie', u.cookie).expect(401);
    await api().post(`${A}/refresh`).set(csrfHeaders).set('Cookie', 'nuits_rt=' + 'a'.repeat(43)).expect(401);
    await api().post(`${A}/refresh`).set(csrfHeaders).expect(401);
  });

  it('anti-CSRF : en-tête X-Requested-With et Origin autorisée obligatoires', async () => {
    const u = await loggedInUser();
    const noHeader = await api().post(`${A}/refresh`).set('Origin', csrfHeaders.Origin).set('Cookie', u.cookie);
    expect(noHeader.status).toBe(403);
    expect(noHeader.body.error.code).toBe('CSRF_CHECK_FAILED');
    const badOrigin = await api().post(`${A}/refresh`).set({ ...csrfHeaders, Origin: 'https://evil.example' }).set('Cookie', u.cookie);
    expect(badOrigin.status).toBe(403);
    const noOrigin = await api().post(`${A}/refresh`).set('X-Requested-With', 'nuits-web').set('Cookie', u.cookie);
    expect(noOrigin.status).toBe(403);
    const logout = await api().post(`${A}/logout`).set('X-Requested-With', 'nuits-web').set('Cookie', u.cookie);
    expect(logout.status).toBe(403);
    // Le jeton n'a pas été consommé par les tentatives refusées.
    await api().post(`${A}/refresh`).set(csrfHeaders).set('Cookie', u.cookie).expect(200);
  });

  it('logout : 204, cookie effacé, famille révoquée', async () => {
    const u = await loggedInUser();
    const res = await api().post(`${A}/logout`).set(csrfHeaders).set('Cookie', u.cookie).expect(204);
    expect(String(res.headers['set-cookie'])).toMatch(/nuits_rt=;/);
    await api().post(`${A}/refresh`).set(csrfHeaders).set('Cookie', u.cookie).expect(401);
  });
});

describe('access token JWT', () => {
  const secret = () => new TextEncoder().encode(process.env['JWT_ACCESS_SECRET']);
  const forge = (sub: string, opts: { alg?: string; aud?: string; iss?: string; exp?: string | number; ver?: unknown } = {}) =>
    new SignJWT(opts.ver === undefined ? { ver: 0 } : { ver: opts.ver })
      .setProtectedHeader({ alg: opts.alg ?? 'HS256' })
      .setSubject(sub)
      .setJti('11111111-1111-4111-8111-111111111111')
      .setIssuedAt()
      .setIssuer(opts.iss ?? 'nuits-api')
      .setAudience(opts.aud ?? 'nuits-web')
      .setExpirationTime(opts.exp ?? '10m')
      .sign(secret());

  it('jeton valide accepté ; payload limité à sub, jti et claims standard', async () => {
    const u = await loggedInUser();
    const payload = JSON.parse(Buffer.from(u.token.split('.')[1]!, 'base64url').toString()) as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(['aud', 'exp', 'iat', 'iss', 'jti', 'sub', 'ver']);
    const header = JSON.parse(Buffer.from(u.token.split('.')[0]!, 'base64url').toString()) as Record<string, unknown>;
    expect(header['alg']).toBe('HS256');
    const me = await api().get(`${A}/me`).set(u.auth).expect(200);
    expect(me.body.id).toBe(u.id);
    expectNoSecrets(me.body);
  });

  it('refuse alg:none, un autre algorithme, mauvaise audience / émetteur, expiré, altéré', async () => {
    const u = await createUser();
    const none = new UnsecuredJWT({}).setSubject(u.id).setJti('x').setIssuedAt().setIssuer('nuits-api').setAudience('nuits-web').setExpirationTime('10m').encode();
    const cases = [
      none,
      await forge(u.id, { alg: 'HS512' }),
      await forge(u.id, { aud: 'autre-app' }),
      await forge(u.id, { iss: 'autre-emetteur' }),
      await forge(u.id, { exp: Math.floor(Date.now() / 1000) - 60 }),
      (await forge(u.id)).slice(0, -3) + 'abc',
      await forge(u.id, { ver: 1 }),
      await forge(u.id, { ver: '0' }),
      await forge(u.id, { ver: null }),
      'pas-un-jwt',
    ];
    for (const token of cases) {
      const res = await api().get(`${A}/me`).set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
    }
    // Contrôle : le même forgeur avec les bons paramètres est accepté.
    await api().get(`${A}/me`).set('Authorization', `Bearer ${await forge(u.id)}`).expect(200);
  });

  it('jeton d’un utilisateur supprimé ⇒ 401', async () => {
    const u = await loggedInUser();
    await getDb().refreshToken.deleteMany({ where: { userId: u.id } });
    await getDb().user.delete({ where: { id: u.id } });
    await api().get(`${A}/me`).set(u.auth).expect(401);
  });

  it('sans en-tête Authorization ⇒ 401 UNAUTHENTICATED', async () => {
    const res = await api().get(`${A}/me`).expect(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });
});

describe('mot de passe oublié / changement', () => {
  it('forgot-password : 202 identique pour un email connu ou inconnu', async () => {
    await createUser({ email: 'f@test.fr' });
    const a = await api().post(`${A}/forgot-password`).send({ email: 'f@test.fr' });
    const b = await api().post(`${A}/forgot-password`).send({ email: 'nobody@test.fr' });
    expect(a.status).toBe(202);
    expect(b.status).toBe(202);
    expect(a.body).toEqual(b.body);
    expect(await lastMail('nobody@test.fr', 'resetPassword')).toBeNull();
  });

  it('reset : jeton à usage unique, toutes les sessions révoquées', async () => {
    const u = await loggedInUser({ email: 'reset@test.fr' });
    await api().post(`${A}/forgot-password`).send({ email: u.email }).expect(202);
    const token = await tokenFromMail(u.email, 'resetPassword');
    await api().post(`${A}/reset-password`).send({ token, password: 'nouveau-mot-de-passe-42' }).expect(204);
    await api().post(`${A}/reset-password`).send({ token, password: 'encore-un-autre-mdp-43' }).expect(400);
    await api().post(`${A}/refresh`).set(csrfHeaders).set('Cookie', u.cookie).expect(401);
    await api().get(`${A}/me`).set(u.auth).expect(401);
    await api().post(`${A}/login`).send({ email: u.email, password: PASSWORD }).expect(401);
    await login(u, 'nouveau-mot-de-passe-42');
  });

  it('reset : un jeton de vérification d’email ne permet pas de réinitialiser', async () => {
    await api().post(`${A}/register`).send({ email: 'mix@test.fr', password: PASSWORD, displayName: 'M' }).expect(202);
    const verifyToken = await tokenFromMail('mix@test.fr', 'verifyEmail');
    await api().post(`${A}/reset-password`).send({ token: verifyToken, password: 'nouveau-mot-de-passe-42' }).expect(400);
  });

  it('change-password : mauvais mot de passe actuel ⇒ 401 INVALID_CREDENTIALS', async () => {
    const u = await loggedInUser();
    const res = await api().post(`${A}/change-password`).set(u.auth).send({ currentPassword: 'faux-mot-de-passe', newPassword: 'nouveau-mot-de-passe-42' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('tokenVersion : jeton émis juste avant un change-password (même seconde) ⇒ 401', async () => {
    const u = await loggedInUser();
    const second = await login(u);
    const before = Math.floor(Date.now() / 1000);
    await api().post(`${A}/change-password`).set(u.auth).send({ currentPassword: PASSWORD, newPassword: 'nouveau-mot-de-passe-42' }).expect(204);
    const res = await api().get(`${A}/me`).set(second.auth);
    expect(res.status).toBe(401);
    // Le scénario se joue bien dans la même seconde (ou la suivante au pire) : la version, pas l'horloge, fait foi.
    expect(Math.floor(Date.now() / 1000) - before).toBeLessThanOrEqual(1);
    const fresh = await login(u, 'nouveau-mot-de-passe-42');
    await api().get(`${A}/me`).set(fresh.auth).expect(200);
  });

  it('change-password : 204, cookie effacé, sessions et access tokens révoqués', async () => {
    const u = await loggedInUser();
    // Aucune attente : un jeton émis dans la même seconde que le changement doit être refusé.
    const res = await api().post(`${A}/change-password`).set(u.auth).send({ currentPassword: PASSWORD, newPassword: 'nouveau-mot-de-passe-42' }).expect(204);
    expect(String(res.headers['set-cookie'])).toMatch(/nuits_rt=;/);
    await api().get(`${A}/me`).set(u.auth).expect(401);
    await api().post(`${A}/refresh`).set(csrfHeaders).set('Cookie', u.cookie).expect(401);
    expect(await lastMail(u.email, 'passwordChanged')).not.toBeNull();
    await login(u, 'nouveau-mot-de-passe-42');
  });
});

describe('unicité de l’email insensible à la casse (B1.1 M6)', () => {
  it('A@x.com puis a@x.com ⇒ un seul compte', async () => {
    await api().post(`${A}/register`).send({ email: 'Casse@Exemple.com', password: PASSWORD, displayName: 'A' }).expect(202);
    await api().post(`${A}/register`).send({ email: 'casse@exemple.com', password: PASSWORD, displayName: 'B' }).expect(202);
    await api().post(`${A}/register`).send({ email: 'CASSE@EXEMPLE.COM', password: PASSWORD, displayName: 'C' }).expect(202);
    expect(await getDb().user.count()).toBe(1);
  });

  it('la base refuse un doublon de casse ou une adresse non normalisée, même en écriture directe', async () => {
    await createUser({ email: 'direct@exemple.com' });
    await expect(createUser({ email: 'Direct@Exemple.com' })).rejects.toThrow();
    await expect(createUser({ email: ' autre@exemple.com' })).rejects.toThrow();
  });

  it('connexion avec une casse ou une forme Unicode différente', async () => {
    // « é » composé (NFC) en base, saisi décomposé (NFD) à la connexion.
    await createUser({ email: 'andré@exemple.com' });
    await api().post(`${A}/login`).send({ email: 'ANDRÉ@exemple.com'.normalize('NFD'), password: PASSWORD }).expect(200);
  });
});

describe('pré-détournement de compte (B2.1 H1)', () => {
  const VICTIM = 'victime@test.fr';
  const ATTACKER_PWD = 'mot-de-passe-attaquant-1';
  const VICTIM_PWD = 'mot-de-passe-victime-42';

  it('login d’un compte non vérifié : 403 seulement avec le bon mot de passe, jamais de session', async () => {
    await api().post(`${A}/register`).send({ email: 'nv@test.fr', password: PASSWORD, displayName: 'NV' }).expect(202);
    const ok = await api().post(`${A}/login`).send({ email: 'nv@test.fr', password: PASSWORD });
    expect(ok.status).toBe(403);
    expect(ok.body.error.code).toBe('EMAIL_NOT_VERIFIED');
    expect(ok.headers['set-cookie']).toBeUndefined();
    const bad = await api().post(`${A}/login`).send({ email: 'nv@test.fr', password: 'mauvais-mot-de-passe' });
    expect(bad.status).toBe(401);
    expect(bad.body.error.code).toBe('INVALID_CREDENTIALS');
    expect(await getDb().refreshToken.count()).toBe(0);
  });

  it('scénario complet : l’attaquant inscrit l’email de la victime puis perd tout accès', async () => {
    // 1. L'attaquant inscrit l'adresse de la victime avec SON mot de passe : il ne peut pas se connecter.
    await api().post(`${A}/register`).send({ email: VICTIM, password: ATTACKER_PWD, displayName: 'Attaquant' }).expect(202);
    await api().post(`${A}/login`).send({ email: VICTIM, password: ATTACKER_PWD }).expect(403);
    const firstLink = await tokenFromMail(VICTIM, 'verifyEmail');
    // 2. La victime s'inscrit : sa demande remplace celle de l'attaquant.
    await getDb().emailToken.updateMany({ data: { createdAt: new Date(Date.now() - 3 * 60_000) } });
    await api().post(`${A}/register`).send({ email: VICTIM, password: VICTIM_PWD, displayName: 'Victime' }).expect(202);
    const user = await getDb().user.findUniqueOrThrow({ where: { email: VICTIM } });
    expect(user.displayName).toBe('Victime');
    // Le lien de la première inscription ne fonctionne plus.
    await api().post(`${A}/verify-email`).send({ token: firstLink }).expect(400);
    // 3. La victime vérifie son adresse avec SON lien.
    await api().post(`${A}/verify-email`).send({ token: await tokenFromMail(VICTIM, 'verifyEmail') }).expect(204);
    // 4. Le mot de passe de l'attaquant ne sert plus à rien ; celui de la victime fonctionne.
    await api().post(`${A}/login`).send({ email: VICTIM, password: ATTACKER_PWD }).expect(401);
    await api().post(`${A}/login`).send({ email: VICTIM, password: VICTIM_PWD }).expect(200);
  });

  it('la vérification d’email révoque toutes les sessions antérieures', async () => {
    await api().post(`${A}/register`).send({ email: 'sess@test.fr', password: PASSWORD, displayName: 'S' }).expect(202);
    const user = await getDb().user.findUniqueOrThrow({ where: { email: 'sess@test.fr' } });
    // Session préexistante (créée hors du flux normal, ex. ancienne version de l'application).
    await getDb().refreshToken.create({ data: { userId: user.id, familyId: user.id, tokenHash: 'b'.repeat(64), expiresAt: new Date(Date.now() + 60_000) } });
    await api().post(`${A}/verify-email`).send({ token: await tokenFromMail('sess@test.fr', 'verifyEmail') }).expect(204);
    expect(await getDb().refreshToken.count({ where: { userId: user.id, revokedAt: null } })).toBe(0);
    const after = await getDb().user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.tokenVersion).toBe(user.tokenVersion + 1);
  });
});

describe('temps de réponse constant (B2.1 M5)', () => {
  it('register / forgot / resend : plancher identique quel que soit le cas', async () => {
    const { resetEnvCache } = await import('../../src/config/env.js');
    process.env['AUTH_RESPONSE_FLOOR_MS'] = '400';
    resetEnvCache();
    try {
      await createUser({ email: 'timing@test.fr' });
      const time = async (fn: () => PromiseLike<unknown>) => {
        const t0 = performance.now();
        await fn();
        return performance.now() - t0;
      };
      const durations = [
        await time(() => api().post(`${A}/forgot-password`).send({ email: 'timing@test.fr' })),
        await time(() => api().post(`${A}/forgot-password`).send({ email: 'absent@test.fr' })),
        await time(() => api().post(`${A}/resend-verification`).send({ email: 'timing@test.fr' })),
        await time(() => api().post(`${A}/resend-verification`).send({ email: 'absent@test.fr' })),
        await time(() => api().post(`${A}/register`).send({ email: 'timing@test.fr', password: PASSWORD, displayName: 'T' })),
        await time(() => api().post(`${A}/register`).send({ email: 'neuf@test.fr', password: PASSWORD, displayName: 'N' })),
      ];
      for (const d of durations) expect(d).toBeGreaterThanOrEqual(395);
    } finally {
      process.env['AUTH_RESPONSE_FLOOR_MS'] = '0';
      resetEnvCache();
    }
  });

  it('le plancher ne peut pas être désactivé hors test', async () => {
    const { parseEnv } = await import('../../src/config/env.js');
    expect(() => parseEnv({ ...process.env, NODE_ENV: 'development', AUTH_RESPONSE_FLOOR_MS: '0' })).toThrow(/AUTH_RESPONSE_FLOOR_MS/);
  });
});
