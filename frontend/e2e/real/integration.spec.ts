import { expect, test, type Page } from '@playwright/test';
import { waitForLink } from './mailpit';

/**
 * Intégration contre l'API RÉELLE (back démarré + seed). Mot de passe des comptes du seed :
 * variable d'environnement SEED_PASSWORD (jamais écrite dans le dépôt).
 */
const PASSWORD = process.env.SEED_PASSWORD ?? '';

async function login(page: Page, email: string, next = '/') {
  await page.goto(`/login?next=${encodeURIComponent(next)}`);
  await page.getByLabel('Adresse email').fill(email);
  await page.getByLabel('Mot de passe').fill(PASSWORD);
  await page.getByRole('button', { name: 'Se connecter' }).click();
}

/** Endpoints du contrat pas encore livrés par le back (jalons B5–B7) : à vider en F5. */
const NOT_YET_DELIVERED = ['/api/v1/me/waitlist', '/api/v1/me/tickets'];

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
    if (r.status() >= 400 && r.status() !== 401 && !(r.status() === 404 && NOT_YET_DELIVERED.includes(path)) && !allowed.includes(line)) errors.push(line);
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
  await page.getByLabel('Nombre de places « Parterre »').selectOption('1');
  await page.getByRole('button', { name: /Réserver 1 place/ }).click();
  await expect(page.getByRole('heading', { name: 'Commande' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Payer .* par carte/ })).toBeVisible();
  await expect(page.getByText(/Places réservées encore/).first()).toBeVisible();
  // Virement
  await page.goBack();
  await page.getByLabel('Nombre de places « Parterre »').selectOption('1');
  await page.getByRole('radio', { name: /Virement bancaire/ }).check();
  await page.getByRole('button', { name: /Réserver 1 place/ }).click();
  await expect(page.getByRole('heading', { name: 'Instructions de virement' })).toBeVisible();
  await expect(page.getByText(/FR76 3000 6000 0112 3456 7890 189/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Copier la référence' })).toBeVisible();
  await page.getByRole('link', { name: 'Commandes' }).first().click();
  await expect(page.getByRole('heading', { name: 'Mes commandes' })).toBeVisible();
  await expect(page.getByText('Jazz au Hangar').first()).toBeVisible();
  expect(errors).toEqual([]);
});

test.describe('comptes du seed', () => {
  test.skip(!PASSWORD, 'SEED_PASSWORD requis');

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
