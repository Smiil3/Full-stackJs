import { ApiError, isApiError, isErrorCode } from './errors';
import { parseAuthSession } from './guards';
import type { AuthSession, ErrorDetails } from './types';
import { clearAccessToken, getAccessToken, setAccessToken } from '../auth/tokenStore';

/**
 * Client API UNIQUE de l'application. Aucun autre module ne doit appeler `fetch` vers l'API.
 * - `credentials: 'include'` (cookie HttpOnly de refresh, Path=/api/v1/auth)
 * - `Authorization: Bearer` depuis la mémoire
 * - refresh silencieux sur 401 UNAUTHENTICATED avec UNE SEULE promesse partagée, rejeu unique
 * - échec du refresh (401) ⇒ événement `expired` ⇒ déconnexion propre côté AuthProvider
 */

/**
 * Base de l'API : chemin RELATIF obligatoire (même origine, cookies SameSite=Strict, CSP connect-src 'self').
 * Une URL absolue ou un chemin douteux fait échouer le démarrage plutôt que d'envoyer le Bearer ailleurs.
 */
export function resolveApiBase(raw: string | undefined): string {
  const value = raw ?? '/api/v1';
  if (!/^(\/[A-Za-z0-9_-]+)+$/.test(value)) throw new Error(`VITE_API_BASE_URL invalide : chemin relatif attendu (ex. /api/v1), reçu « ${value} »`);
  return value;
}
export const API_BASE_URL: string = resolveApiBase(import.meta.env.VITE_API_BASE_URL);
const CSRF_HEADER = { 'X-Requested-With': 'nuits-web' } as const;
const DEFAULT_TIMEOUT_MS = 15_000;
/** Rafraîchissement proactif : marge avant l'expiration de l'access token. */
const PROACTIVE_MARGIN_MS = 60_000;

// ---------------------------------------------------------------------------
// Événements de session (écoutés par l'AuthProvider)
// ---------------------------------------------------------------------------
export type AuthEvent = { type: 'session'; session: AuthSession } | { type: 'expired' } | { type: 'logout' };
type Listener = (e: AuthEvent) => void;
const listeners = new Set<Listener>();

export function onAuthEvent(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
function emit(e: AuthEvent): void {
  for (const l of listeners) l(e);
}

// ---------------------------------------------------------------------------
// Construction d'URL sûre
// ---------------------------------------------------------------------------
/**
 * Gabarit de chemin qui encode CHAQUE paramètre interpolé (`encodeURIComponent`).
 * `apiPath\`/orders/${id}/cancel\`` : un id malveillant ne peut pas changer de route.
 * `encodeURIComponent` laisse passer `.` et `..` : ces valeurs (et la valeur vide) sont REFUSÉES,
 * sinon `/orders/..` + `/cancel` deviendrait `/cancel` avec le Bearer.
 */
export function apiPath(strings: TemplateStringsArray, ...values: (string | number)[]): string {
  let out = strings[0] ?? '';
  values.forEach((v, i) => {
    const raw = String(v);
    if (raw === '' || raw === '.' || raw === '..') throw new Error('Paramètre de chemin API invalide');
    out += encodeURIComponent(raw) + (strings[i + 1] ?? '');
  });
  return out;
}

/** Refuse tout segment `.` / `..`, y compris encodé (%2e) : défense en profondeur si un chemin est construit à la main. */
function assertSafePath(path: string): void {
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\') || /[?#]/.test(path)) throw new Error('Chemin API invalide');
  for (const segment of path.split('/').slice(1)) {
    const normalized = segment.replace(/%2e/gi, '.');
    if (segment === '' || normalized === '.' || normalized === '..') throw new Error('Chemin API invalide');
  }
}

export type QueryValue = string | number | boolean | null | undefined;

function buildUrl(path: string, query?: Record<string, QueryValue>): string {
  assertSafePath(path);
  const qs = new URLSearchParams();
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === '') continue;
      qs.set(k, String(v));
    }
  }
  const s = qs.toString();
  return `${API_BASE_URL}${path}${s ? `?${s}` : ''}`;
}

// ---------------------------------------------------------------------------
// Bas niveau : un appel fetch + décodage des erreurs
// ---------------------------------------------------------------------------
export type ResponseKind = 'json' | 'blob';
export type RequestOptions = {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  query?: Record<string, QueryValue>;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** false : n'envoie pas de Bearer et ne tente pas de refresh (endpoints publics d'auth). */
  auth?: boolean;
  timeoutMs?: number;
  responseKind?: ResponseKind;
};

