import { afterEach, describe, expect, it } from 'vitest';
import {
  ACCOUNT_FAILURE_WINDOW_MINUTES, ACCOUNT_LOCK_MINUTES, ACCOUNT_LOCK_THRESHOLD, AUTH_EMAIL_QUOTAS, LOCK_THRESHOLD,
} from '../../src/config/auth.js';
import { minutes } from '../../src/config/units.js';
import { clock, testClock } from '../../src/lib/clock.js';
import { getDb } from '../../src/lib/db.js';
import { AppError } from '../../src/lib/errors.js';
import { decryptOutboxPayload } from '../../src/lib/outbox.js';
import { forgotPassword, login, resetPassword } from '../../src/modules/auth/service.js';
import { createUser, expectDefined, PASSWORD, tokenFromMail } from '../helpers.js';

const WRONG = 'mauvais-mot-de-passe';
const attempt = (email: string, password: string, ip: string) => login(email, password, ip).then(() => 'ok', (err: unknown) => {
  if (err instanceof AppError) return err.code;
  throw err;
});
/** Une adresse IPv4 distincte par rang : aucun verrou par couple ne se déclenche. */
const ipOf = (i: number) => `10.0.${Math.floor(i / 250)}.${(i % 250) + 1}`;
const accountRow = (id: string) => getDb().user.findUniqueOrThrow({ where: { id } });

afterEach(() => {
  testClock.reset();
});

async function lockAccountGlobally(email: string) {
  for (let i = 0; i < ACCOUNT_LOCK_THRESHOLD; i += 1) await attempt(email, WRONG, ipOf(i));
}

describe('verrouillage de connexion par couple (compte, IP)', () => {
  it('un tiers ne verrouille que son couple : le titulaire se connecte depuis une autre IP', async () => {
    const user = await createUser();
    for (let i = 0; i < LOCK_THRESHOLD; i += 1) expect(await attempt(user.email, WRONG, '203.0.113.7')).toBe('INVALID_CREDENTIALS');
    expect(await attempt(user.email, PASSWORD, '203.0.113.7')).toBe('INVALID_CREDENTIALS');
    expect(await attempt(user.email, PASSWORD, '198.51.100.20')).toBe('ok');
    // IPv6 : même sous-réseau = même couple.
    for (let i = 0; i < LOCK_THRESHOLD; i += 1) await attempt(user.email, WRONG, '2001:db8:1:1::1');
    expect(await attempt(user.email, PASSWORD, '2001:db8:1:1::2')).toBe('INVALID_CREDENTIALS');
  });

  it('quota de tentatives par adresse : compté par IP, un tiers ne l’épuise pas pour le titulaire', async () => {
    const user = await createUser();
    let last = '';
    for (let i = 0; i <= AUTH_EMAIL_QUOTAS.login.max; i += 1) last = await attempt(user.email, WRONG, '203.0.113.50');
    expect(last).toBe('RATE_LIMITED');
    expect(await attempt(user.email, PASSWORD, '198.51.100.21')).toBe('ok');
  }, 60_000);
});

