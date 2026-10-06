import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { API, apiLogin, createVerifiedBuyer, setOfflineCheckin } from './fixtures';

/**
 * Contrôle d'accès contre l'API RÉELLE : billets obtenus par virement validé (données créées par le
 * test, pas dépendantes de l'état), scan en ligne OK puis DÉJÀ UTILISÉ, puis hors-ligne et resynchro.
 */
const PASSWORD = process.env.SEED_PASSWORD ?? '';
/** Achète `qty` places « Parterre » de « Jazz au Hangar » par virement, validé par le gestionnaire. */
async function buyTickets(request: APIRequestContext, qty: number): Promise<{ eventId: string; orgId: string; qrs: string[] }> {
  const fresh = await createVerifiedBuyer(request);
  const buyer = await apiLogin(request, fresh.email, fresh.password);
  const events = (await (await request.get(`${API}/events?pageSize=50`)).json()) as { items: { id: string; title: string; orgId: string }[] };
  const event = events.items.find((e) => e.title === 'Jazz au Hangar');
  if (!event) throw new Error('événement de seed introuvable');
  const detail = (await (await request.get(`${API}/events/${event.id}`)).json()) as { ticketTypes: { id: string; name: string }[] };
  const tt = detail.ticketTypes.find((t) => t.name === 'Parterre');
  const order = (await (
    await request.post(`${API}/orders`, {
      headers: { Authorization: `Bearer ${buyer}`, 'Idempotency-Key': crypto.randomUUID() },
      data: { eventId: event.id, paymentMethod: 'TRANSFER', items: [{ ticketTypeId: tt?.id, quantity: qty }] },
    })
  ).json()) as { id: string; totalCents: number };
  const manager = await apiLogin(request, 'manager@nuits.test', PASSWORD);
  const confirm = await request.post(`${API}/orgs/${event.orgId}/orders/${order.id}/confirm-transfer`, { headers: { Authorization: `Bearer ${manager}` }, data: { receivedAmountCents: order.totalCents } });
  expect(confirm.ok()).toBe(true);
  const tickets = (await (await request.get(`${API}/me/tickets`, { headers: { Authorization: `Bearer ${buyer}` } })).json()) as { items: { orderId: string; qrPayload: string }[] };
  return { eventId: event.id, orgId: event.orgId, qrs: tickets.items.filter((t) => t.orderId === order.id).map((t) => t.qrPayload) };
}

async function scan(page: Page, code: string) {
  await page.getByLabel('Saisie manuelle du code').fill(code);
  await page.getByRole('button', { name: 'Vérifier' }).click();
  const result = page.getByRole('alertdialog');
  await expect(result).toBeVisible();
  return result;
}

test('scanner : OK puis DÉJÀ UTILISÉ en ligne ; hors-ligne puis resynchronisation', async ({ page, context, request }) => {
  const { eventId, orgId, qrs } = await buyTickets(request, 2);
  expect(qrs).toHaveLength(2);
  await setOfflineCheckin(request, PASSWORD, orgId, eventId, true); // mode secours activé par le propriétaire

  await page.goto('/login?next=%2Fscan');
  await page.getByLabel('Adresse email').fill('scanner@nuits.test');
  await page.getByLabel('Mot de passe').fill(PASSWORD);
  await page.getByRole('button', { name: 'Se connecter' }).click();
  const card = page.locator('li', { has: page.getByRole('heading', { name: 'Jazz au Hangar' }) });
  await card.getByRole('button', { name: /Préparer l’entrée hors-ligne|Mettre à jour la liste hors-ligne/ }).click();
  await expect(card.getByText(/liste de \d+ billets téléchargée/)).toBeVisible();
  await card.getByRole('link', { name: 'Contrôler les entrées' }).click();
  await expect(page.getByText(/risque de double entrée/)).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/scan/${orgId}/${eventId}$`));

  // En ligne
  let result = await scan(page, qrs[0] ?? '');
  await expect(result).toContainText('OK');
  await result.getByRole('button', { name: 'Scanner le suivant' }).click();
  result = await scan(page, qrs[0] ?? '');
  await expect(result).toContainText(/DÉJÀ UTILISÉ à \d{2}:\d{2}/);
  await result.getByRole('button', { name: 'Scanner le suivant' }).click(); // un refus reste affiché jusqu'à un appui

  // Hors-ligne
  await context.setOffline(true);
  await expect(page.locator('.badge', { hasText: 'Hors-ligne' })).toBeVisible();
  result = await scan(page, qrs[1] ?? '');
  await expect(result).toContainText('OK');
  await expect(result).toContainText('Vérifié hors-ligne');
  await expect(page.getByText(/Vérification locale/)).toBeVisible();
  await expect(page.getByText(/1 scan en attente de synchro/)).toBeVisible();

  // Retour du réseau : synchro automatique
  await context.setOffline(false);
  await expect(page.getByText(/0 scan en attente de synchro/)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/Synchronisé : 1 entrée\(s\) confirmée\(s\)/)).toBeVisible();

  // Le serveur sait désormais que le 2ᵉ billet est utilisé
  result = await scan(page, qrs[1] ?? '');
  await expect(result).toContainText('DÉJÀ UTILISÉ');
});
