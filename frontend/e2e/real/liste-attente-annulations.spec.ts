import { expect, test, type Browser, type Page } from '@playwright/test';
import { buyByTransfer, createEvent, createVerifiedBuyer, IN_CHECKIN_WINDOW } from './fixtures';

/**
 * Parcours B7 contre l'API réelle, sur des événements créés par le test (rejouables) :
 * liste d'attente ⇒ libération ⇒ offre ⇒ acceptation ⇒ paiement ⇒ billet ; annulation d'événement.
 */
const PASSWORD = process.env.SEED_PASSWORD ?? '';
test.skip(!PASSWORD, 'SEED_PASSWORD requis');

async function loggedPage(browser: Browser, email: string, password: string, next: string): Promise<Page> {
  const page = await (await browser.newContext({ ...test.info().project.use })).newPage();
  await page.goto(`/login?next=${encodeURIComponent(next)}`);
  await page.getByLabel('Adresse email').fill(email);
  await page.getByLabel('Mot de passe').fill(password);
  await page.getByRole('button', { name: 'Se connecter' }).click();
  return page;
}

test('liste d’attente : complet ⇒ inscription ⇒ annulation d’un autre acheteur ⇒ offre ⇒ acceptation ⇒ paiement ⇒ billet', async ({ browser, request }) => {
  test.setTimeout(120_000);
  const ev = await createEvent(request, PASSWORD, 1);
  const first = await createVerifiedBuyer(request);
  const { orderId } = await buyByTransfer(request, PASSWORD, first, ev.orgId, ev.eventId, ev.ticketTypeId); // complet

  // B s'inscrit sur la liste d'attente depuis la fiche (règles affichées).
  const waiter = await createVerifiedBuyer(request);
  const b = await loggedPage(browser, waiter.email, waiter.password, `/events/${ev.eventId}`);
  await expect(b.getByText(/par ordre d’inscription/)).toBeVisible();
  await b.getByRole('button', { name: 'Rejoindre la liste d’attente' }).click();
  await expect(b.getByText(/Vous êtes inscrit·e \(position 1\)/)).toBeVisible();

  // A annule sa commande (self-service) : la place se libère.
  const a = await loggedPage(browser, first.email, first.password, `/orders/${orderId}`);
  await a.getByRole('button', { name: 'Annuler la commande' }).click();
  await a.getByRole('button', { name: 'Oui, annuler la commande' }).click();
  await expect(a.getByText(/Commande annulée et remboursée/)).toBeVisible();

  // B reçoit l'offre (worker), l'accepte et paie par carte.
  await b.goto('/me/tickets');
  await expect(async () => {
    await b.reload();
    await expect(b.getByRole('button', { name: 'Accepter et payer' })).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 60_000 });
  await expect(b.getByText(/Places disponibles :/)).toBeVisible();
  await b.getByRole('button', { name: 'Accepter et payer' }).click();
  await b.getByRole('button', { name: /Payer .* par carte/ }).click();
  await b.getByRole('button', { name: /^Payer$/ }).click();
  await expect(b.getByText(/Paiement confirmé/)).toBeVisible({ timeout: 30_000 });
  await b.getByRole('link', { name: 'Mes billets' }).first().click();
  await b.getByRole('button', { name: 'Afficher le QR code' }).click();
  await expect(b.getByRole('img', { name: /QR code du billet Unique/ })).toBeVisible();
});

test('annulation d’événement : remboursements suivis, billets annulés chez l’acheteur et refusés à l’entrée', async ({ browser, request }) => {
  test.setTimeout(120_000);
  const ev = await createEvent(request, PASSWORD, 10, { startsInMs: IN_CHECKIN_WINDOW }); // contrôlable maintenant (v1.15)
  const buyers = [await createVerifiedBuyer(request), await createVerifiedBuyer(request)];
  const bought = [];
  for (const buyer of buyers) bought.push(await buyByTransfer(request, PASSWORD, buyer, ev.orgId, ev.eventId, ev.ticketTypeId));

  const owner = await loggedPage(browser, 'owner@nuits.test', PASSWORD, `/org/${ev.orgId}/events/${ev.eventId}`);
  await owner.getByRole('button', { name: 'Annuler l’événement…' }).click();
  const dialog = owner.getByRole('dialog');
  await dialog.getByLabel(/Motif/).fill('Test de bout en bout');
  await dialog.getByLabel(/recopiez le titre/).fill(ev.title);
  await dialog.getByRole('button', { name: 'Annuler l’événement' }).click();
  await expect(owner.getByText('Annulé', { exact: true })).toBeVisible();
  await expect(owner.getByText(/Remboursements en cours|toutes les commandes ont été traitées/)).toBeVisible();
  await expect(owner.getByText('Événement annulé : toutes les commandes ont été traitées.')).toBeVisible({ timeout: 60_000 });

  // Chez l'acheteur : billet annulé.
  const buyer = await loggedPage(browser, buyers[0]?.email ?? '', buyers[0]?.password ?? '', '/me/tickets');
  await expect(buyer.getByText('Annulé', { exact: true })).toBeVisible();

  // À l'entrée (contrôle en ligne) : refusé.
  const scanner = await loggedPage(browser, 'scanner@nuits.test', PASSWORD, `/scan/${ev.orgId}/${ev.eventId}`);
  await scanner.getByLabel('Saisie manuelle du code').fill(bought[0]?.qrs[0] ?? '');
  await scanner.getByRole('button', { name: 'Vérifier' }).click();
  await expect(scanner.getByRole('alertdialog')).toContainText('BILLET ANNULÉ');
});
