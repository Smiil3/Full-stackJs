/**
 * Outillage du faux serveur MSW : état partagé, erreurs au format du contrat, auth, rôles,
 * validation stricte (champs inconnus refusés), pagination, injection de pannes pour les tests.
 */
import { HttpResponse, delay, http, type DefaultBodyType, type HttpResponseResolver, type PathParams } from 'msw';
import type { ErrorCode, ErrorDetails, OrgRole, ValidationFieldError } from '../api/types';
import { createSeed, bump, type MockDb, type MockUser } from './state';

export const API = '*/api/v1';

// ---------------------------------------------------------------------------
// État
// ---------------------------------------------------------------------------
export const mock: { db: MockDb } = { db: createSeed() };

export function resetMockDb(now?: number): MockDb {
  mock.db = createSeed(now);
  faults.length = 0;
  control.latencyMs = 0;
  control.cancelBatchDelayMs = 300;
  return mock.db;
}

// ---------------------------------------------------------------------------
// Pannes injectables (tests + dev:mock via window.__nuitsMock)
// ---------------------------------------------------------------------------
export type Fault = {
  /** "POST /orders", "GET /events/:eventId"… (méthode + gabarit tel que déclaré). `*` = toutes. */
  route: string;
  status: number;
  code: ErrorCode;
  message?: string;
  details?: ErrorDetails;
  headers?: Record<string, string>;
  times?: number;
  /** true : coupe la connexion (erreur réseau) au lieu de répondre. */
  network?: boolean;
};
const faults: Fault[] = [];
export const control = { latencyMs: 0, cancelBatchDelayMs: 300 };

export function injectFault(f: Fault): void {
  faults.push({ times: 1, ...f });
}
export function clearFaults(): void {
  faults.length = 0;
}

// ---------------------------------------------------------------------------
// Erreurs
// ---------------------------------------------------------------------------
export class MockHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly details?: ErrorDetails,
    readonly headers?: Record<string, string>,
  ) {
    super(message);
  }
}

export function fail(status: number, code: ErrorCode, message: string, details?: ErrorDetails): never {
  throw new MockHttpError(status, code, message, details);
}
export const notFound = (): never => fail(404, 'NOT_FOUND', 'Ressource introuvable');

function errorResponse(e: MockHttpError) {
  return HttpResponse.json(
    { error: { code: e.code, message: e.message, ...(e.details ? { details: e.details } : {}) } },
    { status: e.status, headers: e.headers },
  );
}

type Ctx = { request: Request; params: PathParams; url: URL };
type Handler = (ctx: Ctx) => Response | Promise<Response>;

/** Déclare une route avec gestion d'erreurs, latence et pannes injectées. */
export function route(method: 'get' | 'post' | 'patch' | 'delete', path: string, handler: Handler) {
  const key = `${method.toUpperCase()} ${path}`;
  const resolver: HttpResponseResolver = async ({ request, params }) => {
    bump(mock.db, key);
    if (control.latencyMs > 0) await delay(control.latencyMs);
    const idx = faults.findIndex((f) => f.route === key || f.route === '*');
    if (idx >= 0) {
      const f = faults[idx] as Fault;
      if (f.times !== undefined && --f.times <= 0) faults.splice(idx, 1);
      if (f.network) return HttpResponse.error();
      return errorResponse(new MockHttpError(f.status, f.code, f.message ?? 'Erreur simulée', f.details, f.headers));
    }
    try {
      return await handler({ request, params, url: new URL(request.url) });
    } catch (e) {
      if (e instanceof MockHttpError) return errorResponse(e);
      console.error('[mock] erreur interne', e);
      return errorResponse(new MockHttpError(500, 'INTERNAL_ERROR', 'Erreur interne'));
    }
  };
  return http[method](`${API}${path}`, resolver);
}

export const json = (body: unknown, status = 200) => HttpResponse.json(body as DefaultBodyType, { status });
export const noContent = () => new HttpResponse(null, { status: 204 });

