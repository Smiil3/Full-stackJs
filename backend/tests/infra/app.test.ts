import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import Joi from 'joi';
import { parseEnv, EnvValidationError } from '../../src/config/env.js';
import { endpoint } from '../../src/middlewares/validate.js';
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
  });
});

describe('validate / endpoint', () => {
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

  it('champ inconnu dans le body ⇒ 400 VALIDATION_ERROR avec le chemin du champ', async () => {
    const res = await miniApp(schema, { ok: true }).post('/t/1').send({ name: 'a', qty: 1, isAdmin: true }).expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details.fields).toEqual([{ path: 'isAdmin', message: expect.any(String) }]);
  });

  it('champ inconnu dans la query ⇒ 400', async () => {
    await miniApp(schema, { ok: true }).post('/t/1?evil=1').send({ name: 'a', qty: 1 }).expect(400);
  });

  it('toutes les erreurs sont remontées et le body n’est pas converti ("5" n’est pas un nombre)', async () => {
    const res = await miniApp(schema, { ok: true }).post('/t/abc').send({ qty: '5' }).expect(400);
    const paths = (res.body.error.details.fields as { path: string }[]).map((f) => f.path).sort();
    expect(paths).toEqual(['id', 'name', 'qty']);
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
