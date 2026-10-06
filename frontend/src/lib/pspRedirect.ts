import { safeRedirectPath } from '../auth/safeRedirect';

export type PspTarget = { kind: 'internal'; path: string } | { kind: 'external'; url: string };

const DEFAULT_DEV_PSP = 'http://localhost:4001';

function allowedPspOrigin(configured: string | undefined, isProd: boolean): string | null {
  const raw = configured ?? (isProd ? undefined : DEFAULT_DEV_PSP);
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.origin !== raw.replace(/\/$/, '')) return null; // origine seule, sans chemin
    if (u.protocol === 'https:') return u.origin;
    if (u.protocol === 'http:' && !isProd && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')) return u.origin;
    return null;
  } catch {
    return null;
  }
}

/**
 * Valide le `redirectUrl` renvoyé par POST /orders/:id/checkout avant de quitter l'application :
 * uniquement notre origine (navigation interne) ou l'origine du PSP configurée (VITE_PSP_ORIGIN).
 * Tout le reste (javascript:, autre domaine, http en prod…) est refusé.
 */
export function resolvePspRedirect(
  redirectUrl: string,
  env: { appOrigin: string; pspOrigin: string | undefined; isProd: boolean },
): PspTarget | null {
  let url: URL;
  try {
    url = new URL(redirectUrl);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  if (url.origin === env.appOrigin) {
    const path = safeRedirectPath(`${url.pathname}${url.search}${url.hash}`, '');
    return path ? { kind: 'internal', path } : null;
  }
  const psp = allowedPspOrigin(env.pspOrigin, env.isProd);
  if (psp && url.origin === psp) return { kind: 'external', url: url.href };
  return null;
}

export function currentPspEnv() {
  return { appOrigin: window.location.origin, pspOrigin: import.meta.env.VITE_PSP_ORIGIN, isProd: import.meta.env.PROD };
}
