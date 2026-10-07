import { expect, type APIRequestContext, type Page } from '@playwright/test';
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

/**
 * Crée et publie un événement propre au test (OWNER des Nuits) avec un type de place de capacité donnée :
 * aucune dépendance aux données du seed (rejouable).
 */
export async function createEvent(
  request: APIRequestContext,
  ownerPassword: string,
  capacity: number,
  opts: { priceCents?: number; startsInMs?: number; offlineCheckinEnabled?: boolean } = {},
): Promise<{ orgId: string; eventId: string; title: string; ticketTypeId: string }> {
  const priceCents = opts.priceCents ?? 1000;
  const owner = await apiLogin(request, 'owner@nuits.test', ownerPassword);
  const me = (await (await request.get(`${API}/auth/me`, { headers: { Authorization: `Bearer ${owner}` } })).json()) as { memberships: { orgId: string; orgSlug: string; role: string }[] };
  const orgId = me.memberships.find((m) => m.orgSlug === 'nuits-garonne')?.orgId ?? me.memberships.find((m) => m.role === 'OWNER')?.orgId ?? '';
  const day = 86_400_000;
  // Par défaut dans 30 jours ; pour le contrôle d'accès, dans la fenêtre v1.15 (début − 12 h ⇒ fin + 24 h).
  const startsAt = new Date(Date.now() + (opts.startsInMs ?? 30 * day));
  const title = `E2E ${Date.now()}`;
  const auth = { Authorization: `Bearer ${owner}` };
  const ev = (await (
    await request.post(`${API}/orgs/${orgId}/events`, {
      headers: auth,
      data: {
        title,
        isOnline: false,
        venue: 'Salle de test',
        startsAt: startsAt.toISOString(),
        endsAt: new Date(startsAt.getTime() + 3 * 3_600_000).toISOString(),
        timezone: 'Europe/Paris',
        salesStartAt: new Date(Date.now() - 3_600_000).toISOString(),
        salesEndAt: startsAt.toISOString(),
        // Annulation par l'acheteur possible jusqu'au début (événements de test proches).
        overrides: { cancellationDeadlineHours: 0 },
      },
    })
  ).json()) as { id: string };
  const tt = (await (await request.post(`${API}/orgs/${orgId}/events/${ev.id}/ticket-types`, { headers: auth, data: { name: 'Unique', capacity, priceCents } })).json()) as { id: string };
  expect((await request.post(`${API}/orgs/${orgId}/events/${ev.id}/publish`, { headers: auth })).ok()).toBe(true);
  if (opts.offlineCheckinEnabled) {
    expect((await request.patch(`${API}/orgs/${orgId}/events/${ev.id}`, { headers: auth, data: { offlineCheckinEnabled: true } })).ok()).toBe(true);
  }
  return { orgId, eventId: ev.id, title, ticketTypeId: tt.id };
}

/** Achat par virement validé par le gestionnaire : billet(s) payé(s) sans passer par le prestataire. */
export async function buyByTransfer(request: APIRequestContext, managerPassword: string, buyer: { email: string; password: string }, orgId: string, eventId: string, ticketTypeId: string, quantity = 1): Promise<{ orderId: string; qrs: string[] }> {
  const token = await apiLogin(request, buyer.email, buyer.password);
  const order = (await (
    await request.post(`${API}/orders`, { headers: { Authorization: `Bearer ${token}`, 'Idempotency-Key': crypto.randomUUID() }, data: { eventId, paymentMethod: 'TRANSFER', items: [{ ticketTypeId, quantity }] } })
  ).json()) as { id: string; totalCents: number };
  const manager = await apiLogin(request, 'manager@nuits.test', managerPassword);
  expect((await request.post(`${API}/orgs/${orgId}/orders/${order.id}/confirm-transfer`, { headers: { Authorization: `Bearer ${manager}` }, data: { receivedAmountCents: order.totalCents } })).ok()).toBe(true);
  const tickets = (await (await request.get(`${API}/me/tickets`, { headers: { Authorization: `Bearer ${token}` } })).json()) as { items: { orderId: string; qrPayload: string }[] };
  return { orderId: order.id, qrs: tickets.items.filter((t) => t.orderId === order.id).map((t) => t.qrPayload) };
}

/** Événement de test contrôlable maintenant (début dans 2 h). */
export const IN_CHECKIN_WINDOW = 2 * 3_600_000;

/**
 * Ouvre un événement depuis une liste paginée (catalogue public ou événements du back-office) : la base
 * de dev accumule les événements « E2E … » des campagnes précédentes, qui repoussent ceux du seed.
 */
export async function openEventFromCatalogue(page: Page, title: string): Promise<void> {
  const main = page.getByRole('main');
  const firstEvent = main.locator('a[href*="/events/"]:not([href$="/events/new"])').first();
  for (let i = 0; i < 20; i++) {
    await expect(firstEvent).toBeVisible();
    await expect(main.locator('[aria-busy="true"]')).toHaveCount(0);
    const link = main.getByRole('link', { name: title, exact: true });
    if ((await link.count()) > 0) {
      await link.first().click();
      return;
    }
    const next = main.getByRole('navigation', { name: 'Pagination' }).getByRole('button', { name: 'Suivant' });
    if ((await next.count()) === 0 || (await next.isDisabled())) break;
    const before = await firstEvent.getAttribute('href');
    await next.click();
    await expect.poll(() => firstEvent.getAttribute('href')).not.toBe(before); // nouvelle page affichée
  }
  throw new Error(`Événement introuvable : ${title}`);
}
