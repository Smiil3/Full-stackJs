import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { apiRequest, login, logout } from '../../api/client';
import type { Order } from '../../api/types';
import { injectFault, mock } from '../../mocks/core';
import { markPaid } from '../../mocks/domain';
import { DEMO_PASSWORD, IDS } from '../../mocks/state';
import { renderApp } from '../../test/renderApp';
import { __wipeScannerForTests, pendingCount } from '../db';

/** Concert : mode secours AUTORISÉ (seed mock). Nuit Électro : contrôle en ligne uniquement. */
const RESCUE = `/scan/${IDS.orgNuits}/${IDS.eventConcert}`;
const ONLINE_ONLY = `/scan/${IDS.orgNuits}/${IDS.eventSoldOut}`;
const SCAN_ROUTE = 'POST /orgs/:orgId/events/:eventId/checkin/scan';

// Pages chargées à la demande : transformées une fois avant les tests.
beforeAll(async () => {
  await Promise.all([import('./ScannerHomePage'), import('./ScannerPage')]);
}, 30_000);
vi.setConfig({ testTimeout: 20_000 });
afterEach(async () => {
  await __wipeScannerForTests();
});

async function buy(eventId: string, ticketTypeId: string, qty = 1): Promise<string[]> {
  await login('acheteur@example.test', DEMO_PASSWORD);
  const tt = mock.db.ticketTypes.find((t) => t.id === ticketTypeId);
  if (tt) tt.held = 0; // places disponibles pour le test
  const order = await apiRequest<Order>('/orders', { method: 'POST', body: { eventId, paymentMethod: 'CARD', items: [{ ticketTypeId, quantity: qty }] }, headers: { 'Idempotency-Key': crypto.randomUUID() } });
  const stored = mock.db.orders.find((o) => o.id === order.id);
  if (stored) await markPaid(stored);
  await logout();
  return mock.db.tickets.filter((t) => t.orderId === order.id).map((t) => t.qrPayload);
}
const buyConcert = (qty = 1) => buy(IDS.eventConcert, IDS.ttFosse, qty);

function setOnline(value: boolean) {
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => value });
  window.dispatchEvent(new Event(value ? 'online' : 'offline'));
}

async function scanManually(user: ReturnType<typeof userEvent.setup>, code: string) {
  await user.type(screen.getByLabelText('Saisie manuelle du code'), code);
  await user.click(screen.getByRole('button', { name: 'Vérifier' }));
}

async function openRescue(user: ReturnType<typeof userEvent.setup>) {
  await renderApp(RESCUE, { as: 'scanner@nuits.test' });
  await user.click(await screen.findByRole('button', { name: 'Préparer l’entrée hors-ligne' }));
  expect(await screen.findByText(/Mode secours hors-ligne/)).toBeInTheDocument();
}

