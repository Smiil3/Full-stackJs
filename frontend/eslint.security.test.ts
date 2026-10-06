// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ESLint, type Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import { securityConfigs } from './eslint.security.js';

const eslint = new ESLint({
  cwd: import.meta.dirname,
  overrideConfigFile: true,
  overrideConfig: [
    { files: ['**/*.{ts,tsx}'], languageOptions: { parser: tseslint.parser, parserOptions: { ecmaFeatures: { jsx: true } } } },
    ...(securityConfigs as Linter.Config[]),
  ],
});

async function ruleIds(code: string, filePath: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? []).map((m) => m.ruleId ?? m.message);
}

describe('règles ESLint de sécurité (revue F1.1 — B5)', () => {
  it.each([
    ['localStorage.setItem("t", x)', 'no-restricted-globals'],
    ['window.localStorage.setItem("t", x)', 'no-restricted-properties'],
    ['globalThis.sessionStorage.getItem("t")', 'no-restricted-properties'],
    ['self.indexedDB.open("x")', 'no-restricted-properties'],
    ['indexedDB.open("x")', 'no-restricted-globals'],
    ['document.cookie = "a=b"', 'no-restricted-properties'],
    ['fetch("/api/v1/orders")', 'no-restricted-globals'],
    ['window.fetch("/x")', 'no-restricted-properties'],
    ['el.innerHTML = x', 'no-restricted-syntax'],
    ['document.write(x)', 'no-restricted-syntax'],
    ['eval(x)', 'no-eval'],
    ['new Function(x)', 'no-new-func'],
    // F6-B2 : autres canaux réseau / stockage
    ['new XMLHttpRequest()', 'no-restricted-globals'],
    ['new WebSocket("wss://x")', 'no-restricted-globals'],
    ['new window.WebSocket("wss://x")', 'no-restricted-properties'],
    ['new EventSource("/x")', 'no-restricted-globals'],
    ['void caches.open("x")', 'no-restricted-globals'],
    ['void self.caches.open("x")', 'no-restricted-properties'],
    ['navigator.sendBeacon("/x", x)', 'no-restricted-properties'],
  ])('interdit « %s » dans un fichier applicatif', async (code, rule) => {
    expect(await ruleIds(`declare const x: string; declare const el: HTMLElement; ${code};\n`, 'src/pages/Page.tsx')).toContain(rule);
  });

  it('interdit dangerouslySetInnerHTML', async () => {
    expect(await ruleIds('export const A = (h: string) => <div dangerouslySetInnerHTML={{ __html: h }} />;\n', 'src/pages/A.tsx')).toContain('no-restricted-syntax');
  });

  it('fetch autorisé UNIQUEMENT dans src/api/client.ts (mais pas localStorage)', async () => {
    expect(await ruleIds('fetch("/x");\n', 'src/api/client.ts')).toEqual([]);
    expect(await ruleIds('localStorage.getItem("x");\n', 'src/api/client.ts')).toContain('no-restricted-globals');
    expect(await ruleIds('fetch("/x");\n', 'src/api/hooks/orders.ts')).toContain('no-restricted-globals');
  });

  it('IndexedDB autorisé uniquement dans src/offline/ et src/scanner/db.ts', async () => {
    expect(await ruleIds('indexedDB.open("x");\n', 'src/offline/tickets.ts')).toEqual([]);
    expect(await ruleIds('indexedDB.open("x");\n', 'src/scanner/db.ts')).toEqual([]);
    expect(await ruleIds('indexedDB.open("x");\n', 'src/scanner/ScanPage.tsx')).toContain('no-restricted-globals');
    expect(await ruleIds('fetch("/x");\n', 'src/offline/tickets.ts')).toContain('no-restricted-globals');
  });

  it('F6-B2 : import de idb autorisé uniquement dans src/offline/ et src/scanner/db.ts', async () => {
    const code = 'import { openDB } from "idb";\nexport const o = openDB;\n';
    expect(await ruleIds(code, 'src/offline/tickets.ts')).toEqual([]);
    expect(await ruleIds(code, 'src/scanner/db.ts')).toEqual([]);
    expect(await ruleIds(code, 'src/scanner/engine.ts')).toContain('no-restricted-imports');
    expect(await ruleIds(code, 'src/pages/Page.tsx')).toContain('no-restricted-imports');
    expect(await ruleIds('import { openDB } from "idb/with-async-ittr";\nexport const o = openDB;\n', 'src/api/hooks/x.ts')).toContain('no-restricted-imports');
  });

  it('D1 : localStorage n’est utilisé (hors commentaires) dans AUCUN fichier applicatif, sauf le module de préférence de thème', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) && /localStorage/.test(readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ''))) offenders.push(relative(import.meta.dirname, path));
      }
    };
    walk(join(import.meta.dirname, 'src'));
    expect(offenders).toEqual(['src/lib/themePreference.ts']);
  });
});
