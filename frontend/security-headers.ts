/**
 * En-têtes de sécurité HTTP du frontend. Source unique pour `vite dev`, `vite preview`
 * et deploy/nginx.conf.example (à garder synchronisé — vérifié par vite.config.test.ts).
 */
const PROD_CSP: Record<string, string> = {
  'default-src': "'self'",
  'script-src': "'self'",
  'style-src': "'self'",
  // Images de la même origine seulement : QR dessinés en <canvas>, icônes en sprite local, aucune image
  // en data: ni blob: (l'export CSV utilise une URL blob: pour un TÉLÉCHARGEMENT, pas une image).
  'img-src': "'self'",
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

/**
 * `deployed` : politique du site déployé en HTTPS (nginx), avec `upgrade-insecure-requests` (toute
 * ressource http est demandée en https). Absente de l'aperçu local, servi en http://localhost.
 */
export function contentSecurityPolicy(dev: boolean, deployed = false): string {
  const policy = dev ? { ...PROD_CSP, ...DEV_RELAXATIONS } : PROD_CSP;
  const directives = Object.entries(policy).map(([k, v]) => `${k} ${v}`);
  if (deployed && !dev) directives.push('upgrade-insecure-requests');
  return directives.join('; ');
}

export function securityHeaders(dev: boolean, deployed = false): Record<string, string> {
  return {
    'Content-Security-Policy': contentSecurityPolicy(dev, deployed),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(self), microphone=(), geolocation=(), payment=(), usb=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'X-Frame-Options': 'DENY',
  };
}
