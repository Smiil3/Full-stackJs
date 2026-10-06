import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import Joi from 'joi';
import { pinoHttp } from 'pino-http';
import { buildLogger, serializeError } from '../../src/lib/logger.js';
import { getDb } from '../../src/lib/db.js';
import { endpoint } from '../../src/middlewares/validate.js';
import { errorHandler } from '../../src/middlewares/errorHandler.js';
import { createApp } from '../../src/app.js';
import { resetEnvCache } from '../../src/config/env.js';

function capture() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  return { lines, stream };
}

function withLogLevel<T>(fn: () => Promise<T>): Promise<T> {
  const saved = process.env['LOG_LEVEL'];
  process.env['LOG_LEVEL'] = 'info';
  resetEnvCache();
  return fn().finally(() => {
    process.env['LOG_LEVEL'] = saved;
    resetEnvCache();
  });
}

describe('journalisation (B1.1 M4)', () => {
  it('une erreur Prisma en 500 ne fait fuiter ni email ni hash dans les logs', async () => {
    await withLogLevel(async () => {
      const { lines, stream } = capture();
      const logger = buildLogger(stream);
      const app = express();
      app.use(pinoHttp({ logger }));
      app.post('/boom', ...endpoint({ response: Joi.object({}) }, async () => {
        // Caractère NUL : Postgres refuse la valeur (22021) et l'erreur Prisma embarque les arguments.
        await getDb().user.create({ data: { email: 'fuite@secret.fr', passwordHash: '$argon2id$v=19$hash-secret', displayName: 'a\u0000b' } });
        return {};
      }));
      app.use(errorHandler);
      const res = await supertest(app).post('/boom').expect(500);
      expect(JSON.stringify(res.body)).not.toMatch(/fuite@secret|argon2/);
      const logs = lines.join('');
      expect(logs).toContain('erreur non gérée');
      expect(logs).not.toContain('fuite@secret.fr');
      expect(logs).not.toContain('hash-secret');
    });
  });

  it('les en-têtes et champs sensibles sont masqués à toute profondeur', async () => {
    await withLogLevel(async () => {
      const { lines, stream } = capture();
      const logger = buildLogger(stream);
      logger.info({
        req: { headers: { authorization: 'Bearer abc.def.ghi', cookie: 'nuits_rt=secret-cookie', 'x-api-key': 'k-secret' } },
        body: { password: 'pw-secret', nested: { token: 'tok-secret', deeper: { iban: 'FR76-secret' } } },
        email: 'someone@secret.fr',
        outbox: { payload: { link: 'https://x/?token=lien-secret' } },
      }, 'test');
      const out = lines.join('');
      for (const secret of ['abc.def.ghi', 'secret-cookie', 'k-secret', 'pw-secret', 'tok-secret', 'FR76-secret', 'someone@secret.fr', 'lien-secret']) {
        expect(out).not.toContain(secret);
      }
      expect(out).toContain('[REDACTED]');
    });
  });

  it('les journaux de requête de l’application masquent Authorization et Cookie', async () => {
    await withLogLevel(async () => {
      const { lines, stream } = capture();
      await supertest(createApp({ rateLimitMultiplier: 1000, logger: buildLogger(stream) }))
        .get('/api/v1/auth/me?token=dans-url')
        .set('Authorization', 'Bearer header-secret')
        .set('Cookie', 'nuits_rt=cookie-secret');
      const out = lines.join('');
      expect(out).not.toContain('header-secret');
      expect(out).not.toContain('cookie-secret');
      expect(out).not.toContain('dans-url');
    });
  });

  it('sérialiseur : ne garde que type, code et cible d’une erreur Prisma', async () => {
    let caught: unknown;
    try {
      await getDb().organization.create({ data: { name: 'x', slug: 'dup' } });
      await getDb().organization.create({ data: { name: 'x', slug: 'dup' } });
    } catch (err) {
      caught = err;
    }
    const s = serializeError(caught);
    expect(s['code']).toBe('P2002');
    expect(Object.keys(s).sort()).toEqual(['code', 'modelName', 'target', 'type']);
  });
});