describe('plafond global par compte (audit M\'1)', () => {
  it(`${ACCOUNT_LOCK_THRESHOLD} échecs depuis des IP différentes ⇒ compte verrouillé ${ACCOUNT_LOCK_MINUTES} min pour toutes les IP`, async () => {
    const user = await createUser();
    await lockAccountGlobally(user.email);
    const lockedUntil = expectDefined((await accountRow(user.id)).lockedUntil, 'verrou global posé');
    const remaining = lockedUntil.getTime() - clock.now().getTime();
    expect(remaining).toBeGreaterThan(minutes(ACCOUNT_LOCK_MINUTES - 1));
    expect(remaining).toBeLessThanOrEqual(minutes(ACCOUNT_LOCK_MINUTES));
    expect(await attempt(user.email, PASSWORD, '198.51.100.99')).toBe('INVALID_CREDENTIALS');
  }, 60_000);

  it('le verrou ne s’entretient plus : après son expiration, UN échec ne re-verrouille pas (compteur reparti à 1)', async () => {
    const user = await createUser();
    await lockAccountGlobally(user.email);
    const lockedUntil = expectDefined((await accountRow(user.id)).lockedUntil, 'verrou global posé');
    // L'attaquant revient juste après l'expiration (avant : chaque échec dans l'heure re-verrouillait 15 min).
    testClock.freeze(new Date(lockedUntil.getTime() + 1000));
    expect(await attempt(user.email, WRONG, '203.0.113.200')).toBe('INVALID_CREDENTIALS');
    const after = await accountRow(user.id);
    expect(after.lockedUntil).toBeNull();
    expect(after.failedLoginCount).toBe(1);
    expect(await attempt(user.email, PASSWORD, '198.51.100.98')).toBe('ok');
  }, 60_000);

  it('fenêtre comptée depuis le PREMIER échec : des échecs étalés sur plus d’une heure ne s’additionnent pas', async () => {
    const user = await createUser();
    const t0 = clock.now().getTime();
    testClock.freeze(new Date(t0));
    await attempt(user.email, WRONG, ipOf(0));
    testClock.freeze(new Date(t0 + minutes(ACCOUNT_FAILURE_WINDOW_MINUTES - 1)));
    for (let i = 1; i < ACCOUNT_LOCK_THRESHOLD - 1; i += 1) await attempt(user.email, WRONG, ipOf(i));
    expect((await accountRow(user.id)).failedLoginCount).toBe(ACCOUNT_LOCK_THRESHOLD - 1);
    // 50e échec, mais plus d'une heure après le premier : nouvelle fenêtre (avant : verrou, fenêtre glissante).
    testClock.freeze(new Date(t0 + minutes(ACCOUNT_FAILURE_WINDOW_MINUTES + 1)));
    await attempt(user.email, WRONG, ipOf(ACCOUNT_LOCK_THRESHOLD));
    const after = await accountRow(user.id);
    expect(after.lockedUntil).toBeNull();
    expect(after.failedLoginCount).toBe(1);
  }, 60_000);

  it('verrou global ⇒ un mail au titulaire avec lien de réinitialisation, au plus un par 24 h', async () => {
    const user = await createUser();
    await lockAccountGlobally(user.email);
    const mails = await getDb().emailOutbox.findMany({ where: { to: user.email, template: 'accountLocked' } });
    expect(mails).toHaveLength(1);
    expect(decryptOutboxPayload(expectDefined(mails[0], 'mail de verrou'))).toMatchObject({ minutes: ACCOUNT_LOCK_MINUTES, resetLink: expect.stringMatching(/\/forgot-password$/) as unknown });
    const lockedUntil = expectDefined((await accountRow(user.id)).lockedUntil, 'verrou global posé');
    testClock.freeze(new Date(lockedUntil.getTime() + 1000));
    await lockAccountGlobally(user.email);
    expect(expectDefined((await accountRow(user.id)).lockedUntil, 'second verrou').getTime()).toBeGreaterThan(lockedUntil.getTime());
    expect(await getDb().emailOutbox.count({ where: { to: user.email, template: 'accountLocked' } })).toBe(1);
  }, 120_000);

  it('la réinitialisation du mot de passe lève TOUS les verrous (global et par couple)', async () => {
    const user = await createUser();
    for (let i = 0; i < LOCK_THRESHOLD; i += 1) await attempt(user.email, WRONG, '203.0.113.9');
    await lockAccountGlobally(user.email);
    await forgotPassword(user.email);
    await resetPassword(await tokenFromMail(user.email, 'resetPassword'), 'nouveau-mot-de-passe-42');
    expect(await getDb().loginLockout.count({ where: { userId: user.id } })).toBe(0);
    expect(await attempt(user.email, 'nouveau-mot-de-passe-42', '203.0.113.9')).toBe('ok');
  }, 60_000);

  it('compte verrouillé : le couple n’est pas débité d’une tentative fantôme (audit B\'12)', async () => {
    const user = await createUser();
    await lockAccountGlobally(user.email);
    expect(await attempt(user.email, WRONG, '203.0.113.77')).toBe('INVALID_CREDENTIALS');
    // Aucun couple créé pour l'IP refusée : seuls les 50 couples de la rafale existent.
    expect(await getDb().loginLockout.count({ where: { userId: user.id } })).toBe(ACCOUNT_LOCK_THRESHOLD);
  }, 60_000);
});
