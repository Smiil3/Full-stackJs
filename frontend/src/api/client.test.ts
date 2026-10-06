import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getAccessToken } from '../auth/tokenStore';
import { injectFault, mock } from '../mocks/core';
import { server } from '../mocks/server';
import { DEMO_PASSWORD } from '../mocks/state';
import { apiPath, apiRequest, login, logout, onAuthEvent, refreshSession, resolveApiBase, type AuthEvent } from './client';
import { ApiError } from './errors';
import type { User } from './types';

const BUYER = 'acheteur@example.test';

/** Invalide côté « serveur » tous les access tokens émis (simule leur expiration). */
function expireAllAccessTokens() {
  mock.db.accessTokens.clear();
}

const calls = (key: string) => mock.db.calls.get(key) ?? 0;

describe('client API — refresh silencieux', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('N requêtes en 401 simultanées ⇒ UN SEUL POST /auth/refresh, puis rejeu de chacune', async () => {
    await login(BUYER, DEMO_PASSWORD);
    const firstToken = getAccessToken();
    expireAllAccessTokens();

    const results = await Promise.all(Array.from({ length: 8 }, () => apiRequest<User>('/auth/me')));

    expect(results.every((u) => u.email === BUYER)).toBe(true);
    expect(calls('POST /auth/refresh')).toBe(1);
    expect(calls('GET /auth/me')).toBe(16); // 8 envois initiaux + 8 rejeux, pas plus
    expect(getAccessToken()).not.toBe(firstToken);
  });

  it('appels concurrents de refreshSession() partagent la même promesse', async () => {
    await login(BUYER, DEMO_PASSWORD);
    const [a, b, c] = await Promise.all([refreshSession(), refreshSession(), refreshSession()]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(calls('POST /auth/refresh')).toBe(1);
  });

  it('envoie X-Requested-With et credentials include sur /auth/refresh et /auth/logout', async () => {
    const seen: { path: string; xrw: string | null; credentials: RequestCredentials }[] = [];
    server.events.on('request:start', ({ request }) => {
      const path = new URL(request.url).pathname;
      if (path.endsWith('/auth/refresh') || path.endsWith('/auth/logout')) {
        seen.push({ path, xrw: request.headers.get('X-Requested-With'), credentials: request.credentials });
      }
    });
    await login(BUYER, DEMO_PASSWORD);
    await refreshSession();
    await logout();
    server.events.removeAllListeners();
    expect(seen).toHaveLength(2);
    for (const s of seen) {
      expect(s.xrw).toBe('nuits-web');
      expect(s.credentials).toBe('include');
    }
  });

  it('rejoue UNE seule fois : si le rejeu est encore en 401, la session est terminée', async () => {
    await login(BUYER, DEMO_PASSWORD);
    const events: AuthEvent['type'][] = [];
    onAuthEvent((e) => events.push(e.type));
    server.use(http.get('*/api/v1/auth/me', () => HttpResponse.json({ error: { code: 'UNAUTHENTICATED', message: 'x' } }, { status: 401 })));

    await expect(apiRequest('/auth/me')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(calls('POST /auth/refresh')).toBe(1);
    expect(events).toContain('expired');
    expect(getAccessToken()).toBeNull();
  });

  it('refresh refusé (INVALID_REFRESH_TOKEN) ⇒ déconnexion propre, token effacé', async () => {
    await login(BUYER, DEMO_PASSWORD);
    const events: AuthEvent['type'][] = [];
    onAuthEvent((e) => events.push(e.type));
    expireAllAccessTokens();
    mock.db.refreshCookie = null; // cookie révoqué / expiré

    await expect(apiRequest('/auth/me')).rejects.toMatchObject({ code: 'INVALID_REFRESH_TOKEN' });
    expect(events).toEqual(['expired']);
    expect(getAccessToken()).toBeNull();
  });

  it('erreur réseau pendant le refresh ⇒ PAS de déconnexion (mode hors-ligne)', async () => {
    await login(BUYER, DEMO_PASSWORD);
    const events: AuthEvent['type'][] = [];
    onAuthEvent((e) => events.push(e.type));
    injectFault({ route: 'POST /auth/refresh', status: 0, code: 'INTERNAL_ERROR', network: true });

    await expect(refreshSession()).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    expect(events).toEqual([]);
    expect(getAccessToken()).not.toBeNull();
  });

  it('INVALID_CREDENTIALS (ex. mauvais mot de passe actuel) ne déclenche PAS de refresh', async () => {
    await login(BUYER, DEMO_PASSWORD);
    await expect(
      apiRequest('/auth/change-password', { method: 'POST', body: { currentPassword: 'faux-mot-de-passe', newPassword: 'nouveau-mot-de-passe-2026' } }),
    ).rejects.toMatchObject({ status: 401, code: 'INVALID_CREDENTIALS' });
    expect(calls('POST /auth/refresh')).toBe(0);
    expect(getAccessToken()).not.toBeNull();
  });

  it('les endpoints publics (auth:false) n’envoient pas de Bearer et ne tentent pas de refresh', async () => {
    await login(BUYER, DEMO_PASSWORD);
    let authHeader: string | null = 'non lu';
    server.events.on('request:start', ({ request }) => {
      if (request.url.includes('/events')) authHeader = request.headers.get('Authorization');
    });
    await apiRequest('/events', { auth: false });
    server.events.removeAllListeners();
    expect(authHeader).toBeNull();
  });
});

describe('client API — erreurs', () => {
  it('décode le format d’erreur du contrat (code, details)', async () => {
    injectFault({ route: 'GET /events', status: 409, code: 'SOLD_OUT', details: { ticketTypeId: 'abc' } });
    const err = await apiRequest('/events', { auth: false }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 409, code: 'SOLD_OUT', details: { ticketTypeId: 'abc' } });
  });

  it('429 : lit Retry-After', async () => {
    injectFault({ route: 'POST /auth/login', status: 429, code: 'RATE_LIMITED', headers: { 'Retry-After': '30' } });
    await expect(login(BUYER, 'x')).rejects.toMatchObject({ code: 'RATE_LIMITED', retryAfter: 30 });
  });

  it('réponse non JSON en 502 ⇒ INTERNAL_ERROR, sans fuite du corps', async () => {
    server.use(http.get('*/api/v1/events', () => new HttpResponse('<html>Bad gateway</html>', { status: 502 })));
    await expect(apiRequest('/events', { auth: false })).rejects.toMatchObject({ code: 'INTERNAL_ERROR', status: 502 });
  });

  it('coupure réseau ⇒ NETWORK_ERROR', async () => {
    injectFault({ route: 'GET /events', status: 0, code: 'INTERNAL_ERROR', network: true });
    await expect(apiRequest('/events', { auth: false })).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
  });
});

