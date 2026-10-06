import { randomUUID } from 'node:crypto';
import supertest from 'supertest';
import argon2 from 'argon2';
import { createApp } from '../src/app.js';
import { getDb } from '../src/lib/db.js';
import { decryptOutboxPayload } from '../src/lib/outbox.js';
import { ARGON2_PARAMS } from '../src/lib/password.js';
import type { Role } from '../src/generated/prisma/client.js';

export const FRONT = 'http://localhost:5173';
export const PASSWORD = 'motdepasse-de-test-123';

let app: ReturnType<typeof createApp> | null = null;

/** Application de test : rate limiting assoupli (un test dédié vérifie les vrais plafonds). */
export function api() {
  app ??= createApp({ rateLimitMultiplier: 1000 });
  return supertest(app);
}

let cachedHash: string | null = null;
async function passwordHash(): Promise<string> {
  cachedHash ??= await argon2.hash(PASSWORD, ARGON2_PARAMS);
  return cachedHash;
}

export interface TestUser {
  id: string;
  email: string;
}

export async function createUser(opts: { email?: string; verified?: boolean; admin?: boolean; displayName?: string } = {}): Promise<TestUser> {
  const user = await getDb().user.create({
    data: {
      email: opts.email ?? `user-${randomUUID()}@test.fr`,
      displayName: opts.displayName ?? 'Jean Test',
      passwordHash: await passwordHash(),
      emailVerifiedAt: opts.verified === false ? null : new Date(),
      isPlatformAdmin: opts.admin ?? false,
    },
  });
  return { id: user.id, email: user.email };
}

export interface LoggedIn extends TestUser {
  token: string;
  cookie: string;
  auth: { Authorization: string };
}

export function refreshCookieOf(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? (raw as string[]) : [];
  const found = list.find((c) => c.startsWith('nuits_rt='));
  if (!found) throw new Error('cookie nuits_rt absent');
  return found.split(';')[0]!;
}

export async function login(user: TestUser, password = PASSWORD): Promise<LoggedIn> {
  const res = await api().post('/api/v1/auth/login').send({ email: user.email, password });
  if (res.status !== 200) throw new Error(`login KO ${res.status} ${JSON.stringify(res.body)}`);
  const token = res.body.accessToken as string;
  return { ...user, token, cookie: refreshCookieOf(res), auth: { Authorization: `Bearer ${token}` } };
}

export async function loggedInUser(opts: Parameters<typeof createUser>[0] = {}): Promise<LoggedIn> {
  return login(await createUser(opts));
}

export async function createOrg(slug = `org-${randomUUID().slice(0, 8)}`) {
  return getDb().organization.create({ data: { name: `Collectif ${slug}`, slug, settings: { create: {} } } });
}

export async function addMember(orgId: string, userId: string, role: Role) {
  return getDb().membership.create({ data: { orgId, userId, role } });
}

/** Dernier mail en outbox pour un destinataire et un gabarit. */
export async function lastMail(to: string, template: string) {
  return getDb().emailOutbox.findFirst({ where: { to, template }, orderBy: { createdAt: 'desc' } });
}

/** Extrait le jeton d'un lien de mail (?token=…). */
export async function tokenFromMail(to: string, template: string, field = 'link'): Promise<string> {
  const mail = await lastMail(to, template);
  if (!mail) throw new Error(`mail ${template} absent pour ${to}`);
  const payload = decryptOutboxPayload(mail);
  const url = payload[field];
  if (typeof url !== 'string') throw new Error(`champ ${field} absent du mail ${template}`);
  const token = new URL(url).searchParams.get('token');
  if (!token) throw new Error('jeton absent du lien');
  return token;
}

export const csrfHeaders = { Origin: FRONT, 'X-Requested-With': 'nuits-web' };
