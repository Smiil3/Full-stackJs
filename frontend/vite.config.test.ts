// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { contentSecurityPolicy, securityHeaders } from './security-headers.ts';
import viteConfig from './vite.config';

type ConfigFn = (env: { mode: string; command: 'build' | 'serve'; isSsrBuild: boolean; isPreview: boolean }) => {
  server?: { headers?: Record<string, string> };
  preview?: { headers?: Record<string, string> };
};
const config = viteConfig as unknown as ConfigFn;

describe('en-têtes de sécurité (revue F1.1 — M7)', () => {
  it('CSP de production stricte : aucun unsafe-*, pas de framing, pas de base/objet', () => {
    const csp = contentSecurityPolicy(false);
    expect(csp).not.toMatch(/unsafe-(inline|eval)/);
    for (const d of ["default-src 'self'", "script-src 'self'", "style-src 'self'", "connect-src 'self'", "frame-ancestors 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'self'", "worker-src 'self'"]) {
      expect(csp).toContain(d);
    }
  });

  it('preview (build) utilise la CSP stricte ; seul le serveur de dev est assoupli', () => {
    const built = config({ mode: 'production', command: 'serve', isSsrBuild: false, isPreview: true });
    expect(built.preview?.headers?.['Content-Security-Policy']).toBe(contentSecurityPolicy(false));
    expect(built.server?.headers?.['Content-Security-Policy']).toContain("'unsafe-inline'");
    expect(securityHeaders(false)).toMatchObject({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
    expect(securityHeaders(false)['Permissions-Policy']).toContain('camera=(self)');
  });

  it('la conf nginx d’exemple reprend exactement la CSP et les en-têtes, plus HSTS, partout', () => {
    const snippet = readFileSync(new URL('./deploy/nuits-security-headers.conf', import.meta.url), 'utf8');
    for (const [name, value] of Object.entries(securityHeaders(false))) {
      expect(snippet).toContain(`add_header ${name} "${value}" always;`);
    }
    expect(snippet).toContain('Strict-Transport-Security');
    const nginx = readFileSync(new URL('./deploy/nginx.conf.example', import.meta.url), 'utf8');
    const locationsWithHeaders = nginx.split('\n').filter((l) => l.trim().startsWith('location') && l.includes('add_header'));
    expect(locationsWithHeaders.length).toBeGreaterThan(0);
    for (const l of locationsWithHeaders) expect(l).toContain('include /etc/nginx/snippets/nuits-security-headers.conf');
  });
});

describe('mode mock jamais construit (revue F1.1 — M8)', () => {
  it('vite build --mode mock échoue', () => {
    expect(() => config({ mode: 'mock', command: 'build', isSsrBuild: false, isPreview: false })).toThrow('Build refusé');
  });
  it('le serveur de dev en mode mock reste possible', () => {
    expect(() => config({ mode: 'mock', command: 'serve', isSsrBuild: false, isPreview: false })).not.toThrow();
  });
});
