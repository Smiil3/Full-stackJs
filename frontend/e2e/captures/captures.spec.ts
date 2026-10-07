import { expect, test, type Page } from '@playwright/test';

/** Captures des écrans clés pour la revue visuelle (mode mock). Sélecteurs tolérants aux deux versions des libellés. */
const OUT = process.env.CAPTURE_DIR ?? 'test-results/captures';
const PASSWORD = 'demo-nuits-2026';
const ORG = '11111111-1111-4111-8111-111111111111';
const CONCERT = 'eeeeeeee-0000-4000-8000-000000000001';
const SOLD_OUT = 'eeeeeeee-0000-4000-8000-000000000002';

type Seed = { paidOrderId: string; transferOrderId: string; waitlistId: string };

async function shot(page: Page, name: string) {
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true, animations: 'disabled' });
}

/** Navigation interne (sans recharger : l'API simulée vit dans la page). */
async function go(page: Page, path: string) {
  await page.evaluate((p) => {
    history.pushState({}, '', p);
    dispatchEvent(new PopStateEvent('popstate'));
  }, path);
}

async function login(page: Page, email: string) {
  await page.goto('/login');
  await page.getByLabel(/Adresse e-?mail/).fill(email);
  await page.getByLabel('Mot de passe').fill(PASSWORD);
  await page.getByRole('button', { name: 'Se connecter' }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'));
}

/** Ouvre la fenêtre de contrôle du concert (début dans 1 h). */
async function openCheckin(page: Page) {
  await page.evaluate((id) => {
    const w = window as unknown as { __nuitsMock: { mock: { db: { events: { id: string; startsAt: string; endsAt: string }[] } } } };
    const e = w.__nuitsMock.mock.db.events.find((x) => x.id === id);
    if (e) {
      e.startsAt = new Date(Date.now() + 3_600_000).toISOString();
      e.endsAt = new Date(Date.now() + 6 * 3_600_000).toISOString();
    }
  }, CONCERT);
}

test('public : catalogue, connexion', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('link', { name: /Garonne Électrique/ }).first()).toBeVisible();
  await shot(page, '01-catalogue');
  await go(page, '/login');
  await expect(page.getByLabel('Mot de passe')).toBeVisible();
  await shot(page, '07-connexion');
});

test('acheteur : fiche événement, virement, mes billets, QR, liste d’attente', async ({ page }) => {
  await login(page, 'acheteur@example.test');
  const seed = await page.evaluate(() => (window as unknown as { __nuitsMock: { seedDemoBuyer: () => Promise<Seed> } }).__nuitsMock.seedDemoBuyer());
  await go(page, `/events/${CONCERT}`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await shot(page, '02-evenement');
  await go(page, `/orders/${seed.transferOrderId}`);
  await expect(page.getByText(/IBAN/).first()).toBeVisible();
  await shot(page, '03-virement');
  await go(page, '/me/tickets');
  await expect(page.getByRole('button', { name: /Afficher (en plein écran|le QR code)/ }).first()).toBeVisible();
  await shot(page, '04-mes-billets');
  await page.getByRole('button', { name: /Afficher (en plein écran|le QR code)/ }).first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('img', { name: /QR code du billet/ })).toBeVisible();
  await shot(page, '05-qr-plein-ecran');
  await page.getByRole('button', { name: 'Fermer' }).click();
  await go(page, `/events/${SOLD_OUT}`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await shot(page, '06-liste-attente');
});

test('scanner : résultat de contrôle', async ({ page }) => {
  await login(page, 'scanner@nuits.test');
  await openCheckin(page);
  await go(page, `/scan/${ORG}/${CONCERT}`);
  await page.getByLabel(/Saisi(e|r) (manuelle du|le) code/).fill('NG1.faux');
  await page.getByLabel(/Saisi(e|r) (manuelle du|le) code/).press('Enter');
  await expect(page.locator('.scan-result:not(.scan-result--pending)')).toBeVisible();
  await shot(page, '08-scanner-refus');
});

test('back-office : tableau de bord, confirmation d’annulation', async ({ page }) => {
  await login(page, 'owner@nuits.test');
  await go(page, `/org/${ORG}/events/${CONCERT}/dashboard`);
  await expect(page.getByText(/[Mm]is à jour il y a/)).toBeVisible();
  await shot(page, '09-bo-tableau-de-bord');
  await go(page, `/org/${ORG}/events/${CONCERT}`);
  await page.getByRole('button', { name: /Annuler l.événement/ }).first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await shot(page, '10-bo-confirmation');
});

test('aucun défilement horizontal à 360 et 390 px (pages clés)', async ({ page }) => {
  await login(page, 'acheteur@example.test');
  const seed = await page.evaluate(() => (window as unknown as { __nuitsMock: { seedDemoBuyer: () => Promise<Seed> } }).__nuitsMock.seedDemoBuyer());
  for (const width of [360, 390]) {
    await page.setViewportSize({ width, height: 800 });
    for (const path of ['/', `/events/${CONCERT}`, `/orders/${seed.transferOrderId}`, '/me/tickets', `/waitlist/${seed.waitlistId}`]) {
      await go(page, path);
      await page.waitForLoadState('networkidle');
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, `${path} à ${String(width)} px`).toBeLessThanOrEqual(0);
    }
  }
});
