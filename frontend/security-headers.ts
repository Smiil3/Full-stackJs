/**
 * En-têtes de sécurité HTTP du frontend. Source unique pour `vite dev`, `vite preview`
 * et deploy/nginx.conf.example (à garder synchronisé — vérifié par vite.config.test.ts).
 */
const PROD_CSP: Record<string, string> = {
  'default-src': "'self'",
  'script-src': "'self'",
  'style-src': "'self'",
  'img-src': "'self' data: blob:",
  'connect-src': "'self'",
  'worker-src': "'self'",
  'manifest-src': "'self'",
  'frame-ancestors': "'none'",
  'object-src': "'none'",
  'base-uri': "'none'",
  'form-action': "'self'",
};

/**
 * Serveur de DEV uniquement : le préambule React Fast Refresh est un script inline, les CSS sont
 * injectées en <style> et le HMR passe par WebSocket. Jamais utilisé pour `preview` ni en production.
 */
const DEV_RELAXATIONS: Record<string, string> = {
  'script-src': "'self' 'unsafe-inline'",
  'style-src': "'self' 'unsafe-inline'",
  'connect-src': "'self' ws://localhost:5173",
};

export function contentSecurityPolicy(dev: boolean): string {
  const policy = dev ? { ...PROD_CSP, ...DEV_RELAXATIONS } : PROD_CSP;
  return Object.entries(policy)
    .map(([k, v]) => `${k} ${v}`)
    .join('; ');
}

export function securityHeaders(dev: boolean): Record<string, string> {
  return {
    'Content-Security-Policy': contentSecurityPolicy(dev),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(self), microphone=(), geolocation=(), payment=(), usb=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'X-Frame-Options': 'DENY',
  };
}
