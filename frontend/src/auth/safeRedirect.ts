/**
 * Anti open-redirect : n'accepte QUE des chemins internes à l'application.
 * Refuse : URL absolues (https://, javascript:, data:…), protocol-relative (//evil, /\evil),
 * caractères de contrôle, antislash, segments `.` / `..` (y compris encodés %2e, double encodage)
 * — car `new URL()` les normalise : `/.//evil.com` deviendrait `//evil.com`.
 * La SORTIE est revérifiée avec les mêmes règles.
 */
const FALLBACK = '/';
const MAX_LENGTH = 512;

function decodeFully(raw: string): string | null {
  let current = raw;
  for (let i = 0; i < 4; i++) {
    let next: string;
    try {
      next = decodeURIComponent(current);
    } catch {
      return null;
    }
    if (next === current) return current;
    current = next;
  }
  return null; // encodage imbriqué anormalement profond
}

function isSafeInternal(candidate: string): boolean {
  if (!candidate.startsWith('/') || candidate.startsWith('//')) return false;
  if (candidate.includes('\\')) return false;
  // eslint-disable-next-line no-control-regex -- on cherche justement les caractères de contrôle
  if (/[\u0000-\u001f\u007f\u2028\u2029]/.test(candidate)) return false;
  const path = candidate.split(/[?#]/, 1)[0] ?? '';
  return !path.split('/').some((segment) => segment === '.' || segment === '..');
}

export function safeRedirectPath(raw: string | null | undefined, fallback: string = FALLBACK): string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_LENGTH) return fallback;
  const decoded = decodeFully(raw);
  if (decoded === null || !isSafeInternal(raw) || !isSafeInternal(decoded)) return fallback;

  const base = 'https://app.invalid';
  let url: URL;
  try {
    url = new URL(raw, base);
  } catch {
    return fallback;
  }
  const out = `${url.pathname}${url.search}${url.hash}`;
  if (url.origin !== base || !isSafeInternal(out)) return fallback;
  const outDecoded = decodeFully(out);
  if (outDecoded === null || !isSafeInternal(outDecoded)) return fallback;
  return out;
}

/** Construit `/login?next=<chemin courant>` sans jamais y mettre une URL externe. */
export function loginPathWithNext(currentPath: string): string {
  const next = safeRedirectPath(currentPath, '');
  return next && next !== '/login' ? `/login?next=${encodeURIComponent(next)}` : '/login';
}
