import { describe, expect, it } from 'vitest';
import { ACCOUNT_LOCK_THRESHOLD, AUTH_EMAIL_QUOTAS, LOCK_THRESHOLD } from '../../src/config/auth.js';
import { getDb } from '../../src/lib/db.js';
import { AppError } from '../../src/lib/errors.js';
import { login } from '../../src/modules/auth/service.js';
import { createUser, PASSWORD } from '../helpers.js';

const WRONG = 'mauvais-mot-de-passe';
const attempt = (email: string, password: string, ip: string) => login(email, password, ip).then(() => 'ok', (err: unknown) => {
  if (err instanceof AppError) return err.code;
  throw err;
});

describe('verrouillage de connexion par couple (compte, IP) — audit M7', () => {
  it('un tiers ne verrouille que son couple : le titulaire se connecte depuis une autre IP', async () => {
    const user = await createUser();
    for (let i = 0; i < LOCK_THRESHOLD; i += 1) expect(await attempt(user.email, WRONG, '203.0.113.7')).toBe('INVALID_CREDENTIALS');
    // L'attaquant est verrouillé, même avec le bon mot de passe.
    expect(await attempt(user.email, PASSWORD, '203.0.113.7')).toBe('INVALID_CREDENTIALS');
    expect(await attempt(user.email, PASSWORD, '198.51.100.20')).toBe('ok');
    // IPv6 : même sous-réseau = même couple.
    for (let i = 0; i < LOCK_THRESHOLD; i += 1) await attempt(user.email, WRONG, '2001:db8:1:1::1');
    expect(await attempt(user.email, PASSWORD, '2001:db8:1:1::2')).toBe('INVALID_CREDENTIALS');
  });

  it(`plafond global : ${ACCOUNT_LOCK_THRESHOLD} échecs en 1 h depuis des IP différentes ⇒ compte verrouillé 15 min, toutes IP`, async () => {
    const user = await createUser();
    for (let i = 0; i < ACCOUNT_LOCK_THRESHOLD; i += 1) await attempt(user.email, WRONG, `10.0.${Math.floor(i / 250)}.${(i % 250) + 1}`);
    const row = await getDb().user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.lockedUntil!.getTime()).toBeGreaterThan(Date.now() + 14 * 60_000);
    expect(await attempt(user.email, PASSWORD, '198.51.100.99')).toBe('INVALID_CREDENTIALS');
  }, 60_000);

  it('quota de tentatives par adresse : compté par IP, un tiers ne l’épuise pas pour le titulaire', async () => {
    const user = await createUser();
    let last = '';
    for (let i = 0; i <= AUTH_EMAIL_QUOTAS.login.max; i += 1) last = await attempt(user.email, WRONG, '203.0.113.50');
    expect(last).toBe('RATE_LIMITED');
    expect(await attempt(user.email, PASSWORD, '198.51.100.21')).toBe('ok');
  }, 60_000);
});
