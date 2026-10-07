import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';
import { assertTestDatabaseUrl } from '../setup/guard.js';
import { assertSeedAllowed } from '../../prisma/seedGuard.js';

describe('garde de la base de test (B1.1 B3)', () => {
  it('exige un nom de base finissant par _test, distinct de la base de dev', () => {
    expect(() => assertTestDatabaseUrl('postgresql://u:p@127.0.0.1:5432/nuits', undefined)).toThrow(/_test/);
    expect(() => assertTestDatabaseUrl('postgresql://u:p@127.0.0.1:5432/nuits_test_old', undefined)).toThrow(/_test/);
    expect(() => assertTestDatabaseUrl(undefined, undefined)).toThrow(/manquant/);
    const url = 'postgresql://u:p@127.0.0.1:5433/nuits_test';
    expect(() => assertTestDatabaseUrl(url, url)).toThrow(/différer/);
    expect(assertTestDatabaseUrl(url, 'postgresql://u:p@127.0.0.1:5432/nuits')).toBe(url);
  });
});

describe('garde du seed (B1.1 B4)', () => {
  const ok = { nodeEnv: 'development', databaseUrl: 'postgresql://u:p@127.0.0.1:5432/nuits', seedPassword: '', allowSeed: '1' };
  it('refuse la production, une base distante et un mot de passe court', () => {
    expect(() => { assertSeedAllowed({ ...ok, nodeEnv: 'production' }); }).toThrow(/production/);
    expect(() => { assertSeedAllowed({ ...ok, databaseUrl: 'postgresql://u:p@db.prod.example:5432/nuits' }); }).toThrow(/locale/);
    expect(() => { assertSeedAllowed({ ...ok, seedPassword: 'quinze-caracter' }); }).toThrow(/16/);
    // Accord explicite de l'opérateur exigé (audit B13).
    expect(() => { assertSeedAllowed({ ...ok, allowSeed: '' }); }).toThrow(/ALLOW_SEED=1/);
    expect(() => { assertSeedAllowed({ ...ok, allowSeed: 'true' }); }).toThrow(/ALLOW_SEED=1/);
  });
  it('accepte une base locale avec mot de passe vide (aléatoire) ou ≥ 16 caractères', () => {
    expect(() => {
      assertSeedAllowed(ok);
    }).not.toThrow();
    expect(() => {
      assertSeedAllowed({ ...ok, databaseUrl: 'postgresql://u:p@localhost:5432/nuits', seedPassword: 'seize-caracteres' });
    }).not.toThrow();
  });
});

describe('règles ESLint de sécurité (B1.1 B1)', () => {
  it('interdit req.body / req.query / req.params hors du middleware de validation', async () => {
    const dir = join(process.cwd(), 'src', 'modules', '__lintcheck__');
    const file = join(dir, 'controller.ts');
    mkdirSync(dir, { recursive: true });
    try {
      writeFileSync(file, [
        "import type { Request } from 'express';",
        'export function a(req: Request): unknown { return req.body as unknown; }',
        'export function b(req: Request): unknown { return req.query; }',
        'export function c(req: Request): unknown { const { params } = req; return params; }',
        'export function d(): number { return Math.random(); }',
        '',
      ].join('\n'));
      const [result] = await new ESLint().lintFiles([file]);
      const restricted = result!.messages.filter((m) => m.ruleId === 'no-restricted-syntax');
      expect(restricted).toHaveLength(4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
