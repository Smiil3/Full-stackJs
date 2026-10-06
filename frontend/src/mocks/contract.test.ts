/**
 * Vérifie que le faux serveur MSW couvre TOUT le contrat (chaque endpoint répond, avec les règles
 * principales). Si le contrat évolue, ce test doit évoluer avec lui.
 */
import { describe, expect, it } from 'vitest';
import { apiPath, apiRequest, login, logout } from '../api/client';
import type { CheckinSnapshot, EventAdmin, EventPublic, EventStats, Order, OrderAdmin, Page, ScanResponse, SyncResponse, Ticket, WaitlistEntry } from '../api/types';
import { mock } from './core';
import { DEMO_PASSWORD, IDS } from './state';

const post = <T>(path: string, body?: unknown, headers?: Record<string, string>) => apiRequest<T>(path, { method: 'POST', body, headers });

async function buyTicket(): Promise<{ order: Order; ticket: Ticket }> {
  await login('acheteur@example.test', DEMO_PASSWORD);
  const order = await post<Order>('/orders', { eventId: IDS.eventConcert, paymentMethod: 'TRANSFER', items: [{ ticketTypeId: IDS.ttFosse, quantity: 1 }] }, { 'Idempotency-Key': crypto.randomUUID() });
  await logout();
  await login('manager@nuits.test', DEMO_PASSWORD);
  await post<OrderAdmin>(apiPath`/orgs/${IDS.orgNuits}/orders/${order.id}/confirm-transfer`, { receivedAmountCents: order.totalCents });
  await logout();
  await login('acheteur@example.test', DEMO_PASSWORD);
  const { items } = await apiRequest<{ items: Ticket[] }>('/me/tickets');
  return { order, ticket: items[0] as Ticket };
}

