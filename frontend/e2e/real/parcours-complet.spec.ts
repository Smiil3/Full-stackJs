import { expect, test } from '@playwright/test';
import { API, apiLogin, createEvent, createVerifiedBuyer, IN_CHECKIN_WINDOW } from './fixtures';
import { waitForMail } from './mailpit';

/**
 * Parcours de bout en bout exigé (F5), mobile, API réelle :
 * achat par carte ⇒ mail des billets ⇒ billet (QR) dans « Mes billets » ⇒ scan OK puis DÉJÀ UTILISÉ.
 */
const PASSWORD = process.env.SEED_PASSWORD ?? '';
test.skip(!PASSWORD, 'SEED_PASSWORD requis');

test('achat carte ⇒ mail ⇒ billet QR ⇒ scan OK puis DÉJÀ UTILISÉ', async ({ browser, request }) => {
  const account = await createVerifiedBuyer(request);
  // Événement propre au test, contrôlable maintenant, mode par défaut (en ligne).
  const ev = await createEvent(request, PASSWORD, 10, { startsInMs: IN_CHECKIN_WINDOW });

  // 1. Achat par carte (prestataire simulé)
  const buyer = await browser.newPage();
  await buyer.goto('/login');
  await buyer.getByLabel('Adresse email').fill(account.email);
  await buyer.getByLabel('Mot de passe').fill(account.password);
  await buyer.getByRole('button', { name: 'Se connecter' }).click();
  await buyer.getByRole('main').getByRole('link', { name: ev.title }).click();
  await buyer.getByRole('button', { name: 'Ajouter une place Unique' }).click();
  await buyer.getByRole('button', { name: /^Réserver 1 place/ }).click();
  await buyer.getByRole('button', { name: /Payer .* par carte/ }).click();
  await buyer.getByRole('button', { name: /^Payer$/ }).click();
  await expect(buyer.getByText(/Paiement confirmé/)).toBeVisible({ timeout: 30_000 });

  // 2. Mail des billets (QR en pièce jointe)
  const mail = await waitForMail(account.email, 'Vos billets');
  expect(mail.attachments).toBeGreaterThan(0);

  // 3. Billet dans « Mes billets » : QR affiché, plein écran
  await buyer.getByRole('link', { name: 'Mes billets' }).first().click();
  await buyer.getByRole('button', { name: 'Afficher le QR code' }).click();
  await expect(buyer.getByRole('img', { name: /QR code du billet Unique/ })).toBeVisible();
  await expect(buyer.getByText('Augmentez la luminosité de votre écran')).toBeVisible();
  await buyer.getByRole('button', { name: 'Fermer' }).click();

  // Contenu du QR (identique à celui dessiné) lu via l'API de l'acheteur
  const token = await apiLogin(request, account.email, account.password);
  const { items } = (await (await request.get(`${API}/me/tickets`, { headers: { Authorization: `Bearer ${token}` } })).json()) as { items: { qrPayload: string; status: string }[] };
  expect(items).toHaveLength(1);
  const qr = items[0]?.qrPayload ?? '';

  // 4. Contrôle à l'entrée
  const scanner = await (await browser.newContext({ ...test.info().project.use })).newPage();
  await scanner.goto('/login?next=%2Fscan');
  await scanner.getByLabel('Adresse email').fill('scanner@nuits.test');
  await scanner.getByLabel('Mot de passe').fill(PASSWORD);
  await scanner.getByRole('button', { name: 'Se connecter' }).click();
  // Mode par défaut : contrôle EN LIGNE, aucune liste téléchargée.
  const card = scanner.locator('li', { has: scanner.getByRole('heading', { name: ev.title }) });
  await card.getByRole('link', { name: 'Contrôler les entrées' }).click();
  for (const expected of [/OK — entrée/, /Déjà utilisé.*à \d{2}:\d{2}/]) {
    await scanner.getByLabel('Saisie manuelle du code').fill(qr);
    await scanner.getByRole('button', { name: 'Vérifier' }).click();
    const result = scanner.locator('.scan-result:not(.scan-result--pending)');
    await expect(result).toContainText(expected);
    await result.getByRole('button', { name: 'Scanner le suivant' }).click();
  }

  // 5. Côté acheteur, le billet apparaît désormais comme utilisé
  await buyer.reload();
  await expect(buyer.getByText(/^Utilisé le/)).toBeVisible();
});
