import { expect, test, type Page } from '@playwright/test';
import { buyByTransfer, createEvent, createVerifiedBuyer, IN_CHECKIN_WINDOW } from './fixtures';

/**
 * Contrôle d'accès contre l'API RÉELLE : billets obtenus par virement validé (données créées par le
 * test, pas dépendantes de l'état), scan en ligne OK puis DÉJÀ UTILISÉ, puis hors-ligne et resynchro.
 */
const PASSWORD = process.env.SEED_PASSWORD ?? '';
async function scan(page: Page, code: string) {
  // Le résultat précédent (OK : fermeture auto) rend le formulaire inerte tant qu'il est affiché.
  await expect(page.locator('.scan-result:not(.scan-result--pending)')).toHaveCount(0, { timeout: 10_000 });
  await page.getByLabel('Saisie manuelle du code').fill(code);
  await page.getByRole('button', { name: 'Vérifier' }).click();
  const result = page.locator('.scan-result:not(.scan-result--pending)');
  await expect(result).toBeVisible({ timeout: 15_000 }); // réessais en ligne puis éventuelle bascule locale
  return result;
}

test('scanner : OK puis DÉJÀ UTILISÉ en ligne ; hors-ligne puis resynchronisation', async ({ page, context, request }) => {
  // Événement propre au test, dans la fenêtre de contrôle, mode secours activé par le propriétaire.
  const ev = await createEvent(request, PASSWORD, 10, { startsInMs: IN_CHECKIN_WINDOW, offlineCheckinEnabled: true });
  const { orgId, eventId } = ev;
  const { qrs } = await buyByTransfer(request, PASSWORD, await createVerifiedBuyer(request), orgId, eventId, ev.ticketTypeId, 2);
  expect(qrs).toHaveLength(2);

  await page.goto('/login?next=%2Fscan');
  await page.getByLabel('Adresse email').fill('scanner@nuits.test');
  await page.getByLabel('Mot de passe').fill(PASSWORD);
  await page.getByRole('button', { name: 'Se connecter' }).click();
  const card = page.locator('li', { has: page.getByRole('heading', { name: ev.title }) });
  await card.getByRole('button', { name: /Préparer l’entrée hors-ligne|Mettre à jour la liste hors-ligne/ }).click();
  await expect(card.getByText(/liste de \d+ billets téléchargée/)).toBeVisible();
  await card.getByRole('link', { name: 'Contrôler les entrées' }).click();
  await expect(page.getByText(/risque de double entrée/)).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/scan/${orgId}/${eventId}$`));

  // En ligne
  let result = await scan(page, qrs[0] ?? '');
  await expect(result).toContainText('OK — entrée');
  await result.getByRole('button', { name: 'Scanner le suivant' }).click();
  result = await scan(page, qrs[0] ?? '');
  await expect(result).toContainText(/Déjà utilisé.*à \d{2}:\d{2}/);
  await result.getByRole('button', { name: 'Scanner le suivant' }).click(); // un refus reste affiché jusqu'à un appui

  // Hors-ligne
  await context.setOffline(true);
  await expect(page.locator('.badge', { hasText: 'Hors-ligne' })).toBeVisible();
  result = await scan(page, qrs[1] ?? '');
  await expect(result).toContainText('OK — entrée');
  await expect(result).toContainText('Vérifié hors-ligne');
  await expect(page.getByText(/Vérification locale/)).toBeVisible();
  await expect(page.getByText(/1 scan en attente de synchro/)).toBeVisible();

  // Retour du réseau : synchro automatique
  await context.setOffline(false);
  await expect(page.getByText(/0 scan en attente de synchro/)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/Synchronisé : 1 entrée\(s\) confirmée\(s\)/)).toBeVisible();

  // Le serveur sait désormais que le 2ᵉ billet est utilisé
  result = await scan(page, qrs[1] ?? '');
  await expect(result).toContainText('Déjà utilisé');
});
