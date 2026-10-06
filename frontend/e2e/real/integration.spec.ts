import { expect, test, type Page } from '@playwright/test';
import { createVerifiedBuyer } from './fixtures';
import { waitForLink } from './mailpit';

/**
 * Intégration contre l'API RÉELLE (back démarré + seed). Mot de passe des comptes du seed :
 * variable d'environnement SEED_PASSWORD (jamais écrite dans le dépôt).
 */
const PASSWORD = process.env.SEED_PASSWORD ?? '';

async function login(page: Page, email: string, next = '/', password = PASSWORD) {
  await page.goto(`/login?next=${encodeURIComponent(next)}`);
  await page.getByLabel('Adresse email').fill(email);
  await page.getByLabel('Mot de passe').fill(password);
  await page.getByRole('button', { name: 'Se connecter' }).click();
}


/** `allowed` : réponses d'erreur attendues par le scénario (ex. « 403 POST /api/v1/auth/login »). */
function collectErrors(page: Page, allowed: string[] = []): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    // Les statuts HTTP sont contrôlés précisément via l'événement `response` ci-dessous.
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('response', (r) => {
    const path = new URL(r.url()).pathname;
    const line = `${r.status()} ${r.request().method()} ${path}`;
    if (r.status() >= 400 && r.status() !== 401 && !allowed.includes(line)) errors.push(line);
  });
  return errors;
}

