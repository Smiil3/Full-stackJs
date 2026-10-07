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
const VALID_KEY = '{"kty":"OKP","crv":"Ed25519","x":"AhigxYmL0SJe6AbpQgVy6DOurnhSVLQv0CXQFgslXDE"}';

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

  it('F6-B7 : build de production refusé si VITE_PSP_ORIGIN n’est pas une origine https', () => {
    const previous = process.env.VITE_PSP_ORIGIN;
    const build = () => config({ mode: 'production', command: 'build', isSsrBuild: false, isPreview: false });
    try {
      for (const bad of ['http://localhost:4001', 'http://pay.psp.example', 'https://pay.psp.example/chemin', 'pas-une-url']) {
        process.env.VITE_PSP_ORIGIN = bad;
        expect(build, bad).toThrow(/VITE_PSP_ORIGIN/);
      }
      process.env.VITE_PSP_ORIGIN = 'https://pay.psp.example';
      process.env.VITE_TICKET_PUBLIC_KEY_JWK = VALID_KEY;
      expect(build).not.toThrow();
    } finally {
      if (previous === undefined) delete process.env.VITE_PSP_ORIGIN;
      else process.env.VITE_PSP_ORIGIN = previous;
      delete process.env.VITE_TICKET_PUBLIC_KEY_JWK;
    }
  });

  it('B14 : build de production refusé sans clé publique Ed25519 des billets valide', () => {
    const build = () => config({ mode: 'production', command: 'build', isSsrBuild: false, isPreview: false });
    process.env.VITE_PSP_ORIGIN = 'https://pay.psp.example';
    try {
      for (const bad of ['', 'pas du json', '{"kty":"RSA","n":"x","e":"AQAB"}', '{"kty":"OKP","crv":"X25519","x":"AhigxYmL0SJe6AbpQgVy6DOurnhSVLQv0CXQFgslXDE"}', '{"kty":"OKP","crv":"Ed25519","x":"court"}', '{"kty":"OKP","crv":"Ed25519","x":"AhigxYmL0SJe6AbpQgVy6DOurnhSVLQv0CXQFgslXDE","d":"secret"}']) {
        process.env.VITE_TICKET_PUBLIC_KEY_JWK = bad;
        expect(build, bad).toThrow(/VITE_TICKET_PUBLIC_KEY_JWK/);
      }
      process.env.VITE_TICKET_PUBLIC_KEY_JWK = VALID_KEY;
      expect(build).not.toThrow();
    } finally {
      delete process.env.VITE_PSP_ORIGIN;
      delete process.env.VITE_TICKET_PUBLIC_KEY_JWK;
    }
  });

  it('F6-B1 : index.html n’envoie aucun Referer (même politique que l’en-tête)', () => {
    const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
    const metas = html.match(/<meta name="referrer" content="([^"]+)"/g) ?? [];
    expect(metas).toEqual(['<meta name="referrer" content="no-referrer"']);
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
    // Revue finale : l'adresse client n'est jamais reprise de l'en-tête envoyé par le client.
    expect(nginx).toContain('proxy_set_header X-Forwarded-For $remote_addr;');
    expect(nginx).not.toContain('$proxy_add_x_forwarded_for');
    expect(nginx).toContain('ssl_protocols TLSv1.2 TLSv1.3;');
    expect(nginx).toMatch(/client_max_body_size 200k;/);
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
