import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import Joi from 'joi';
import { parseEnv, EnvValidationError, resetEnvCache } from '../../src/config/env.js';
import { checkResponse, endpoint } from '../../src/middlewares/validate.js';
import { createApp } from '../../src/app.js';
import { errorHandler, notFoundHandler } from '../../src/middlewares/errorHandler.js';
import { pinoHttp } from 'pino-http';
import { getLogger } from '../../src/lib/logger.js';
import { api } from '../helpers.js';

describe('configuration', () => {
  it('refuse une configuration où un secret manque ou est trop court', () => {
    const base = { ...process.env };
    expect(() => parseEnv({ ...base, JWT_ACCESS_SECRET: 'court' })).toThrow(EnvValidationError);
    const { PSP_WEBHOOK_SECRET: _omit, ...withoutSecret } = base;
    expect(() => parseEnv(withoutSecret)).toThrow(/PSP_WEBHOOK_SECRET/);
    expect(() => parseEnv({ ...base, DATA_ENCRYPTION_KEY: Buffer.alloc(16).toString('base64') })).toThrow(/32 octets/);
    expect(() => parseEnv({ ...base, NODE_ENV: 'production', REFRESH_COOKIE_SECURE: 'false' })).toThrow(EnvValidationError);
  });

  it('le message d’erreur ne contient jamais la valeur du secret', () => {
    const secret = 'valeur-secrete-trop-courte';
    try {
      parseEnv({ ...process.env, JWT_ACCESS_SECRET: secret });
      expect.unreachable();
    } catch (err) {
      expect(String(err)).not.toContain(secret);
    }
  });

  it('le serveur refuse de démarrer avec une configuration invalide', () => {
    const result = spawnSync('npx', ['tsx', 'src/server.ts'], {
      env: { ...process.env, JWT_ACCESS_SECRET: 'trop-court', DOTENV_CONFIG_PATH: '/dev/null' },
      encoding: 'utf8',
      timeout: 20_000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Démarrage refusé');
  });
});

describe('application', () => {
  it('GET /health répond ok sans information de version', async () => {
    const res = await api().get('/health').expect(200);
    expect(res.body).toEqual({ status: 'ok' });
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('pose les en-têtes de sécurité helmet', async () => {
    const res = await api().get('/health');
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-request-id']).toBeTruthy();
  });

  it('renvoie un 404 JSON au format du contrat', async () => {
    const res = await api().get('/api/v1/nexiste-pas').expect(404);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.body).toEqual({ error: { code: 'NOT_FOUND', message: expect.any(String) } });
  });

  it('CORS : seule l’origine du front est autorisée, avec credentials', async () => {
    const ok = await api().options('/api/v1/events').set('Origin', 'http://localhost:5173').set('Access-Control-Request-Method', 'POST');
    expect(ok.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(ok.headers['access-control-allow-credentials']).toBe('true');
    const ko = await api().options('/api/v1/events').set('Origin', 'https://evil.example').set('Access-Control-Request-Method', 'POST');
    expect(ko.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('JSON malformé ou trop gros ⇒ erreur propre', async () => {
    const bad = await api().post('/api/v1/nexiste-pas').set('Content-Type', 'application/json').send('{"a":');
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('VALIDATION_ERROR');
    const big = await api().post('/api/v1/nexiste-pas').set('Content-Type', 'application/json').send({ a: 'x'.repeat(20_000) });
    expect(big.status).toBe(413);
    expect(big.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('corps non JSON ⇒ 415 UNSUPPORTED_MEDIA_TYPE (B1.1 M10)', async () => {
    const res = await api().post('/api/v1/auth/login').set('Content-Type', 'text/plain').send('email=a&password=b');
    expect(res.status).toBe(415);
    expect(res.body.error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    const form = await api().post('/api/v1/auth/login').type('form').send({ email: 'a@test.fr', password: 'x' });
    expect(form.status).toBe(415);
  });

  it('requestId toujours généré par le serveur, jamais repris du client (B1.1 M5)', async () => {
    const res = await api().get('/health').set('X-Request-Id', 'client-chosen-id-123');
    expect(res.headers['x-request-id']).not.toBe('client-chosen-id-123');
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('HSTS activé en production', async () => {
    const saved = { ...process.env };
    try {
      Object.assign(process.env, { NODE_ENV: 'production', REFRESH_COOKIE_SECURE: 'true', AUTH_RESPONSE_FLOOR_MS: '400' });
      resetEnvCache();
      const res = await supertest(createApp()).get('/health');
      expect(res.headers['strict-transport-security']).toMatch(/max-age=31536000/);
    } finally {
      process.env = saved;
      resetEnvCache();
    }
  });
});

describe('ordre des middlewares et limites (B1.1 M1/M2)', () => {
  it('le limiteur global passe avant le parseur JSON', async () => {
    const strict = supertest(createApp({ rateLimitMultiplier: 0.01 })); // global : 3 / min
    for (let i = 0; i < 3; i += 1) {
      const r = await strict.post('/api/v1/auth/login').set('Content-Type', 'application/json').send('{"malformé');
      expect(r.status).toBe(400);
    }
    const blocked = await strict.post('/api/v1/auth/login').set('Content-Type', 'application/json').send('{"malformé');
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('webhook : seules les signatures invalides sont limitées, corps non parsé en JSON (B9 M1)', async () => {
    const strict = supertest(createApp({ rateLimitMultiplier: 1 }));
    const first = await strict.post('/api/v1/webhooks/psp').set('Content-Type', 'application/json').send('{"pas du json');
    // Corps brut : le parseur JSON n'intervient pas (sinon 400 « JSON invalide » générique) ; signature absente ⇒ 400.
    expect(first.status).toBe(400);
    expect(first.body.error.message).not.toMatch(/JSON invalide/);
    let last = first;
    for (let i = 0; i < 60; i += 1) last = await strict.post('/api/v1/webhooks/psp').set('Content-Type', 'application/json').set('Psp-Signature', 't=1,v1=00').send('{}');
    expect(last.status).toBe(429);
    // Une notification correctement signée passe toujours, même après le plafond des invalides.
    const { signatureHeader } = await import('../../src/lib/pspSignature.js');
    const raw = JSON.stringify({ id: 'evt_signe1', type: 'type.inconnu', created: 1, data: {} });
    const ok = await strict.post('/api/v1/webhooks/psp').set('Content-Type', 'application/json').set('Psp-Signature', signatureHeader(process.env['PSP_WEBHOOK_SECRET']!, raw)).send(raw);
    expect(ok.status).toBe(200);
  });

  it('webhook : corps brut au-delà de 64 ko ⇒ 413', async () => {
    const res = await api().post('/api/v1/webhooks/psp').set('Content-Type', 'application/json').send(`{"a":"${'x'.repeat(70_000)}"}`);
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });
});

describe('validation des entrées sur la vraie pile (createApp)', () => {
  it('champ inconnu dans le body ⇒ 400 avec le chemin du champ', async () => {
    const res = await api().post('/api/v1/auth/login').send({ email: 'a@test.fr', password: 'x', isAdmin: true }).expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details.fields).toEqual([{ path: 'isAdmin', message: expect.any(String) }]);
  });

  it('pas de conversion de type dans le body JSON et toutes les erreurs remontées', async () => {
    const res = await api().post('/api/v1/auth/register').send({ email: 12, password: 123456789012345, displayName: true }).expect(400);
    const paths = (res.body.error.details.fields as { path: string }[]).map((f) => f.path).sort();
    expect(paths).toEqual(['displayName', 'email', 'password']);
  });

  it('__proto__ / constructor dans le body ⇒ 400 (pas de pollution de prototype)', async () => {
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      const raw = `{"email":"a@test.fr","password":"x","${key}":{"isPlatformAdmin":true}}`;
      const res = await api().post('/api/v1/auth/login').set('Content-Type', 'application/json').send(raw);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
    expect(({} as Record<string, unknown>)['isPlatformAdmin']).toBeUndefined();
  });
});

describe('caractères de contrôle et NUL (B1.1 M9)', () => {
  it('NUL dans un champ ⇒ 400 et jamais d’erreur Postgres 500', async () => {
    const res = await api().post('/api/v1/auth/register').send({ email: 'nul@test.fr', password: 'motdepasse-de-test-123', displayName: 'a\u0000b' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    const inKey = await api().post('/api/v1/auth/login').set('Content-Type', 'application/json').send('{"email":"a@test.fr","password":"x","\\u0000":1}');
    expect(inKey.status).toBe(400);
    const inQuery = await api().get('/health?x=%00');
    expect(inQuery.status).toBe(400);
  });
  it('marque bidi dans le nom affiché ⇒ 400', async () => {
    const res = await api().post('/api/v1/auth/register').send({ email: 'bidi@test.fr', password: 'motdepasse-de-test-123', displayName: 'admin\u202E' });
    expect(res.status).toBe(400);
  });
});

describe('validation des réponses (contrat de sortie)', () => {
  it('en production : les champs non déclarés (passwordHash) sont retirés', () => {
    const saved = { ...process.env };
    try {
      Object.assign(process.env, { NODE_ENV: 'production', REFRESH_COOKIE_SECURE: 'true', AUTH_RESPONSE_FLOOR_MS: '400' });
      resetEnvCache();
      const out: unknown = checkResponse(Joi.object({ id: Joi.string(), email: Joi.string() }), { id: '1', email: 'a@b.fr', passwordHash: '$argon2id$x' });
      expect(out).toEqual({ id: '1', email: 'a@b.fr' });
      expect(() => {
        checkResponse(Joi.object({ id: Joi.string(), email: Joi.string() }), { id: '1' });
      }).toThrow();
    } finally {
      process.env = saved;
      resetEnvCache();
    }
  });
});

// Les violations du contrat de SORTIE ne sont pas provoquables via les routes réelles (qui le respectent) :
// on monte une route jouet avec le même endpoint() et le même errorHandler que l'application.
describe('endpoint() — réponse non conforme', () => {
  function miniApp(response: Joi.Schema, result: unknown, fail = false) {
    const app = express();
    app.use(pinoHttp({ logger: getLogger() }));
    app.use(express.json());
    app.post(
      '/t/:id',
      ...endpoint(
        {
          params: Joi.object({ id: Joi.number().integer() }),
          query: Joi.object({ q: Joi.string().max(5) }),
          body: Joi.object({ name: Joi.string().required(), qty: Joi.number().integer().required() }),
          response,
        },
        () => (fail ? Promise.reject(new Error('SELECT * FROM secret_table — boom')) : Promise.resolve(result)),
      ),
    );
    app.use(notFoundHandler);
    app.use(errorHandler);
    return supertest(app);
  }
  const schema = Joi.object({ ok: Joi.boolean() });

  it('champ inconnu dans la query ⇒ 400', async () => {
    await miniApp(schema, { ok: true }).post('/t/1?evil=1').send({ name: 'a', qty: 1 }).expect(400);
  });

  it('entrée valide ⇒ réponse conforme', async () => {
    const res = await miniApp(schema, { ok: true }).post('/t/1?q=ab').send({ name: 'a', qty: 1 }).expect(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('réponse avec un champ en trop (ex. passwordHash) ⇒ 500 en test, rien ne fuit', async () => {
    const res = await miniApp(schema, { ok: true, passwordHash: '$argon2id$...' }).post('/t/1').send({ name: 'a', qty: 1 }).expect(500);
    expect(JSON.stringify(res.body)).not.toContain('argon2');
    expect(res.body).toEqual({ error: { code: 'INTERNAL_ERROR', message: expect.any(String) } });
  });

  it('réponse avec un champ manquant ⇒ 500 en test', async () => {
    await miniApp(schema, {}).post('/t/1').send({ name: 'a', qty: 1 }).expect(500);
  });

  it('erreur interne ⇒ 500 sans stack ni détail SQL', async () => {
    const res = await miniApp(schema, null, true).post('/t/1').send({ name: 'a', qty: 1 }).expect(500);
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain('secret_table');
    expect(raw).not.toContain('at ');
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
  });
});

describe('configuration — secrets (B1.1 H1)', () => {
  const base = () => ({ ...process.env });
  it('refuse toute valeur d’exemple CHANGE_ME, quel que soit NODE_ENV', () => {
    for (const nodeEnv of ['development', 'test']) {
      expect(() => parseEnv({ ...base(), AUTH_RESPONSE_FLOOR_MS: '400', NODE_ENV: nodeEnv, JWT_ACCESS_SECRET: 'CHANGE_ME_AT_LEAST_43_RANDOM_CHARACTERS_XXXXXXXXXXXX' })).toThrow(/CHANGE_ME|base64url/);
      expect(() => parseEnv({ ...base(), AUTH_RESPONSE_FLOOR_MS: '400', NODE_ENV: nodeEnv, PSP_API_KEY: 'change_me_' + 'A'.repeat(50) })).toThrow(/CHANGE_ME/);
      expect(() => parseEnv({ ...base(), AUTH_RESPONSE_FLOOR_MS: '400', NODE_ENV: nodeEnv, DATABASE_URL: 'postgresql://nuits:CHANGE_ME@127.0.0.1:5432/nuits' })).toThrow(/CHANGE_ME/);
    }
  });
  it('exige des secrets distincts (clé API PSP ≠ secret webhook, etc.)', () => {
    const env = base();
    expect(() => parseEnv({ ...env, PSP_WEBHOOK_SECRET: env['PSP_API_KEY'] })).toThrow(/distincts/);
    expect(() => parseEnv({ ...env, JWT_ACCESS_SECRET: env['PSP_WEBHOOK_SECRET'] })).toThrow(/distincts/);
  });
  it('refuse un nombre de proxys de confiance absurde (B1.1 M3)', () => {
    expect(() => parseEnv({ ...base(), TRUST_PROXY_HOPS: '4' })).toThrow(/TRUST_PROXY_HOPS/);
    expect(parseEnv({ ...base(), TRUST_PROXY_HOPS: '1' }).trustProxyHops).toBe(1);
  });

  it('exige du base64url décodant en au moins 32 octets', () => {
    expect(() => parseEnv({ ...base(), PSP_API_KEY: 'A'.repeat(42) })).toThrow(/32 octets/); // 31 octets
    expect(() => parseEnv({ ...base(), PSP_API_KEY: '+/'.repeat(30) })).toThrow(/base64url/);
    expect(() => parseEnv({ ...base(), PSP_API_KEY: 'A'.repeat(43) })).not.toThrow();
  });
});

describe('limite de corps dédiée à la synchronisation', () => {
  it('les autres routes restent limitées à 10 ko', async () => {
    const big = { email: 'a@test.fr', password: 'x'.repeat(15_000) };
    const res = await api().post('/api/v1/auth/login').send(big);
    expect(res.status).toBe(413);
  });
});