test('acheteur : inscription, vérification email (Mailpit), réservation par carte puis virement, mes commandes', async ({ page }) => {
  const errors = collectErrors(page, ['403 POST /api/v1/auth/login']); // connexion avant vérification : refus attendu (v1.5)
  const email = `e2e-${Date.now()}@example.test`;
  const password = 'une phrase de passe e2e solide';
  await page.goto('/register');
  await page.getByLabel('Adresse email').fill(email);
  await page.getByLabel('Nom affiché').fill('Testeur E2E');
  await page.getByLabel('Mot de passe', { exact: true }).fill(password);
  await page.getByLabel('Confirmer le mot de passe').fill(password);
  await page.getByRole('button', { name: 'Créer mon compte' }).click();
  await expect(page.getByText(/Si cette adresse peut être utilisée/)).toBeVisible();
  // Connexion avant vérification ⇒ 403 EMAIL_NOT_VERIFIED (contrat v1.5)
  await page.goto('/login');
  await page.getByLabel('Adresse email').fill(email);
  await page.getByLabel('Mot de passe').fill(password);
  await page.getByRole('button', { name: 'Se connecter' }).click();
  await expect(page.getByRole('heading', { name: 'Vérifiez votre email' })).toBeVisible();
  await page.goto(await waitForLink(email, '/verify-email'));
  await expect(page).not.toHaveURL(/token=/);
  await page.getByRole('button', { name: 'Confirmer mon adresse' }).click();
  await expect(page.getByText(/Votre adresse email est confirmée/)).toBeVisible();
  await page.getByLabel('Adresse email').fill(email);
  await page.getByLabel('Mot de passe').fill(password);
  await page.getByRole('button', { name: 'Se connecter' }).click();
  await expect(page.getByRole('heading', { name: 'Événements à venir' })).toBeVisible();
  await page.getByRole('main').getByRole('link', { name: 'Jazz au Hangar' }).click();
  await expect(page.getByText(/heure de Paris/).first()).toBeVisible();
  // Carte
  await page.getByRole('button', { name: 'Ajouter une place Parterre' }).click();
  await page.getByRole('button', { name: /Réserver 1 place/ }).click();
  await expect(page.getByRole('heading', { name: 'Commande' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Payer .* par carte/ })).toBeVisible();
  await expect(page.getByText(/Places réservées encore/).first()).toBeVisible();
  // Virement
  await page.goBack();
  await page.getByRole('button', { name: 'Ajouter une place Parterre' }).click();
  await page.getByRole('radio', { name: /Virement bancaire/ }).check();
  await page.getByRole('button', { name: /Réserver 1 place/ }).click();
  await expect(page.getByRole('heading', { name: 'Instructions de virement' })).toBeVisible();
  await expect(page.getByText(/FR76 3000 6000 0112 3456 7890 189/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Copier la référence' })).toBeVisible();
  await page.getByRole('button', { name: 'Ouvrir le menu' }).click();
  await page.getByRole('link', { name: 'Commandes' }).first().click();
  await expect(page.getByRole('heading', { name: 'Mes commandes' })).toBeVisible();
  await expect(page.getByText('Jazz au Hangar').first()).toBeVisible();
  expect(errors).toEqual([]);
});

test.describe('comptes du seed', () => {
  test.skip(!PASSWORD, 'SEED_PASSWORD requis');

test('paiement carte réel : PSP simulé ⇒ retour ⇒ attente du webhook ⇒ billets', async ({ page, request }) => {
  const errors = collectErrors(page);
  const buyer = await createVerifiedBuyer(request);
  await login(page, buyer.email, '/', buyer.password);
  await page.getByRole('main').getByRole('link', { name: 'Jazz au Hangar' }).click();
  await page.getByRole('button', { name: 'Ajouter une place Parterre' }).click();
  await page.getByRole('button', { name: /Réserver 1 place/ }).click();
  await page.getByRole('button', { name: /Payer .* par carte/ }).click();
  await expect(page).toHaveURL(/^http:\/\/localhost:4001\//);
  await page.getByRole('button', { name: /^Payer$/ }).click();
  await expect(page).toHaveURL(/\/orders\/[0-9a-f-]{36}\?payment=success/);
  await expect(page.getByText(/Paiement confirmé/)).toBeVisible({ timeout: 30_000 });
  expect(errors).toEqual([]);
});

test('virement réel : réservation acheteur puis validation par le gestionnaire', async ({ browser, request }) => {
  const account = await createVerifiedBuyer(request);
  const buyer = await browser.newPage();
  await login(buyer, account.email, '/', account.password);
  await buyer.getByRole('main').getByRole('link', { name: 'Jazz au Hangar' }).click();
  await buyer.getByRole('button', { name: 'Ajouter une place Parterre' }).click();
  await buyer.getByRole('radio', { name: /Virement bancaire/ }).check();
  await buyer.getByRole('button', { name: /Réserver 1 place/ }).click();
  const reference = (await buyer.locator('.reference').textContent())?.trim() ?? '';
  expect(reference).not.toBe('');
  const amountText = (await buyer.getByText(/^\d+,\d{2}\s€$/).last().textContent()) ?? '';
  const amount = amountText.replace(/[^\d,]/g, '');
  const orderUrl = buyer.url();

  const manager = await browser.newPage();
  await login(manager, 'manager@nuits.test', '/org');
  await manager.getByRole('main').getByRole('link', { name: 'Jazz au Hangar' }).click();
  await manager.getByRole('link', { name: 'Commandes et virements' }).click();
  const card = manager.locator('li', { hasText: reference });
  await card.getByLabel('Montant reçu sur le compte (€)').fill(amount);
  await card.getByRole('button', { name: 'Valider le virement' }).click();
  await manager.getByRole('dialog').getByRole('button', { name: 'Valider le virement' }).click();
  // Une fois payée, la commande n'affiche plus d'instructions de virement (donc plus la référence).
  await expect(manager.locator('li', { hasText: reference })).toHaveCount(0);
  await expect(manager.getByRole('alert')).toHaveCount(0);

  await buyer.goto(orderUrl);
  await expect(buyer.getByText(/Paiement confirmé/)).toBeVisible();
});

test('propriétaire : back-office (événements, réglages, membres, journal)', async ({ page }) => {
  const errors = collectErrors(page);
  await login(page, 'owner@nuits.test', '/org');
  const main = page.getByRole('main');
  await expect(main.getByRole('heading', { name: 'Événements' })).toBeVisible();
  await main.getByRole('link', { name: 'Jazz au Hangar' }).click();
  await expect(main.getByRole('heading', { name: 'Types de places' })).toBeVisible();
  await main.getByRole('button', { name: 'Modifier l’événement' }).click();
  await expect(main.getByRole('group').first()).toBeVisible();
  await page.getByRole('link', { name: 'Réglages' }).click();
  await expect(main.getByRole('button', { name: 'Enregistrer les réglages' })).toBeVisible();
  await expect(main.getByText(/FR76/)).toBeVisible();
  await page.getByRole('link', { name: 'Membres' }).click();
  await expect(main.getByText('manager@nuits.test')).toBeVisible();
  await page.getByRole('link', { name: 'Journal' }).click();
  await expect(main.getByRole('heading', { name: 'Journal d’audit' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('gestionnaire : réglages en lecture seule', async ({ page }) => {
  await login(page, 'manager@nuits.test', '/org');
  await page.getByRole('link', { name: 'Réglages' }).click();
  await expect(page.getByText(/Lecture seule/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Enregistrer les réglages' })).toHaveCount(0);
});

test('admin plateforme : liste des collectifs', async ({ page }) => {
  await login(page, 'admin@nuits-garonne.test', '/admin');
  await expect(page.getByText('Les Chais Sonores')).toBeVisible();
});
});