function combineSignals(timeoutMs: number, external?: AbortSignal): { signal: AbortSignal; dispose: () => void; timedOut: () => boolean } {
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, timeoutMs);
  const onAbort = () => {
    ctrl.abort();
  };
  if (external) {
    if (external.aborted) ctrl.abort();
    else external.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: ctrl.signal,
    timedOut: () => timedOut,
    dispose: () => {
      clearTimeout(timer);
      external?.removeEventListener('abort', onAbort);
    },
  };
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  if (Number.isFinite(n) && n >= 0) return Math.ceil(n);
  const date = Date.parse(value);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, Math.ceil((date - Date.now()) / 1000));
}

async function toApiError(res: Response): Promise<ApiError> {
  let code: ApiError['code'] = res.status >= 500 ? 'INTERNAL_ERROR' : 'UNEXPECTED_RESPONSE';
  let message = '';
  let details: ErrorDetails | undefined;
  try {
    const body: unknown = await res.json();
    if (body && typeof body === 'object' && 'error' in body) {
      const err = body.error;
      if (err && typeof err === 'object') {
        const e = err as { code?: unknown; message?: unknown; details?: unknown };
        if (isErrorCode(e.code)) code = e.code;
        if (typeof e.message === 'string') message = e.message;
        if (e.details && typeof e.details === 'object') details = e.details as ErrorDetails;
      }
    }
  } catch {
    // Corps non JSON (proxy, page HTML…) : on garde le code déduit du statut.
  }
  if (res.status === 429) code = 'RATE_LIMITED';
  return new ApiError({
    status: res.status,
    code,
    message: message || `HTTP ${res.status}`,
    details,
    retryAfter: parseRetryAfter(res.headers.get('Retry-After')),
  });
}

async function rawRequest<T>(path: string, opts: RequestOptions, token: string | null): Promise<T> {
  const url = buildUrl(path, opts.query); // hors du try : un chemin invalide n'est pas une « erreur réseau »
  const headers: Record<string, string> = { Accept: opts.responseKind === 'blob' ? '*/*' : 'application/json', ...opts.headers };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;

  const { signal, dispose, timedOut } = combineSignals(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, opts.signal);
  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method ?? 'GET',
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      credentials: 'include',
      cache: 'no-store',
      redirect: 'error',
      signal,
    });
  } catch (e) {
    dispose();
    if (timedOut()) throw new ApiError({ status: 0, code: 'TIMEOUT', message: 'timeout' });
    if (opts.signal?.aborted) throw e; // annulation volontaire (TanStack Query) : on propage telle quelle
    throw new ApiError({ status: 0, code: 'NETWORK_ERROR', message: 'network' });
  }
  try {
    if (!res.ok) throw await toApiError(res);
    if (res.status === 204) return undefined as T;
    if (opts.responseKind === 'blob') return (await res.blob()) as T;
    const text = await res.text();
    // Corps vide sur un statut qui doit en avoir un : on ne le transforme pas en `undefined` silencieux.
    if (!text) throw new ApiError({ status: res.status, code: 'UNEXPECTED_RESPONSE', message: 'empty body' });
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ApiError({ status: res.status, code: 'UNEXPECTED_RESPONSE', message: 'invalid json' });
    }
  } finally {
    dispose();
  }
}

// ---------------------------------------------------------------------------
// Session : génération + refresh partagé
// ---------------------------------------------------------------------------
/**
 * Génération de session : incrémentée à chaque login / logout / fin de session.
 * Un refresh démarré sous une génération antérieure est IGNORÉ à son retour (succès comme échec) :
 * - un logout pendant un refresh en vol ne voit pas le token réinjecté ;
 * - un 401 tardif d'un refresh de démarrage n'efface pas le token d'un login plus récent.
 */
let generation = 0;
let refreshPromise: Promise<AuthSession> | null = null;
let refreshGeneration = -1;
let proactiveTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Planifie le refresh proactif. Plancher : jamais avant la moitié de la durée de vie du token,
 * jamais moins de 10 s ⇒ un `expiresIn` court ne peut pas provoquer de boucle de refresh.
 */
export function proactiveDelayMs(expiresInSeconds: number): number {
  const lifetime = expiresInSeconds * 1000;
  return Math.max(10_000, lifetime / 2, lifetime - PROACTIVE_MARGIN_MS);
}

function scheduleProactiveRefresh(expiresInSeconds: number): void {
  clearTimeout(proactiveTimer);
  if (!getAccessToken()) return;
  proactiveTimer = setTimeout(() => {
    // Erreur réseau : on retentera de manière réactive au prochain 401.
    refreshSession().catch(() => undefined);
  }, proactiveDelayMs(expiresInSeconds));
}

