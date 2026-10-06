/**
 * Anti open-redirect : n'accepte QUE des chemins internes à l'application.
 * Refuse : URL absolues (https://, javascript:, data:…), protocol-relative (//evil, /\evil),
 * caractères de contrôle, encodages détournés (%2F%2F, %5C), et tout ce qui ne commence pas par "/".
 */
const FALLBACK = '/';

export function safeRedirectPath(raw: string | null | undefined, fallback: string = FALLBACK): string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 512) return fallback;

  // Décodage itératif borné pour démasquer "%2F%2Fevil.com" ou des doubles encodages.
  let decoded = raw;
  for (let i = 0; i < 3; i++) {
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      return fallback;
    }
    if (next === decoded) break;
    decoded = next;
  }

  for (const candidate of [raw, decoded]) {
    if (!candidate.startsWith('/')) return fallback;
    if (candidate.startsWith('//') || candidate.startsWith('/\\')) return fallback;
    if (candidate.includes('\\')) return fallback;
    // eslint-disable-next-line no-control-regex -- on cherche justement les caractères de contrôle
    if (/[\u0000-\u001f\u007f]/.test(candidate)) return fallback;
  }

  // Vérification finale par le parseur d'URL du navigateur : l'origine doit rester la nôtre.
  const base = 'https://app.invalid';
  let url: URL;
  try {
    url = new URL(raw, base);
  } catch {
    return fallback;
  }
  if (url.origin !== base) return fallback;
  return `${url.pathname}${url.search}${url.hash}`;
}

/** Construit `/login?next=<chemin courant>` sans jamais y mettre une URL externe. */
export function loginPathWithNext(currentPath: string): string {
  const next = safeRedirectPath(currentPath, '');
  return next && next !== '/login' ? `/login?next=${encodeURIComponent(next)}` : '/login';
}
