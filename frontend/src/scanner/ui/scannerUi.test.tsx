import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { apiRequest, login, logout } from '../../api/client';
import type { Order } from '../../api/types';
import { injectFault, mock } from '../../mocks/core';
import { markPaid } from '../../mocks/domain';
import { DEMO_PASSWORD, IDS } from '../../mocks/state';
import { renderApp } from '../../test/renderApp';
import { pendingCount } from '../db';

const SCAN = `/scan/${IDS.orgNuits}/${IDS.eventConcert}`;

async function buy(qty = 1): Promise<string[]> {
  await login('acheteur@example.test', DEMO_PASSWORD);
  const order = await apiRequest<Order>('/orders', { method: 'POST', body: { eventId: IDS.eventConcert, paymentMethod: 'CARD', items: [{ ticketTypeId: IDS.ttFosse, quantity: qty }] }, headers: { 'Idempotency-Key': crypto.randomUUID() } });
  const stored = mock.db.orders.find((o) => o.id === order.id);
  if (stored) await markPaid(stored);
  await logout();
  return mock.db.tickets.filter((t) => t.orderId === order.id).map((t) => t.qrPayload);
}

function setOnline(value: boolean) {
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => value });
  window.dispatchEvent(new Event(value ? 'online' : 'offline'));
}

async function prepareAndOpen(user: ReturnType<typeof userEvent.setup>) {
  const app = await renderApp('/scan', { as: 'scanner@nuits.test' });
  const card = (await screen.findByRole('heading', { name: /Garonne Électrique/ })).closest('li') as HTMLElement;
  await user.click(within(card).getByRole('button', { name: 'Préparer l’entrée hors-ligne' }));
  await user.click(await within(card).findByRole('link', { name: 'Contrôler les entrées' }));
  await screen.findByLabelText('Saisie manuelle du code');
  return app;
}

async function scanManually(user: ReturnType<typeof userEvent.setup>, code: string) {
  await user.type(screen.getByLabelText('Saisie manuelle du code'), code);
  await user.click(screen.getByRole('button', { name: 'Vérifier' }));
  return screen.findByRole('alertdialog');
}

