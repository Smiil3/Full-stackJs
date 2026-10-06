import { describe, expect, it } from 'vitest';
import supertest from 'supertest';
import { createApp } from '../../src/app.js';
import { getDb } from '../../src/lib/db.js';
import { createUser } from '../helpers.js';

const A = '/api/v1/auth';

describe('rate limiting partagé en base (B2.1 M8)', () => {
  it('les compteurs sont partagés entre instances (redémarrage, multi-instance)', async () => {
    const first = supertest(createApp({ rateLimitMultiplier: 0.25 })); // login : 5 / 15 min par IP
    for (let i = 0; i < 5; i += 1) await first.post(`${A}/login`).send({ email: `x${i}@test.fr`, password: 'y' });
    // « Redémarrage » : une nouvelle instance repart avec les mêmes compteurs.
    const second = supertest(createApp({ rateLimitMultiplier: 0.25 }));
    const res = await second.post(`${A}/login`).send({ email: 'z@test.fr', password: 'y' });
    expect(res.status).toBe(429);
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('aucune IP ni adresse email en clair dans la table des compteurs', async () => {
    const app = supertest(createApp({ rateLimitMultiplier: 1000 }));
    await app.post(`${A}/login`).send({ email: 'pii@test.fr', password: 'y' });
    const rows = await getDb().rateLimitBucket.findMany();
    expect(rows.length).toBeGreaterThan(0);
    const raw = JSON.stringify(rows);
    expect(raw).not.toContain('pii@test.fr');
    expect(raw).not.toContain('127.0.0.1');
  });

  it('quota par adresse au login, indépendant de l’IP et de l’existence du compte', async () => {
    const app = supertest(createApp({ rateLimitMultiplier: 1000 }));
    const user = await createUser({ email: 'quota@test.fr' });
    for (let i = 0; i < 30; i += 1) await app.post(`${A}/login`).send({ email: user.email, password: 'mauvais-mot-de-passe' });
    const blocked = await app.post(`${A}/login`).send({ email: user.email, password: 'mauvais-mot-de-passe' });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    // Même comportement pour une adresse inexistante (pas d'énumération).
    for (let i = 0; i < 30; i += 1) await app.post(`${A}/login`).send({ email: 'inexistant@test.fr', password: 'mauvais-mot-de-passe' });
    expect((await app.post(`${A}/login`).send({ email: 'inexistant@test.fr', password: 'x' })).status).toBe(429);
  });

  it('quota par adresse sur mot de passe oublié', async () => {
    const app = supertest(createApp({ rateLimitMultiplier: 1000 }));
    for (let i = 0; i < 5; i += 1) await app.post(`${A}/forgot-password`).send({ email: 'cible@test.fr' }).expect(202);
    const res = await app.post(`${A}/forgot-password`).send({ email: 'cible@test.fr' });
    expect(res.status).toBe(429);
    // Une autre adresse n'est pas affectée.
    await app.post(`${A}/forgot-password`).send({ email: 'autre@test.fr' }).expect(202);
  });
});
