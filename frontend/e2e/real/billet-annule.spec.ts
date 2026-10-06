import { expect, test } from '@playwright/test';
import { API, apiLogin, createVerifiedBuyer } from './fixtures';

/** Billet d'une commande remboursée (annulation par l'acheteur) ⇒ « BILLET ANNULÉ » à l'entrée. */
const PASSWORD = process.env.SEED_PASSWORD ?? '';
test.skip(!PASSWORD, 'SEED_PASSWORD requis');

test('commande remboursée ⇒ scan « BILLET ANNULÉ » (en ligne et hors-ligne après mise à jour de la liste)', async ({ page, context, request }) => {
  // Achat par virement validé (données propres au test), puis annulation par l'acheteur depuis l'interface.
  const account = await createVerifiedBuyer(request);
  const buyerToken = await apiLogin(request, account.email, account.password);
  const events = (await (await request.get(`${API}/events?pageSize=50`)).json()) as { items: { id: string; title: string; orgId: string }[] };
  const event = events.items.find((e) => e.title === 'Jazz au Hangar');
  if (!event) throw new Error('événement de seed introuvable');
  const detail = (await (await request.get(`${API}/events/${event.id}`)).json()) as { ticketTypes: { id: string; name: string }[] };
  const order = (await (
    await request.post(`${API}/orders`, {
      headers: { Authorization: `Bearer ${buyerToken}`, 'Idempotency-Key': crypto.randomUUID() },
      data: { eventId: event.id, paymentMethod: 'TRANSFER', items: [{ ticketTypeId: detail.ticketTypes.find((t) => t.name === 'Parterre')?.id, quantity: 1 }] },
    })
  ).json()) as { id: string; totalCents: number };
  const manager = await apiLogin(request, 'manager@nuits.test', PASSWORD);
  expect((await request.post(`${API}/orgs/${event.orgId}/orders/${order.id}/confirm-transfer`, { headers: { Authorization: `Bearer ${manager}` }, data: { receivedAmountCents: order.totalCents } })).ok()).toBe(true);
  const { items } = (await (await request.get(`${API}/me/tickets`, { headers: { Authorization: `Bearer ${buyerToken}` } })).json()) as { items: { qrPayload: string }[] };
  const qr = items[0]?.qrPayload ?? '';

  // Le scanner prépare sa liste AVANT l'annulation (cas réel : liste téléchargée le matin).
  await page.goto('/login?next=%2Fscan');
  await page.getByLabel('Adresse email').fill('scanner@nuits.test');
  await page.getByLabel('Mot de passe').fill(PASSWORD);
  await page.getByRole('button', { name: 'Se connecter' }).click();
  const card = page.locator('li', { has: page.getByRole('heading', { name: 'Jazz au Hangar' }) });
  await card.getByRole('button', { name: /Préparer l’entrée hors-ligne|Mettre à jour la liste hors-ligne/ }).click();
  await card.getByRole('link', { name: 'Contrôler les entrées' }).click();

  // Annulation self-service par l'acheteur, via l'interface (confirmation explicite du montant).
  const buyerPage = await (await page.context().browser()?.newContext({ ...test.info().project.use }))?.newPage();
  if (!buyerPage) throw new Error('navigateur indisponible');
  await buyerPage.goto(`/login?next=${encodeURIComponent(`/orders/${order.id}`)}`);
  await buyerPage.getByLabel('Adresse email').fill(account.email);
  await buyerPage.getByLabel('Mot de passe').fill(account.password);
  await buyerPage.getByRole('button', { name: 'Se connecter' }).click();
  await buyerPage.getByRole('button', { name: 'Annuler la commande' }).click();
  await expect(buyerPage.getByRole('dialog')).toContainText(/Montant remboursé/);
  await buyerPage.getByRole('button', { name: 'Oui, annuler la commande' }).click();
  await expect(buyerPage.getByText(/Commande annulée et remboursée/)).toBeVisible();

  // En ligne : le serveur répond « annulé ».
  await page.getByLabel('Saisie manuelle du code').fill(qr);
  await page.getByRole('button', { name: 'Vérifier' }).click();
  await expect(page.getByRole('alertdialog')).toContainText('BILLET ANNULÉ');
  await page.getByRole('alertdialog').getByRole('button', { name: 'Scanner le suivant' }).click();

  // Hors-ligne avec la liste mise à jour : le statut local est « annulé » aussi.
  await page.getByRole('button', { name: 'Mettre à jour la liste' }).click();
  await expect(page.getByRole('button', { name: 'Mettre à jour la liste' })).toBeEnabled();
  await context.setOffline(true);
  await page.getByLabel('Saisie manuelle du code').fill(qr);
  await page.getByRole('button', { name: 'Vérifier' }).click();
  await expect(page.getByRole('alertdialog')).toContainText('BILLET ANNULÉ');
  await expect(page.getByRole('alertdialog')).toContainText('Vérifié hors-ligne');
  await context.setOffline(false);
});
