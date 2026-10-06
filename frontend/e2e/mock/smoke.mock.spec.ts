import { expect, test } from '@playwright/test';

/**
 * Smoke test du parcours acheteur sur l'API SIMULÉE (npm run dev:mock), viewport mobile.
 * Vérifie aussi qu'aucune violation CSP n'est levée dans un vrai navigateur.
 */
test('parcours acheteur complet (carte) en mode mock', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto('/');
  await page.getByRole('link', { name: /Garonne Électrique/ }).click();
  await page.getByRole('link', { name: 'Se connecter pour réserver' }).click();
  await page.getByLabel('Adresse email').fill('acheteur@example.test');
  await page.getByLabel('Mot de passe').fill('demo-nuits-2026');
  await page.getByRole('button', { name: 'Se connecter' }).click();

  await page.getByRole('button', { name: 'Ajouter une place Fosse' }).click();
  await page.getByRole('button', { name: 'Ajouter une place Fosse' }).click();
  await expect(page.getByRole('region', { name: 'Récapitulatif' })).toContainText('37,40');
  await page.getByRole('button', { name: /^Réserver 2 places/ }).click();
  await page.getByRole('button', { name: /Payer .* par carte/ }).click();
  await page.getByRole('button', { name: 'Payer', exact: true }).click();
  await expect(page.getByText('Paiement en cours de confirmation')).toBeVisible();
  await expect(page.getByText(/Paiement confirmé/)).toBeVisible({ timeout: 15_000 });

  await page.getByRole('link', { name: 'Mes billets' }).first().click();
  await expect(page.getByText('2 billets · Fosse')).toBeVisible();
  await page.getByRole('button', { name: 'Afficher le QR code' }).click();
  await expect(page.getByRole('img', { name: /QR code du billet Fosse/ })).toBeVisible();
  await expect(page.getByText('Augmentez la luminosité de votre écran')).toBeVisible();
  await page.getByRole('button', { name: 'Fermer' }).click();

  expect(errors.filter((e) => /Content Security Policy|Refused to/i.test(e))).toEqual([]);
  // Seul bruit attendu : le 401 du refresh de démarrage (visiteur pas encore connecté).
  expect(errors.filter((e) => !/status of 401/.test(e))).toEqual([]);
});