describe('MSW — couverture du contrat', () => {
  it('auth : register (202 neutre), login, me, change-password, logout', async () => {
    const r1 = await apiRequest<{ message: string }>('/auth/register', { method: 'POST', auth: false, body: { email: 'nouveau@example.test', password: 'mot-de-passe-solide', displayName: 'Nouveau' } });
    const r2 = await apiRequest<{ message: string }>('/auth/register', { method: 'POST', auth: false, body: { email: 'acheteur@example.test', password: 'mot-de-passe-solide', displayName: 'X' } });
    expect(r1).toEqual(r2); // aucune énumération des comptes
    await expect(apiRequest('/auth/register', { method: 'POST', auth: false, body: { email: 'a@b.c', password: 'court', displayName: 'X', role: 'admin' } })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(login('acheteur@example.test', 'mauvais')).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    const s = await login('acheteur@example.test', DEMO_PASSWORD);
    expect(s.user.memberships).toEqual([]);
    await post('/auth/change-password', { currentPassword: DEMO_PASSWORD, newPassword: 'un-nouveau-mot-de-passe' });
    expect(mock.db.refreshCookie).toBeNull();
  });

  it('auth : vérification email, renvoi, mot de passe oublié, réinitialisation', async () => {
    const { mockOutbox } = await import('./handlers/auth');
    await apiRequest('/auth/forgot-password', { method: 'POST', auth: false, body: { email: 'acheteur@example.test' } });
    const reset = mockOutbox.at(-1);
    expect(reset?.kind).toBe('reset');
    await apiRequest('/auth/reset-password', { method: 'POST', auth: false, body: { token: reset?.token, password: 'nouveau-mot-de-passe-1' } });
    await expect(apiRequest('/auth/reset-password', { method: 'POST', auth: false, body: { token: reset?.token, password: 'nouveau-mot-de-passe-1' } })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await apiRequest('/auth/resend-verification', { method: 'POST', auth: false, body: { email: 'nonverifie@example.test' } });
    const verify = mockOutbox.at(-1);
    await apiRequest('/auth/verify-email', { method: 'POST', auth: false, body: { token: verify?.token } });
    expect(mock.db.users.find((u) => u.email === 'nonverifie@example.test')?.emailVerified).toBe(true);
    expect((await login('nonverifie@example.test', DEMO_PASSWORD)).user.emailVerified).toBe(true);
  });

  it('auth v1.5 : inscription ASCII, mot de passe courant refusé, dernière inscription gagne, vérif ⇒ sessions révoquées', async () => {
    const { mockOutbox } = await import('./handlers/auth');
    const reg = (email: string, password: string) => apiRequest('/auth/register', { method: 'POST', auth: false, body: { email, password, displayName: 'Test' } });
    await expect(reg('josé@exemple.fr', 'un-mot-de-passe-solide')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(reg('neuf@example.test', 'motdepasse123')).rejects.toMatchObject({ code: 'VALIDATION_ERROR', details: { fields: [{ path: 'password', message: 'Mot de passe trop courant' }] } });
    await reg('neuf@example.test', 'premier-mot-de-passe');
    const first = mockOutbox.at(-1)?.token;
    await reg('neuf@example.test', 'second-mot-de-passe');
    const second = mockOutbox.at(-1)?.token;
    await expect(apiRequest('/auth/verify-email', { method: 'POST', auth: false, body: { token: first } })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await login('acheteur@example.test', DEMO_PASSWORD);
    await apiRequest('/auth/verify-email', { method: 'POST', auth: false, body: { token: second } });
    await expect(login('neuf@example.test', 'premier-mot-de-passe')).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    await login('neuf@example.test', 'second-mot-de-passe');
  });

  it('catalogue : liste paginée, détail, brouillon invisible, query inconnue refusée', async () => {
    const page = await apiRequest<Page<EventPublic>>('/events', { auth: false, query: { pageSize: 2 } });
    expect(page.items).toHaveLength(2);
    expect(page.total).toBe(4);
    const ev = await apiRequest<EventPublic>(apiPath`/events/${IDS.eventConcert}`, { auth: false });
    expect(ev.ticketTypes[0]?.isEarly).toBe(true);
    expect(ev.rules.serviceFeeBasisPoints).toBe(250);
    expect(JSON.stringify(ev)).not.toContain('FR76'); // jamais d'IBAN en public
    await expect(apiRequest(apiPath`/events/${IDS.eventDraft}`, { auth: false })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(apiRequest('/events', { auth: false, query: { foo: 1 } })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('commandes : idempotence, plafonds, complet, email non vérifié, checkout, annulation', async () => {
    await login('acheteur@example.test', DEMO_PASSWORD);
    const key = crypto.randomUUID();
    const body = { eventId: IDS.eventConcert, paymentMethod: 'CARD', items: [{ ticketTypeId: IDS.ttFosse, quantity: 2 }] };
    const o1 = await post<Order>('/orders', body, { 'Idempotency-Key': key });
    const o2 = await post<Order>('/orders', body, { 'Idempotency-Key': key });
    expect(o2.id).toBe(o1.id);
    expect(o1.totalCents).toBe(o1.subtotalCents + o1.serviceFeeCents);
    expect(o1.items[0]?.unitPriceCents).toBe(1800); // early calculé serveur
    await expect(post('/orders', { ...body, items: [{ ticketTypeId: IDS.ttFosse, quantity: 3 }] }, { 'Idempotency-Key': key })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(post('/orders', { ...body, items: [{ ticketTypeId: IDS.ttFosse, quantity: 5 }] }, { 'Idempotency-Key': crypto.randomUUID() })).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED', details: { max: 6, alreadyOwned: 2 } });
    await expect(post('/orders', { eventId: IDS.eventSoldOut, paymentMethod: 'CARD', items: [{ ticketTypeId: IDS.ttSoldOut, quantity: 1 }] }, { 'Idempotency-Key': crypto.randomUUID() })).rejects.toMatchObject({ code: 'SOLD_OUT' });
    await expect(post('/orders', { eventId: IDS.eventOnline, paymentMethod: 'TRANSFER', items: [{ ticketTypeId: IDS.ttOnline, quantity: 1 }] }, { 'Idempotency-Key': crypto.randomUUID() })).rejects.toMatchObject({ code: 'PAYMENT_METHOD_UNAVAILABLE' });
    await expect(post('/orders', { ...body, priceCents: 1 }, { 'Idempotency-Key': crypto.randomUUID() })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    const { redirectUrl } = await post<{ redirectUrl: string }>(apiPath`/orders/${o1.id}/checkout`);
    expect(redirectUrl).toContain(`/mock-psp/${o1.id}`);
    const cancelled = await post<Order>(apiPath`/orders/${o1.id}/cancel`);
    expect(cancelled.status).toBe('CANCELLED');
    await expect(post(apiPath`/orders/${o1.id}/checkout`)).rejects.toMatchObject({ code: 'INVALID_STATE' });
    const list = await apiRequest<Page<Order>>('/orders');
    expect(list.total).toBe(1);
    await logout();
    // Contrat v1.5 : un compte non vérifié ne peut pas se connecter (mot de passe correct) ; aucune session.
    await expect(login('nonverifie@example.test', DEMO_PASSWORD)).rejects.toMatchObject({ status: 403, code: 'EMAIL_NOT_VERIFIED' });
    await expect(login('nonverifie@example.test', 'mauvais')).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    expect(mock.db.refreshCookie).toBeNull();
  });

  it('commandes : expiration ⇒ ORDER_EXPIRED ; commande d’un autre ⇒ 404', async () => {
    await login('acheteur@example.test', DEMO_PASSWORD);
    const o = await post<Order>('/orders', { eventId: IDS.eventConcert, paymentMethod: 'CARD', items: [{ ticketTypeId: IDS.ttBalcon, quantity: 1 }] }, { 'Idempotency-Key': crypto.randomUUID() });
    const stored = mock.db.orders.find((x) => x.id === o.id);
    if (stored) stored.expiresAt = new Date(Date.now() - 1000).toISOString();
    await expect(post(apiPath`/orders/${o.id}/checkout`)).rejects.toMatchObject({ code: 'ORDER_EXPIRED' });
    await logout();
    await login('manager@nuits.test', DEMO_PASSWORD);
    await expect(apiRequest(apiPath`/orders/${o.id}`)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('virement : instructions pour l’acheteur, IBAN masqué côté orga, AMOUNT_MISMATCH, billets émis', async () => {
    await login('acheteur@example.test', DEMO_PASSWORD);
    const o = await post<Order>('/orders', { eventId: IDS.eventConcert, paymentMethod: 'TRANSFER', items: [{ ticketTypeId: IDS.ttFosse, quantity: 2 }] }, { 'Idempotency-Key': crypto.randomUUID() });
    expect(o.status).toBe('AWAITING_TRANSFER');
    expect(o.transferInstructions?.iban).toBe('FR7630006000011234567890189');
    await logout();
    await login('manager@nuits.test', DEMO_PASSWORD);
    const orders = await apiRequest<Page<OrderAdmin>>(apiPath`/orgs/${IDS.orgNuits}/events/${IDS.eventConcert}/orders`, { query: { status: 'AWAITING_TRANSFER', q: 'acheteur' } });
    expect(orders.items[0]?.transferInstructions?.iban).toBe('FR76 •••• •••• 0189');
    await expect(post(apiPath`/orgs/${IDS.orgNuits}/orders/${o.id}/confirm-transfer`, { receivedAmountCents: 1 })).rejects.toMatchObject({ code: 'AMOUNT_MISMATCH' });
    const paid = await post<OrderAdmin>(apiPath`/orgs/${IDS.orgNuits}/orders/${o.id}/confirm-transfer`, { receivedAmountCents: o.totalCents });
    expect(paid.status).toBe('PAID');
    expect(mock.db.tickets.filter((t) => t.orderId === o.id)).toHaveLength(2);
  });

  it('billets : QR NG1.<eventId>.<publicId>.<sig> ; annulation payée ⇒ REFUNDED', async () => {
    const { order, ticket } = await buyTicket();
    const parts = ticket.qrPayload.split('.');
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe('NG1');
    expect(parts[1]).toBe(IDS.eventConcert);
    expect(parts[2]).toBe(ticket.publicId);
    expect(ticket.publicId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(parts[3]).toMatch(/^[A-Za-z0-9_-]{86}$/);
    const refunded = await post<Order>(apiPath`/orders/${order.id}/cancel`);
    expect(refunded.status).toBe('REFUNDED');
    expect(refunded.refundAmountCents).toBe(order.subtotalCents);
  });

  it('liste d’attente : inscription, doublon, NOT_SOLD_OUT, départ', async () => {
    await login('acheteur@example.test', DEMO_PASSWORD);
    const path = apiPath`/events/${IDS.eventSoldOut}/ticket-types/${IDS.ttSoldOut}/waitlist`;
    const entry = await post<WaitlistEntry>(path, { quantity: 2 });
    expect(entry.position).toBe(1);
    await expect(post(path, { quantity: 1 })).rejects.toMatchObject({ code: 'ALREADY_IN_WAITLIST' });
    await expect(post(apiPath`/events/${IDS.eventConcert}/ticket-types/${IDS.ttFosse}/waitlist`, { quantity: 1 })).rejects.toMatchObject({ code: 'NOT_SOLD_OUT' });
    expect((await apiRequest<{ items: WaitlistEntry[] }>('/me/waitlist')).items).toHaveLength(1);
    await expect(post(apiPath`/waitlist/${entry.id}/accept`)).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await apiRequest(apiPath`/waitlist/${entry.id}`, { method: 'DELETE' });
  });

  it('liste d’attente : place libérée ⇒ offre ⇒ acceptation ⇒ commande CARD', async () => {
    await login('acheteur@example.test', DEMO_PASSWORD);
    const entry = await post<WaitlistEntry>(apiPath`/events/${IDS.eventSoldOut}/ticket-types/${IDS.ttSoldOut}/waitlist`, { quantity: 1 });
    const tt = mock.db.ticketTypes.find((t) => t.id === IDS.ttSoldOut);
    if (tt) tt.held -= 2; // une réservation expire
    const { offerToWaitlist } = await import('./domain');
    if (tt) offerToWaitlist(tt);
    const offered = (await apiRequest<{ items: WaitlistEntry[] }>('/me/waitlist')).items[0];
    expect(offered?.status).toBe('OFFERED');
    const order = await post<Order>(apiPath`/waitlist/${entry.id}/accept`);
    expect(order).toMatchObject({ status: 'PENDING_PAYMENT', paymentMethod: 'CARD' });
  });

  it('back-office : rôles, 404 inter-collectifs, réglages, membres, audit', async () => {
    await login('manager@nuits.test', DEMO_PASSWORD);
    const settings = await apiRequest<{ bank: { ibanMasked: string } }>(apiPath`/orgs/${IDS.orgNuits}/settings`);
    expect(settings.bank.ibanMasked).toBe('FR76 •••• •••• 0189');
    await expect(apiRequest(apiPath`/orgs/${IDS.orgNuits}/settings`, { method: 'PATCH', body: { maxPerOrder: 4 } })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(apiRequest(apiPath`/orgs/${IDS.orgPartner}/events`)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(apiRequest(apiPath`/orgs/${IDS.orgNuits}/audit-log`)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect((await apiRequest<{ items: unknown[] }>(apiPath`/orgs/${IDS.orgNuits}/members`)).items.length).toBe(3);
    await logout();
    await login('owner@nuits.test', DEMO_PASSWORD);
    await expect(apiRequest(apiPath`/orgs/${IDS.orgNuits}/settings`, { method: 'PATCH', body: { maxPerOrder: 10, maxPerUser: 5 } })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(apiRequest(apiPath`/orgs/${IDS.orgNuits}/settings`, { method: 'PATCH', body: { bank: { beneficiary: 'X', iban: 'FR7630006000011234567890188', bic: 'AGRIFRPP' } } })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    const updated = await apiRequest<{ serviceFeeBasisPoints: number }>(apiPath`/orgs/${IDS.orgNuits}/settings`, { method: 'PATCH', body: { serviceFeeBasisPoints: 100 } });
    expect(updated.serviceFeeBasisPoints).toBe(100);
    await post(apiPath`/orgs/${IDS.orgNuits}/members`, { email: 'acheteur@example.test', role: 'SCANNER' });
    await expect(post(apiPath`/orgs/${IDS.orgNuits}/members`, { email: 'acheteur@example.test', role: 'SCANNER' })).rejects.toMatchObject({ code: 'CONFLICT' });
    await apiRequest(apiPath`/orgs/${IDS.orgNuits}/members/${IDS.userBuyer}`, { method: 'PATCH', body: { role: 'MANAGER' } });
    await apiRequest(apiPath`/orgs/${IDS.orgNuits}/members/${IDS.userBuyer}`, { method: 'DELETE' });
    await expect(apiRequest(apiPath`/orgs/${IDS.orgNuits}/members/${IDS.userOwner}`, { method: 'DELETE' })).rejects.toMatchObject({ code: 'CONFLICT' });
    const audit = await apiRequest<Page<{ action: string }>>(apiPath`/orgs/${IDS.orgNuits}/audit-log`);
    expect(audit.items[0]?.action).toBe('member.remove');
    expect((await apiRequest<{ name: string }>(apiPath`/orgs/${IDS.orgNuits}`)).name).toBe('Les Nuits de la Garonne');
  });

  it('back-office : cycle de vie d’un événement et de ses types de places', async () => {
    await login('manager@nuits.test', DEMO_PASSWORD);
    const base = apiPath`/orgs/${IDS.orgNuits}/events`;
    const ev = await post<EventAdmin>(base, {
      title: 'Test', isOnline: false, startsAt: '2027-01-10T19:00:00.000Z', endsAt: '2027-01-10T23:00:00.000Z', timezone: 'Europe/Paris',
      salesStartAt: '2026-10-01T08:00:00.000Z', salesEndAt: '2027-01-10T19:00:00.000Z', overrides: { maxPerOrder: 2 },
    });
    expect(ev.status).toBe('DRAFT');
    expect(ev.effectiveRules.maxPerOrder).toBe(2);
    const evPath = `${base}/${encodeURIComponent(ev.id)}`;
    await expect(post(`${evPath}/publish`)).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(post(`${evPath}/ticket-types`, { name: 'VIP', capacity: 10, priceCents: 1000, earlyPriceCents: 1200, earlyUntil: '2026-12-01T00:00:00.000Z' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    const tt = await post<{ id: string }>(`${evPath}/ticket-types`, { name: 'VIP', capacity: 10, priceCents: 1000 });
    await apiRequest(`${evPath}/ticket-types/${tt.id}`, { method: 'PATCH', body: { capacity: 12 } });
    expect((await post<EventAdmin>(`${evPath}/publish`)).status).toBe('PUBLISHED');
    await apiRequest(evPath, { method: 'PATCH', body: { title: 'Test modifié', overrides: { maxPerOrder: null } } });
    expect((await apiRequest<EventAdmin>(evPath)).effectiveRules.maxPerOrder).toBe(6);
    await apiRequest(`${evPath}/ticket-types/${tt.id}`, { method: 'DELETE' });
    await expect(post(`${evPath}/cancel`, { reason: 'Test' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await logout();
    await login('owner@nuits.test', DEMO_PASSWORD);
    expect((await post<EventAdmin>(`${evPath}/cancel`, { reason: 'Météo' })).status).toBe('CANCELLED');
    expect((await apiRequest<Page<EventAdmin>>(base, { query: { status: 'CANCELLED' } })).total).toBe(1);
  });

  it('stats, export CSV (Blob), snapshot, scan (idempotent par scanId), sync', async () => {
    const { ticket } = await buyTicket();
    await logout();
    await login('manager@nuits.test', DEMO_PASSWORD);
    const evPath = apiPath`/orgs/${IDS.orgNuits}/events/${IDS.eventConcert}`;
    const stats = await apiRequest<EventStats>(`${evPath}/stats`);
    expect(stats.ordersByStatus.PAID).toBe(1);
    const csv = await apiRequest<Blob>(`${evPath}/attendees.csv`, { responseKind: 'blob' });
    const text = await csv.text();
    expect(text).toContain('billet;type;nom;email;statut;scanne_le');
    expect(text).toContain(ticket.publicId);
    await logout();

    await login('scanner@nuits.test', DEMO_PASSWORD);
    const snap = await apiRequest<CheckinSnapshot>(`${evPath}/checkin/snapshot`);
    expect(snap.publicKeyJwk).toMatchObject({ kty: 'OKP', crv: 'Ed25519' });
    expect(snap.tickets[0]).toEqual({ publicId: ticket.publicId, ticketTypeName: 'Fosse', holderInitials: 'J.D.', status: 'VALID', usedAt: null });
    expect(JSON.stringify(snap)).not.toContain('acheteur@example.test');
    await expect(apiRequest(`${evPath}/stats`)).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const deviceId = crypto.randomUUID();
    const scanId = crypto.randomUUID();
    const first = await post<ScanResponse>(`${evPath}/checkin/scan`, { qrPayload: ticket.qrPayload, deviceId, scanId });
    expect(first.result).toBe('OK');
    const replay = await post<ScanResponse>(`${evPath}/checkin/scan`, { qrPayload: ticket.qrPayload, deviceId, scanId });
    expect(replay.result).toBe('OK'); // même scanId ⇒ résultat d'origine
    const again = await post<ScanResponse>(`${evPath}/checkin/scan`, { qrPayload: ticket.qrPayload, deviceId, scanId: crypto.randomUUID() });
    expect(again.result).toBe('ALREADY_USED');
    const forged = ticket.qrPayload.slice(0, -2) + (ticket.qrPayload.endsWith('AA') ? 'BB' : 'AA');
    expect((await post<ScanResponse>(`${evPath}/checkin/scan`, { qrPayload: forged, deviceId, scanId: crypto.randomUUID() })).result).toBe('INVALID');

    const sync = await post<SyncResponse>(`${evPath}/checkin/sync`, {
      deviceId,
      scans: [
        { scanId, qrPayload: ticket.qrPayload, scannedAt: new Date().toISOString() },
        { scanId: crypto.randomUUID(), qrPayload: ticket.qrPayload, scannedAt: new Date().toISOString() },
      ],
    });
    expect(sync.results.map((r) => r.result).sort()).toEqual(['ACCEPTED', 'ALREADY_USED']);
    expect(sync.results.find((r) => r.scanId === scanId)?.result).toBe('ACCEPTED');
  });

  it('v1.7 : scanner limité à checkin/events (sans chiffres) ; pagination ≤ 1000', async () => {
    await login('scanner@nuits.test', DEMO_PASSWORD);
    await expect(apiRequest(apiPath`/orgs/${IDS.orgNuits}/events`)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(apiRequest(apiPath`/orgs/${IDS.orgNuits}/events/${IDS.eventConcert}`)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const { items } = await apiRequest<{ items: Record<string, unknown>[] }>(apiPath`/orgs/${IDS.orgNuits}/checkin/events`);
    expect(items.map((e) => e.id)).toContain(IDS.eventConcert);
    expect(items.map((e) => e.id)).not.toContain(IDS.eventDraft);
    expect(Object.keys(items[0] ?? {}).sort()).toEqual(['endsAt', 'id', 'isOnline', 'startsAt', 'status', 'timezone', 'title', 'venue']);
    await expect(apiRequest('/events', { auth: false, query: { page: 1001 } })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('v1.7 : coordonnées bancaires ⇒ mot de passe actuel obligatoire', async () => {
    await login('owner@nuits.test', DEMO_PASSWORD);
    const bank = { beneficiary: 'Nuits', iban: 'FR7630006000011234567890189', bic: 'AGRIFRPPXXX' };
    const path = apiPath`/orgs/${IDS.orgNuits}/settings`;
    await expect(apiRequest(path, { method: 'PATCH', body: { bank } })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(apiRequest(path, { method: 'PATCH', body: { bank, currentPassword: 'faux' } })).rejects.toMatchObject({ status: 401, code: 'INVALID_CREDENTIALS' });
    expect(mock.db.calls.get('POST /auth/refresh') ?? 0).toBe(0);
    await apiRequest(path, { method: 'PATCH', body: { bank, currentPassword: DEMO_PASSWORD } });
  });

  it('v1.7 : report d’un événement vendu ⇒ OWNER + motif ; acheteurs remboursables à 100 %', async () => {
    await login('acheteur@example.test', DEMO_PASSWORD);
    const order = await post<Order>('/orders', { eventId: IDS.eventConcert, paymentMethod: 'CARD', items: [{ ticketTypeId: IDS.ttFosse, quantity: 1 }] }, { 'Idempotency-Key': crypto.randomUUID() });
    await logout();
    const evPath = apiPath`/orgs/${IDS.orgNuits}/events/${IDS.eventConcert}`;
    const ev = mock.db.events.find((e) => e.id === IDS.eventConcert);
    const later = new Date(Date.parse(ev?.startsAt ?? '') + 86_400_000).toISOString();
    const laterEnd = new Date(Date.parse(ev?.endsAt ?? '') + 86_400_000).toISOString();
    const salesEnd = later;
    await login('manager@nuits.test', DEMO_PASSWORD);
    await expect(apiRequest(evPath, { method: 'PATCH', body: { startsAt: later, endsAt: laterEnd, salesEndAt: salesEnd, rescheduleReason: 'Météo' } })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await logout();
    await login('owner@nuits.test', DEMO_PASSWORD);
    await expect(apiRequest(evPath, { method: 'PATCH', body: { startsAt: later, endsAt: laterEnd } })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await apiRequest(evPath, { method: 'PATCH', body: { startsAt: later, endsAt: laterEnd, salesEndAt: salesEnd, rescheduleReason: 'Météo' } });
    expect(mock.db.orders.find((o) => o.id === order.id)?.refundPercent).toBe(order.refundPercent); // non payée : inchangée
    const audit = await apiRequest<Page<{ action: string; actorEmail: string | null }>>(apiPath`/orgs/${IDS.orgNuits}/audit-log`);
    expect(audit.items[0]?.action).toBe('event.update');
    expect(audit.items.map((a) => a.action)).toContain('event.reschedule');
    expect(audit.items.some((a) => a.actorEmail === null)).toBe(true);
  });

  it('admin plateforme : réservé, création de collectif', async () => {
    await login('owner@nuits.test', DEMO_PASSWORD);
    await expect(apiRequest('/admin/orgs')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await logout();
    await login('admin@plateforme.test', DEMO_PASSWORD);
    const org = await post<{ slug: string }>('/admin/orgs', { name: 'Nouveau collectif', slug: 'nouveau', ownerEmail: 'acheteur@example.test' });
    expect(org.slug).toBe('nouveau');
    await expect(post('/admin/orgs', { name: 'Doublon', slug: 'nouveau', ownerEmail: 'acheteur@example.test' })).rejects.toMatchObject({ code: 'CONFLICT' });
    const page = await apiRequest<Page<{ name: string }>>('/admin/orgs', { query: { pageSize: 2 } });
    expect(page.total).toBe(3);
    expect(page.items.map((o) => o.name)).toEqual(['Collectif Rive Droite', 'Les Nuits de la Garonne']); // tri par nom
    expect((await apiRequest<Page<{ name: string }>>('/admin/orgs', { query: { page: 2, pageSize: 2 } })).items.map((o) => o.name)).toEqual(['Nouveau collectif']);
  });

  it('commande à 0 € ⇒ PAID immédiatement (contrat v1.2)', async () => {
    const tt = mock.db.ticketTypes.find((t) => t.id === IDS.ttPartner);
    if (tt) tt.priceCents = 0;
    await login('acheteur@example.test', DEMO_PASSWORD);
    const o = await post<Order>('/orders', { eventId: IDS.eventPartner, paymentMethod: 'CARD', items: [{ ticketTypeId: IDS.ttPartner, quantity: 1 }] }, { 'Idempotency-Key': crypto.randomUUID() });
    expect(o.status).toBe('PAID');
    expect((await apiRequest<{ items: Ticket[] }>('/me/tickets')).items).toHaveLength(1);
  });
});
