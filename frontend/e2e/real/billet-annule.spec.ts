import { expect, test } from '@playwright/test';
import { buyByTransfer, createEvent, createVerifiedBuyer, IN_CHECKIN_WINDOW } from './fixtures';

/** Billet d'une commande remboursée (annulation par l'acheteur) ⇒ « BILLET ANNULÉ » à l'entrée. */
const PASSWORD = process.env.SEED_PASSWORD ?? '';
test.skip(!PASSWORD, 'SEED_PASSWORD requis');

test('commande remboursée ⇒ scan « BILLET ANNULÉ » (en ligne et hors-ligne après mise à jour de la liste)', async ({ page, context, request }) => {
  // Achat par virement validé (données propres au test), puis annulation par l'acheteur depuis l'interface.
  const account = await createVerifiedBuyer(request);
  // Événement propre au test, contrôlable maintenant, mode secours activé (pour la partie hors-ligne).
  const event = await createEvent(request, PASSWORD, 10, { startsInMs: IN_CHECKIN_WINDOW, offlineCheckinEnabled: true });
  const { orderId, qrs } = await buyByTransfer(request, PASSWORD, account, event.orgId, event.eventId, event.ticketTypeId);
  const order = { id: orderId };
  const qr = qrs[0] ?? '';

  // Le scanner prépare sa liste AVANT l'annulation (cas réel : liste téléchargée le matin).
  await page.goto('/login?next=%2Fscan');
  await page.getByLabel('Adresse email').fill('scanner@nuits.test');
  await page.getByLabel('Mot de passe').fill(PASSWORD);
  await page.getByRole('button', { name: 'Se connecter' }).click();
  const card = page.locator('li', { has: page.getByRole('heading', { name: event.title }) });
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
  const dialogText = (await buyerPage.getByRole('dialog').textContent()) ?? '';
  const preview = /Montant remboursé : ([\d\s\u202f\u00a0]+,\d{2})/.exec(dialogText)?.[1]?.replace(/\s/g, '');
  expect(preview).toBeTruthy();
  await buyerPage.getByRole('button', { name: 'Oui, annuler la commande' }).click();
  const done = (await buyerPage.getByText(/Commande annulée et remboursée/).textContent()) ?? '';
  // Le montant effectivement remboursé est celui annoncé avant confirmation (refundPreviewCents).
  expect(done.replace(/\s/g, '')).toContain(preview ?? 'x');

  // En ligne : le serveur répond « annulé ».
  await page.getByLabel('Saisie manuelle du code').fill(qr);
  await page.getByRole('button', { name: 'Vérifier' }).click();
  await expect(page.locator('.scan-result:not(.scan-result--pending)')).toContainText('Billet annulé');
  await page.locator('.scan-result:not(.scan-result--pending)').getByRole('button', { name: 'Scanner le suivant' }).click();

  // Hors-ligne avec la liste mise à jour : le statut local est « annulé » aussi.
  await page.getByRole('button', { name: 'Mettre à jour la liste' }).click();
  await expect(page.getByRole('button', { name: 'Mettre à jour la liste' })).toBeEnabled();
  await context.setOffline(true);
  await page.getByLabel('Saisie manuelle du code').fill(qr);
  await page.getByRole('button', { name: 'Vérifier' }).click();
  await expect(page.locator('.scan-result:not(.scan-result--pending)')).toContainText('Billet annulé');
  await expect(page.locator('.scan-result:not(.scan-result--pending)')).toContainText('Vérifié hors-ligne');
  await context.setOffline(false);
});