describe('scanner — mode par défaut EN LIGNE', () => {
  it('accueil : aucun téléchargement de liste pour un événement sans mode secours', async () => {
    await renderApp('/scan', { as: 'scanner@nuits.test' });
    const card = (await screen.findByRole('heading', { name: /Nuit Électro/ })).closest('li') as HTMLElement;
    expect(within(card).getByText(/Contrôle en ligne/)).toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: /Préparer/ })).toBeNull();
    expect(within(card).getByRole('link', { name: 'Contrôler les entrées' })).toBeInTheDocument();
  });

  it('OK (fermé automatiquement) puis DÉJÀ UTILISÉ qui RESTE affiché jusqu’à un appui (H4)', async () => {
    const user = userEvent.setup();
    const [qr] = await buy(IDS.eventSoldOut, IDS.ttSoldOut);
    await renderApp(ONLINE_ONLY, { as: 'scanner@nuits.test' });
    await screen.findByLabelText('Saisie manuelle du code');
    await scanManually(user, qr ?? '');
    const ok = await screen.findByRole('alertdialog');
    expect(ok).toHaveClass('scan-result--ok');
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull(), { timeout: 4000 });
    await scanManually(user, qr ?? '');
    const ko = await screen.findByRole('alertdialog');
    expect(ko).toHaveTextContent(/DÉJÀ UTILISÉ à \d{2}:\d{2}/);
    await new Promise((r) => setTimeout(r, 3000));
    expect(screen.getByRole('alertdialog')).toHaveTextContent('DÉJÀ UTILISÉ'); // toujours là
    await user.click(within(ko).getByRole('button', { name: 'Scanner le suivant' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(await pendingCount()).toBe(0); // rien en file en mode en ligne
  });

  it('INVALIDE reste affiché (H4)', async () => {
    const user = userEvent.setup();
    await renderApp(ONLINE_ONLY, { as: 'scanner@nuits.test' });
    await screen.findByLabelText('Saisie manuelle du code');
    await scanManually(user, 'NG1.faux');
    expect(await screen.findByRole('alertdialog')).toHaveTextContent('INVALIDE');
    await new Promise((r) => setTimeout(r, 3000));
    expect(screen.getByRole('alertdialog')).toHaveTextContent('INVALIDE');
  });

  it('réseau coupé ⇒ « Vérification impossible — réessayez », personne n’entre ; « Réessayer » ⇒ OK', async () => {
    const user = userEvent.setup();
    const [qr] = await buy(IDS.eventSoldOut, IDS.ttSoldOut);
    await renderApp(ONLINE_ONLY, { as: 'scanner@nuits.test' });
    await screen.findByLabelText('Saisie manuelle du code');
    injectFault({ route: SCAN_ROUTE, status: 0, code: 'INTERNAL_ERROR', network: true, times: 99 });
    await scanManually(user, qr ?? '');
    expect(await screen.findByText('Vérification en cours…')).toBeInTheDocument();
    const fail = await screen.findByRole('alertdialog', {}, { timeout: 15_000 });
    expect(fail).toHaveTextContent('Vérification impossible — réessayez');
    expect(fail).toHaveTextContent('ne laissez pas entrer');
    expect(mock.db.tickets.find((t) => t.qrPayload === qr)?.status).toBe('VALID');
    const { clearFaults } = await import('../../mocks/core');
    clearFaults();
    await user.click(within(fail).getByRole('button', { name: 'Réessayer' }));
    expect(await screen.findByRole('alertdialog')).toHaveTextContent('OK');
  });

  it('hors-ligne sans mode secours ⇒ message « pas de réseau, ne laissez entrer personne »', async () => {
    await renderApp(ONLINE_ONLY, { as: 'scanner@nuits.test' });
    await screen.findByLabelText('Saisie manuelle du code');
    setOnline(false);
    expect(await screen.findByText(/Pas de réseau : les billets ne peuvent pas être vérifiés/)).toBeInTheDocument();
  });
});

