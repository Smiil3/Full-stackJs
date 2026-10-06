import { expect, test } from '@playwright/test';
import { buyByTransfer, createEvent, createVerifiedBuyer, IN_CHECKIN_WINDOW } from '../real/fixtures';

/**
 * Scanner PWA : après une première visite en ligne, l'application se RECHARGE sans réseau (service
 * worker), contrôle les billets sur la liste locale, puis resynchronise au retour du réseau.
 */
const PASSWORD = process.env.SEED_PASSWORD ?? '';
test.skip(!PASSWORD, 'SEED_PASSWORD requis');

test('rechargement hors-ligne de l’application, contrôle local puis resynchronisation', async ({ page, context, request }) => {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' && /Content Security Policy|Refused to/i.test(m.text())) errors.push(m.text());
  });

  // Billet acheté et payé (virement validé) pour un acheteur neuf.
  const account = await createVerifiedBuyer(request);
  const event = await createEvent(request, PASSWORD, 10, { startsInMs: IN_CHECKIN_WINDOW, offlineCheckinEnabled: true });
  const qr = (await buyByTransfer(request, PASSWORD, account, event.orgId, event.eventId, event.ticketTypeId)).qrs[0] ?? '';

  // 1re visite en ligne : connexion, préparation de la liste, service worker installé.
  await page.goto('/login?next=%2Fscan');
  await page.getByLabel('Adresse email').fill('scanner@nuits.test');
  await page.getByLabel('Mot de passe').fill(PASSWORD);
  await page.getByRole('button', { name: 'Se connecter' }).click();
  const card = page.locator('li', { has: page.getByRole('heading', { name: event.title }) });
  await card.getByRole('button', { name: /Préparer l’entrée hors-ligne|Mettre à jour la liste hors-ligne/ }).click();
  await card.getByRole('link', { name: 'Contrôler les entrées' }).click();
  await expect(page).toHaveURL(/\/scan\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/);
  await expect(page.getByLabel('Saisie manuelle du code')).toBeVisible();
  const scanUrl = page.url();
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload(); // la page est désormais contrôlée par le service worker
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);

  // Plus aucun réseau : l'application se recharge depuis le cache et reste utilisable.
  await context.setOffline(true);
  await page.goto(scanUrl);
  await expect(page.getByText(/Pas de réseau\. Vos billets restent disponibles/)).toBeVisible();
  await page.getByLabel('Saisie manuelle du code').fill(qr);
  await page.getByRole('button', { name: 'Vérifier' }).click();
  await expect(page.locator('.scan-result:not(.scan-result--pending)')).toContainText('OK — entrée');
  await expect(page.locator('.scan-result:not(.scan-result--pending)')).toContainText('Vérifié hors-ligne');
  await expect(page.getByText(/1 scan en attente de synchro/)).toBeVisible();

  // Retour du réseau : session restaurée, synchro automatique.
  await context.setOffline(false);
  await expect(page.getByText(/0 scan en attente de synchro/)).toBeVisible({ timeout: 45_000 });
  expect(errors).toEqual([]);
});
