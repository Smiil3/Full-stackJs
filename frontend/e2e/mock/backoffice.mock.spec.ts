import { expect, test } from '@playwright/test';

/** Smoke test back-office (OWNER) sur l'API simulée : navigation, réglages, tableau de bord, sans erreur CSP. */
test('back-office OWNER en mode mock', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' && !/status of 401/.test(m.text())) errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto('/login?next=%2Forg');
  await page.getByLabel('Adresse email').fill('owner@nuits.test');
  await page.getByLabel('Mot de passe').fill('demo-nuits-2026');
  await page.getByRole('button', { name: 'Se connecter' }).click();
  const main = page.getByRole('main');
  await main.getByRole('link', { name: 'Les Nuits de la Garonne' }).click();
  await main.getByRole('link', { name: /Garonne Électrique/ }).click();
  await page.getByRole('link', { name: 'Ventes en temps réel' }).click();
  await expect(page.getByText(/Mis à jour il y a/)).toBeVisible();
  await page.getByRole('link', { name: 'Réglages' }).click();
  await expect(page.getByText('FR76 •••• •••• 0189')).toBeVisible();
  await page.getByRole('link', { name: 'Journal' }).click();
  await expect(page.getByText('Système')).toBeVisible();
  expect(errors).toEqual([]);
});