describe('scanner — mode SECOURS hors-ligne', () => {
  it('bandeau de risque permanent ; hors-ligne : OK local puis DÉJÀ UTILISÉ ; synchro au retour du réseau', async () => {
    const user = userEvent.setup();
    const [qr1, qr2] = await buyConcert(2);
    await openRescue(user);
    expect(screen.getByText(/risque de double entrée si plusieurs appareils/)).toBeInTheDocument();
    setOnline(false);
    await scanManually(user, qr1 ?? '');
    let r = await screen.findByRole('alertdialog');
    expect(r).toHaveTextContent('Vérifié hors-ligne');
    expect((await screen.findByText(/Vérification locale/)).closest('p')).toHaveTextContent('pas de réseau');
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull(), { timeout: 4000 });
    await scanManually(user, qr1 ?? '');
    r = await screen.findByRole('alertdialog');
    expect(r).toHaveTextContent('DÉJÀ UTILISÉ');
    await user.click(within(r).getByRole('button', { name: 'Scanner le suivant' }));
    await scanManually(user, qr2 ?? '');
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull(), { timeout: 4000 });
    expect(await screen.findByText(/scans en attente de synchro/)).toHaveTextContent('2 scans');
    setOnline(true);
    await waitFor(async () => expect(await pendingCount()).toBe(0), { timeout: 10_000 });
    expect(await screen.findByText(/Synchronisé : 2 entrée\(s\) confirmée\(s\)/)).toBeInTheDocument();
  });

  it('billet absent de la liste ⇒ orange, « Laisser entrer » (une seule fois même en double appui)', async () => {
    const user = userEvent.setup();
    await buyConcert(1);
    await openRescue(user);
    const { signQr, randomPublicId } = await import('../../mocks/crypto');
    const late = await signQr(IDS.eventConcert, randomPublicId());
    setOnline(false);
    await scanManually(user, late);
    const r = await screen.findByRole('alertdialog');
    expect(r).toHaveClass('scan-result--warn');
    expect(r).toHaveTextContent('Billet authentique non présent dans la liste — vérifier en ligne si possible');
    const admit = within(r).getByRole('button', { name: 'Laisser entrer' });
    await user.dblClick(admit);
    expect(await screen.findByRole('alertdialog')).toHaveTextContent('OK');
    expect(await pendingCount()).toBe(1);
  });

  it('conflit affiché, à valider par « J’ai pris connaissance »', async () => {
    const user = userEvent.setup();
    const [qr] = await buyConcert(1);
    await openRescue(user);
    setOnline(false);
    await scanManually(user, qr ?? '');
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull(), { timeout: 4000 });
    const t = mock.db.tickets.find((x) => x.qrPayload === qr);
    if (t) Object.assign(t, { status: 'USED', usedAt: '2026-11-14T20:04:00.000Z' });
    setOnline(true);
    const section = (await screen.findByRole('heading', { name: 'Conflits (1)' }, { timeout: 10_000 })).closest('section') as HTMLElement;
    expect(within(section).getByText(/déjà entré à 21:04/)).toBeInTheDocument();
    await user.click(within(section).getByRole('button', { name: 'J’ai pris connaissance' }));
    await waitFor(() => expect(within(section).queryByRole('button', { name: 'J’ai pris connaissance' })).toBeNull());
  });

  it('H1 : déconnexion avec passages non transmis ⇒ blocage, double confirmation, file CONSERVÉE', async () => {
    const user = userEvent.setup();
    const [qr] = await buyConcert(1);
    await openRescue(user);
    setOnline(false);
    await scanManually(user, qr ?? '');
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull(), { timeout: 4000 });
    await user.click(screen.getByRole('button', { name: 'Se déconnecter' }));
    const d1 = await screen.findByRole('dialog', { name: 'Passages non transmis' });
    expect(d1).toHaveTextContent('1 passage(s) non transmis');
    await user.click(within(d1).getByRole('button', { name: 'Déconnecter quand même' }));
    const d2 = await screen.findByRole('dialog', { name: 'Confirmer la déconnexion ?' });
    await user.click(within(d2).getByRole('button', { name: 'Me déconnecter' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Se déconnecter' })).toBeNull());
    expect(await pendingCount()).toBe(1); // jamais effacée
  });

  it('H3 : démarrage hors-ligne sans accès connu à ce collectif ⇒ refus', async () => {
    injectFault({ route: 'POST /auth/refresh', status: 0, code: 'INTERNAL_ERROR', network: true });
    await renderApp(RESCUE);
    expect(await screen.findByRole('heading', { name: 'Accès non autorisé' })).toBeInTheDocument();
  });

  it('un acheteur sans rôle ne peut pas ouvrir le contrôle d’un collectif', async () => {
    await renderApp(RESCUE, { as: 'acheteur@example.test' });
    expect(await screen.findByRole('heading', { name: 'Accès non autorisé' })).toBeInTheDocument();
  });
});

describe('back-office — réglage du mode secours (v1.13)', () => {
  it('OWNER : activation avec avertissement et confirmation ; MANAGER : lecture seule', async () => {
    const user = userEvent.setup();
    const first = await renderApp(`/org/${IDS.orgNuits}/events/${IDS.eventSoldOut}`, { as: 'owner@nuits.test' });
    const box = await screen.findByRole('checkbox', { name: 'Mode secours hors-ligne du contrôle d’accès' });
    expect(box).not.toBeChecked();
    await user.click(box);
    const dialog = screen.getByRole('dialog', { name: 'Activer le mode secours hors-ligne ?' });
    expect(dialog).toHaveTextContent('un même billet pourra entrer deux fois');
    await user.click(within(dialog).getByRole('button', { name: 'Activer le mode secours' }));
    await waitFor(() => expect(mock.db.events.find((e) => e.id === IDS.eventSoldOut)?.offlineCheckinEnabled).toBe(true));
    expect(mock.db.audit.map((a) => a.action)).toContain('event.offlineCheckin.enable');
    first.unmount();
    await logout();
    await renderApp(`/org/${IDS.orgNuits}/events/${IDS.eventSoldOut}`, { as: 'manager@nuits.test' });
    expect(await screen.findByText(/Mode secours hors-ligne :/)).toHaveTextContent('activé');
    expect(screen.queryByRole('checkbox', { name: /Mode secours/ })).toBeNull();
  });
});
