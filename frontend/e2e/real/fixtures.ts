import { expect, type APIRequestContext } from '@playwright/test';
import { waitForLink } from './mailpit';

export const API = 'http://localhost:4000/api/v1';
const ORIGIN = { Origin: 'http://localhost:5173' };

/**
 * Crée un acheteur NEUF et vérifié (inscription + lien Mailpit) : les tests ne dépendent pas de l'état
 * de la base (plafonds par personne, commandes précédentes) et restent rejouables.
 */
export async function createVerifiedBuyer(request: APIRequestContext): Promise<{ email: string; password: string }> {
  const email = `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
  const password = 'une phrase de passe e2e solide';
  const reg = await request.post(`${API}/auth/register`, { data: { email, password, displayName: 'Testeur E2E' } });
  expect(reg.status()).toBe(202);
  const link = await waitForLink(email, '/verify-email');
  const token = new URL(link, 'http://x').searchParams.get('token');
  const verify = await request.post(`${API}/auth/verify-email`, { data: { token } });
  expect(verify.status()).toBe(204);
  return { email, password };
}

export async function apiLogin(request: APIRequestContext, email: string, password: string): Promise<string> {
  const res = await request.post(`${API}/auth/login`, { data: { email, password }, headers: ORIGIN });
  expect(res.ok()).toBe(true);
  return ((await res.json()) as { accessToken: string }).accessToken;
}

/** Active / désactive le mode secours hors-ligne d'un événement (OWNER), pour des tests rejouables. */
export async function setOfflineCheckin(request: APIRequestContext, ownerPassword: string, orgId: string, eventId: string, enabled: boolean): Promise<void> {
  const owner = await apiLogin(request, 'owner@nuits.test', ownerPassword);
  const res = await request.patch(`${API}/orgs/${orgId}/events/${eventId}`, { headers: { Authorization: `Bearer ${owner}` }, data: { offlineCheckinEnabled: enabled } });
  expect(res.ok()).toBe(true);
}