// ---------------------------------------------------------------------------
// Auth & rôles
// ---------------------------------------------------------------------------
export function currentUser(request: Request): MockUser {
  const header = request.headers.get('Authorization') ?? '';
  const m = /^Bearer (\S+)$/.exec(header);
  const session = m?.[1] ? mock.db.accessTokens.get(m[1]) : undefined;
  if (!session || session.expiresAt <= Date.now()) fail(401, 'UNAUTHENTICATED', 'Authentification requise');
  const user = mock.db.users.find((u) => u.id === session.userId);
  if (!user) return fail(401, 'UNAUTHENTICATED', 'Authentification requise');
  return user;
}

export function requireVerified(user: MockUser): void {
  if (!user.emailVerified) fail(403, 'EMAIL_NOT_VERIFIED', 'Email non vérifié');
}

const RANK: Record<OrgRole, number> = { SCANNER: 1, MANAGER: 2, OWNER: 3 };

/** Non-membre ⇒ 404 (on ne révèle pas l'existence du collectif). Rôle insuffisant ⇒ 403. */
export function requireOrgRole(request: Request, orgId: string, min: OrgRole): MockUser {
  const user = currentUser(request);
  const m = mock.db.memberships.find((x) => x.userId === user.id && x.orgId === orgId);
  if (!m || !mock.db.orgs.some((o) => o.id === orgId)) return notFound();
  if (RANK[m.role] < RANK[min]) fail(403, 'FORBIDDEN', 'Rôle insuffisant');
  return user;
}

export function requireCsrf(request: Request): void {
  if (request.headers.get('X-Requested-With') !== 'nuits-web') fail(403, 'CSRF_CHECK_FAILED', 'Contrôle anti-CSRF échoué');
}

// ---------------------------------------------------------------------------
// Validation stricte
// ---------------------------------------------------------------------------
type Body = Record<string, unknown>;

export class Validator {
  readonly errors: ValidationFieldError[] = [];
  constructor(readonly body: Body, private readonly prefix = '') {}

  private add(path: string, message: string) {
    this.errors.push({ path: this.prefix + path, message });
  }
  has(key: string): boolean {
    return key in this.body && this.body[key] !== undefined;
  }
  str(key: string, o: { min?: number; max?: number; optional?: boolean; nullable?: boolean; pattern?: RegExp } = {}): string | null | undefined {
    const v = this.body[key];
    if (v === undefined) {
      if (!o.optional) this.add(key, 'Champ requis');
      return undefined;
    }
    if (v === null && o.nullable) return null;
    if (typeof v !== 'string') {
      this.add(key, 'Doit être une chaîne');
      return undefined;
    }
    const t = v.trim();
    if (o.min !== undefined && t.length < o.min) this.add(key, `Au moins ${o.min} caractère(s)`);
    if (o.max !== undefined && v.length > o.max) this.add(key, `Au plus ${o.max} caractères`);
    if (o.pattern && !o.pattern.test(v)) this.add(key, 'Format invalide');
    return v;
  }
  email(key: string, o: { optional?: boolean; nullable?: boolean } = {}) {
    return this.str(key, { ...o, max: 254, pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/ });
  }
  int(key: string, o: { min?: number; max?: number; optional?: boolean; nullable?: boolean } = {}): number | null | undefined {
    const v = this.body[key];
    if (v === undefined) {
      if (!o.optional) this.add(key, 'Champ requis');
      return undefined;
    }
    if (v === null && o.nullable) return null;
    if (typeof v !== 'number' || !Number.isInteger(v)) {
      this.add(key, 'Doit être un entier');
      return undefined;
    }
    if (o.min !== undefined && v < o.min) this.add(key, `Minimum ${o.min}`);
    if (o.max !== undefined && v > o.max) this.add(key, `Maximum ${o.max}`);
    return v;
  }
  bool(key: string, o: { optional?: boolean; nullable?: boolean } = {}): boolean | null | undefined {
    const v = this.body[key];
    if (v === undefined) {
      if (!o.optional) this.add(key, 'Champ requis');
      return undefined;
    }
    if (v === null && o.nullable) return null;
    if (typeof v !== 'boolean') {
      this.add(key, 'Doit être un booléen');
      return undefined;
    }
    return v;
  }
  date(key: string, o: { optional?: boolean; nullable?: boolean } = {}): string | null | undefined {
    const v = this.str(key, { ...o, pattern: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?Z$/ });
    if (typeof v === 'string' && Number.isNaN(Date.parse(v))) this.add(key, 'Date invalide');
    return v;
  }
  oneOf<T extends string>(key: string, values: readonly T[], o: { optional?: boolean } = {}): T | undefined {
    const v = this.body[key];
    if (v === undefined) {
      if (!o.optional) this.add(key, 'Champ requis');
      return undefined;
    }
    if (typeof v !== 'string' || !(values as readonly string[]).includes(v)) {
      this.add(key, `Valeur attendue : ${values.join(', ')}`);
      return undefined;
    }
    return v as T;
  }
  uuid(key: string, o: { optional?: boolean } = {}) {
    return this.str(key, { ...o, pattern: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i });
  }
  custom(path: string, message: string) {
    this.add(path, message);
  }
  done(): void {
    if (this.errors.length) fail(400, 'VALIDATION_ERROR', 'Entrée invalide', { fields: this.errors });
  }
}