/** Enregistre une session obtenue par login / refresh (token en mémoire seulement). */
function acceptSession(session: AuthSession): void {
  setAccessToken(session.accessToken, session.expiresIn);
  scheduleProactiveRefresh(session.expiresIn);
  emit({ type: 'session', session });
}

/** Vide l'état d'authentification local (sans appel réseau). */
export function dropSession(reason: 'expired' | 'logout'): void {
  generation++;
  clearTimeout(proactiveTimer);
  clearAccessToken();
  emit({ type: reason });
}

const sessionChanged = () => new ApiError({ status: 0, code: 'SESSION_CHANGED', message: 'session changed' });

/**
 * Rafraîchit la session. Tous les appelants concurrents partagent la MÊME promesse :
 * N requêtes en 401 simultanées ⇒ 1 seul POST /auth/refresh.
 * - 401 INVALID_REFRESH_TOKEN ⇒ session terminée (événement `expired`)
 * - autre erreur (réseau, 5xx, 403 CSRF_CHECK_FAILED…) ⇒ rejet SANS déconnexion
 * - session changée entre-temps (login/logout) ⇒ résultat ignoré, rejet SESSION_CHANGED
 */
export function refreshSession(): Promise<AuthSession> {
  if (refreshPromise && refreshGeneration === generation) return refreshPromise;
  const startedAt = generation;
  const promise = (async () => {
    try {
      const raw = await rawRequest<unknown>('/auth/refresh', { method: 'POST', headers: { ...CSRF_HEADER } }, null);
      if (startedAt !== generation) throw sessionChanged();
      const session = parseAuthSession(raw);
      acceptSession(session);
      return session;
    } catch (e) {
      if (startedAt !== generation) throw isApiError(e) && e.code === 'SESSION_CHANGED' ? e : sessionChanged();
      if (isApiError(e) && e.status === 401 && e.code === 'INVALID_REFRESH_TOKEN') dropSession('expired');
      throw e;
    } finally {
      if (refreshGeneration === startedAt) refreshPromise = null;
    }
  })();
  refreshPromise = promise;
  refreshGeneration = startedAt;
  return promise;
}

/** Attend la fin d'un refresh en vol (sans propager son résultat). */
async function settleRefresh(): Promise<void> {
  const pending = refreshPromise;
  if (pending) await pending.catch(() => undefined);
}

// ---------------------------------------------------------------------------
// API publique
// ---------------------------------------------------------------------------
export async function apiRequest<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const useAuth = opts.auth !== false;
  // Un refresh est en cours : on l'attend plutôt que d'envoyer un token sur le point d'être remplacé.
  if (useAuth) await settleRefresh();
  const token = useAuth ? getAccessToken() : null;
  try {
    return await rawRequest<T>(path, opts, token);
  } catch (e) {
    if (!useAuth || !isApiError(e) || e.status !== 401 || e.code !== 'UNAUTHENTICATED') throw e;
    // Le token a peut-être déjà été renouvelé par une requête concurrente : on ne refait pas de refresh.
    const current = getAccessToken();
    if (!current || current === token) {
      await refreshSession();
    }
    try {
      return await rawRequest<T>(path, opts, getAccessToken()); // rejeu UNIQUE
    } catch (retryError) {
      if (isApiError(retryError) && retryError.status === 401 && retryError.code === 'UNAUTHENTICATED') dropSession('expired');
      throw retryError;
    }
  }
}

/** Login : n'utilise pas de Bearer, enregistre la session. Tout refresh en vol est invalidé. */
export async function login(email: string, password: string): Promise<AuthSession> {
  generation++;
  const startedAt = generation;
  await settleRefresh(); // la réponse d'un refresh en vol ne doit pas écraser le cookie de ce login
  const raw = await rawRequest<unknown>('/auth/login', { method: 'POST', body: { email, password } }, null);
  const session = parseAuthSession(raw);
  if (startedAt !== generation) throw sessionChanged();
  acceptSession(session);
  return session;
}

/** Déconnexion : révoque côté serveur (best effort) puis vide TOUJOURS l'état local. */
export async function logout(): Promise<void> {
  const token = getAccessToken();
  dropSession('logout'); // local d'abord : plus aucun token utilisable, refresh en vol invalidé
  await settleRefresh(); // le serveur révoque ainsi la DERNIÈRE rotation du cookie
  try {
    await rawRequest<undefined>('/auth/logout', { method: 'POST', headers: { ...CSRF_HEADER } }, token);
  } catch {
    // Hors-ligne ou déjà expiré : la déconnexion locale a déjà eu lieu.
  }
}

/** Réservé aux tests. */
export function __resetClientForTests(): void {
  refreshPromise = null;
  generation++;
  clearTimeout(proactiveTimer);
  clearAccessToken();
  listeners.clear();
}