describe('apiPath / construction d’URL (revue F1.1 — H3, B3)', () => {
  it('encode chaque paramètre interpolé (pas de traversée de chemin)', () => {
    expect(apiPath`/orders/${'../admin/orgs'}/cancel`).toBe('/orders/..%2Fadmin%2Forgs/cancel');
    expect(apiPath`/orgs/${'a?b#c'}/events`).toBe('/orgs/a%3Fb%23c/events');
  });

  it.each(['', '.', '..'])('refuse la valeur de paramètre « %s »', (v) => {
    expect(() => apiPath`/orders/${v}/cancel`).toThrow('Paramètre de chemin API invalide');
  });

  it.each(['/orders/../cancel', '/orders/./x', '/orders/%2e%2e/cancel', '/orders/%2E/x', '//evil/x', '/a//b', '/a\\b', '/a?b=1', 'orders'])(
    'apiRequest refuse le chemin « %s » sans envoyer de requête',
    async (path) => {
      await login(BUYER, DEMO_PASSWORD);
      const before = [...mock.db.calls.values()].reduce((a, b) => a + b, 0);
      await expect(apiRequest(path)).rejects.toThrow('Chemin API invalide');
      expect([...mock.db.calls.values()].reduce((a, b) => a + b, 0)).toBe(before);
    },
  );

  it('VITE_API_BASE_URL : chemin relatif seulement', () => {
    expect(resolveApiBase(undefined)).toBe('/api/v1');
    expect(resolveApiBase('/api/v2')).toBe('/api/v2');
    for (const bad of ['https://evil.example/api', '//evil.example/api', 'api/v1', '/api/v1/', '/api/../x', '/api/v1?x=1', '']) {
      expect(() => resolveApiBase(bad)).toThrow('VITE_API_BASE_URL invalide');
    }
  });
});