/** Lit un body JSON objet ; tout champ hors `allowed` ⇒ 400 VALIDATION_ERROR. */
export async function readBody(request: Request, allowed: readonly string[]): Promise<Validator> {
  let raw: unknown;
  try {
    const text = await request.text();
    if (text.length > 10_240) return fail(413, 'PAYLOAD_TOO_LARGE', 'Corps trop volumineux');
    if (text && !(request.headers.get('Content-Type') ?? '').startsWith('application/json')) return fail(415, 'UNSUPPORTED_MEDIA_TYPE', 'JSON attendu');
    raw = text ? JSON.parse(text) : {};
  } catch (e) {
    if (e instanceof MockHttpError) throw e;
    return fail(400, 'VALIDATION_ERROR', 'JSON invalide');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail(400, 'VALIDATION_ERROR', 'Objet attendu');
  const body = raw as Body;
  const unknown = Object.keys(body).filter((k) => !allowed.includes(k));
  if (unknown.length) fail(400, 'VALIDATION_ERROR', 'Champs inconnus', { fields: unknown.map((k) => ({ path: k, message: 'Champ non autorisé' })) });
  return new Validator(body);
}

/** Query stricte : paramètres inconnus refusés, pagination bornée. */
export function readQuery(url: URL, allowed: readonly string[]): { page: number; pageSize: number; get: (k: string) => string | undefined } {
  const keys = [...url.searchParams.keys()];
  const all = ['page', 'pageSize', ...allowed];
  const unknown = keys.filter((k) => !all.includes(k));
  if (unknown.length) fail(400, 'VALIDATION_ERROR', 'Paramètres inconnus', { fields: unknown.map((k) => ({ path: k, message: 'Paramètre non autorisé' })) });
  const num = (k: string, def: number, min: number, max: number) => {
    const v = url.searchParams.get(k);
    if (v === null) return def;
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max) fail(400, 'VALIDATION_ERROR', 'Pagination invalide', { fields: [{ path: k, message: `Entre ${min} et ${max}` }] });
    return n;
  };
  return { page: num('page', 1, 1, 1000), pageSize: num('pageSize', 20, 1, 100), get: (k) => url.searchParams.get(k) ?? undefined };
}

export function paginate<T>(items: T[], page: number, pageSize: number) {
  return { items: items.slice((page - 1) * pageSize, page * pageSize), page, pageSize, total: items.length };
}

export function param(params: PathParams, key: string): string {
  const v = params[key];
  return typeof v === 'string' ? v : notFound();
}

export function audit(orgId: string, actor: MockUser | null, action: string, target: string, meta: unknown = null): void {
  const member = actor && mock.db.memberships.some((m) => m.orgId === orgId && m.userId === actor.id);
  const actorEmail = !actor ? null : member ? actor.email : actor.isPlatformAdmin ? 'Administrateur plateforme' : actor.email;
  mock.db.audit.unshift({ id: crypto.randomUUID(), orgId, actorEmail, action, target, meta, createdAt: new Date().toISOString() });
}