describe('scanner : interface', () => {
  it('préparation hors-ligne puis scan en ligne : vert « OK — Fosse — J.D. », puis rouge « DÉJÀ UTILISÉ à HH:MM »', async () => {
    const user = userEvent.setup();
    const [qr] = await buy(1);
    await prepareAndOpen(user);
    expect(screen.getByText(/Caméra indisponible|Impossible de démarrer la caméra/)).toBeInTheDocument(); // jsdom : saisie manuelle
    let result = await scanManually(user, qr ?? '');
    expect(result).toHaveClass('scan-result--ok');
    expect(result).toHaveTextContent('OK');
    expect(result).toHaveTextContent('Fosse — J.D.');
    await user.click(within(result).getByRole('button', { name: 'Scanner le suivant' }));
    result = await scanManually(user, qr ?? '');
    expect(result).toHaveClass('scan-result--ko');
    expect(result).toHaveTextContent(/DÉJÀ UTILISÉ à \d{2}:\d{2}/);
  });

  it('QR falsifié ⇒ rouge « INVALIDE » ; résultat fermé automatiquement', async () => {
    // Pas de faux minuteurs ici : IndexedDB (simulé) en dépend.
    const user = userEvent.setup();
    await buy(1);
    await prepareAndOpen(user);
    const result = await scanManually(user, 'NG1.faux');
    expect(result).toHaveTextContent('INVALIDE');
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull(), { timeout: 4000 });
  });

  it('HORS-LIGNE : vérification locale, compteur de synchro, synchro automatique au retour du réseau', async () => {
    const user = userEvent.setup();
    const [qr1, qr2] = await buy(2);
    await prepareAndOpen(user);
    setOnline(false);
    expect(await screen.findByText('Hors-ligne', { selector: '.badge' })).toBeInTheDocument();
    let result = await scanManually(user, qr1 ?? '');
    expect(result).toHaveTextContent('OK');
    expect(result).toHaveTextContent('Vérifié hors-ligne');
    await user.click(within(result).getByRole('button', { name: 'Scanner le suivant' }));
    result = await scanManually(user, qr1 ?? '');
    expect(result).toHaveTextContent('DÉJÀ UTILISÉ');
    await user.click(within(result).getByRole('button', { name: 'Scanner le suivant' }));
    await scanManually(user, qr2 ?? '');
    expect(await screen.findByText(/scans en attente de synchro/)).toHaveTextContent('2 scans en attente de synchro');
    expect(mock.db.calls.get('POST /orgs/:orgId/events/:eventId/checkin/sync') ?? 0).toBe(0);
    setOnline(true);
    await waitFor(() => expect(mock.db.calls.get('POST /orgs/:orgId/events/:eventId/checkin/sync') ?? 0).toBeGreaterThan(0));
    await waitFor(async () => expect(await pendingCount(IDS.eventConcert)).toBe(0));
    expect(await screen.findByText(/Synchronisé : 2 entrée\(s\) confirmée\(s\)/)).toBeInTheDocument();
  });

  it('conflit de synchro affiché (billet entré à une autre porte pendant la coupure)', async () => {
    const user = userEvent.setup();
    const [qr] = await buy(1);
    await prepareAndOpen(user);
    setOnline(false);
    await scanManually(user, qr ?? '');
    const t = mock.db.tickets.find((x) => x.qrPayload === qr);
    if (t) Object.assign(t, { status: 'USED', usedAt: '2026-11-14T20:04:00.000Z' });
    setOnline(true);
    const heading = await screen.findByRole('heading', { name: 'Conflits (1)' });
    const section = heading.closest('section') as HTMLElement;
    expect(within(section).getByText('déjà utilisé')).toBeInTheDocument();
    expect(within(section).getByText(/déjà entré à 21:04/)).toBeInTheDocument();
  });

  it('délai de 3 s ou panne ⇒ décision locale sans attendre le serveur', async () => {
    const user = userEvent.setup();
    const [qr] = await buy(1);
    await prepareAndOpen(user);
    injectFault({ route: 'POST /orgs/:orgId/events/:eventId/checkin/scan', status: 503, code: 'INTERNAL_ERROR' });
    const result = await scanManually(user, qr ?? '');
    expect(result).toHaveTextContent('OK');
    expect(result).toHaveTextContent('Vérifié hors-ligne');
  });

  it('billet authentique absent de la liste (hors-ligne) ⇒ orange avec choix « Laisser entrer » / « Refuser »', async () => {
    const user = userEvent.setup();
    await buy(1);
    await prepareAndOpen(user);
    // Billet vendu APRÈS la préparation (authentique, signé par le serveur, absent de la liste locale).
    const { signQr, randomPublicId } = await import('../../mocks/crypto');
    const late = await signQr(IDS.eventConcert, randomPublicId());
    setOnline(false);
    const result = await scanManually(user, late);
    expect(result).toHaveClass('scan-result--warn');
    expect(result).toHaveTextContent('Billet authentique non présent dans la liste — vérifier en ligne si possible');
    await user.click(within(result).getByRole('button', { name: 'Laisser entrer' }));
    expect(await screen.findByRole('alertdialog')).toHaveTextContent('OK');
    expect(await pendingCount(IDS.eventConcert)).toBe(1);
  });

  it('autre événement ⇒ orange « AUTRE ÉVÉNEMENT »', async () => {
    const user = userEvent.setup();
    await buy(1);
    await prepareAndOpen(user);
    const { signQr } = await import('../../mocks/crypto');
    const { bytesToBase64url } = await import('../../lib/base64url');
    const other = await signQr(IDS.eventSoldOut, bytesToBase64url(new Uint8Array(16).fill(3)));
    const result = await scanManually(user, other);
    expect(result).toHaveClass('scan-result--warn');
    expect(result).toHaveTextContent('AUTRE ÉVÉNEMENT');
  });

  it('un acheteur sans rôle ne peut pas ouvrir le contrôle d’un collectif', async () => {
    await renderApp(SCAN, { as: 'acheteur@example.test' });
    expect(await screen.findByRole('heading', { name: 'Accès non autorisé' })).toBeInTheDocument();
  });
});
