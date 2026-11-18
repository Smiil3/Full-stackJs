/**
 * Anti-gel de la liste d'attente (contrat v1.18 §6, audit n° 2 B'4) dans le faux serveur : il doit compter
 * les offres non honorées comme le backend, sinon l'écran d'offre est développé contre de mauvaises règles.
 */
import { describe, expect, it } from 'vitest';
import { apiPath, apiRequest, login } from '../api/client';
import type { Order, WaitlistEntry } from '../api/types';
import { mock } from './core';
import { offerToWaitlist } from './domain';
import { DEMO_PASSWORD, IDS } from './state';

const MIN = 60_000;
/** Le type redevient complet (une place rendue au public a été revendue). */
function soldOut(): void {
  const tt = soldOutType();
  tt.held = tt.capacity - tt.sold;
}
const register = () => apiRequest<WaitlistEntry>(apiPath`/events/${IDS.eventSoldOut}/ticket-types/${IDS.ttSoldOut}/waitlist`, { method: 'POST', body: { quantity: 1 } });
const myEntry = async (id: string) => (await apiRequest<{ items: WaitlistEntry[] }>('/me/waitlist')).items.find((w) => w.id === id);
const stored = (id: string) => mock.db.waitlist.find((w) => w.id === id) ?? (() => { throw new Error(id); })();
const soldOutType = () => mock.db.ticketTypes.find((t) => t.id === IDS.ttSoldOut) ?? (() => { throw new Error('type'); })();

/** Inscription puis place libérée ⇒ offre. */
async function offered(): Promise<WaitlistEntry> {
  soldOut();
  const entry = await register();
  const tt = soldOutType();
  tt.held -= 1; // une réservation expire
  offerToWaitlist(tt);
  expect(stored(entry.id).status).toBe('OFFERED');
  return entry;
}
const expireOffer = (id: string) => {
  stored(id).offerExpiresAt = new Date(Date.now() - 1000).toISOString();
};

describe('liste d’attente : anti-gel v1.18 (faux serveur)', () => {
  it('offre expirée ⇒ inscription close, 1 sur 2, réinscription possible ; la 2ᵉ ⇒ sortie, réinscription 409 CONFLICT', async () => {
    await login('acheteur@example.test', DEMO_PASSWORD);
    const first = await offered();
    expireOffer(first.id);
    expect(await myEntry(first.id)).toMatchObject({ status: 'EXPIRED', unhonoredOffers: 1 });
    const second = await offered(); // réinscription acceptée
    expect(second.unhonoredOffers).toBe(1);
    expireOffer(second.id);
    expect(await myEntry(second.id)).toMatchObject({ status: 'EXPIRED', unhonoredOffers: 2 });
    soldOut();
    await expect(register()).rejects.toMatchObject({ status: 409, code: 'CONFLICT' });
  });

  it('offre quittée dans les 15 min ⇒ pas pénalisée ; plus de 15 min après son émission ⇒ non honorée', async () => {
    await login('acheteur@example.test', DEMO_PASSWORD);
    const quick = await offered();
    stored(quick.id).offeredAt = new Date(Date.now() - 14 * MIN).toISOString();
    await apiRequest(apiPath`/waitlist/${quick.id}`, { method: 'DELETE' });
    expect(await myEntry(quick.id)).toMatchObject({ status: 'LEFT', unhonoredOffers: 0 });
    const late = await offered();
    stored(late.id).offeredAt = new Date(Date.now() - 16 * MIN).toISOString();
    await apiRequest(apiPath`/waitlist/${late.id}`, { method: 'DELETE' });
    expect(await myEntry(late.id)).toMatchObject({ status: 'LEFT', unhonoredOffers: 1 });
  });

  it('commande issue d’une offre, expirée sans paiement ⇒ non honorée', async () => {
    await login('acheteur@example.test', DEMO_PASSWORD);
    const entry = await offered();
    const order = await apiRequest<Order>(apiPath`/waitlist/${entry.id}/accept`, { method: 'POST' });
    expect(await myEntry(entry.id)).toMatchObject({ status: 'CONVERTED', unhonoredOffers: 0 });
    const o = mock.db.orders.find((x) => x.id === order.id);
    if (o) o.expiresAt = new Date(Date.now() - 1000).toISOString();
    expect(await myEntry(entry.id)).toMatchObject({ status: 'CONVERTED', unhonoredOffers: 1 });
  });

  it('2ᵉ offre non honorée ⇒ les autres inscriptions actives du compte sur l’événement sont closes', async () => {
    await login('acheteur@example.test', DEMO_PASSWORD);
    const other = { ...stored((await register()).id) }; // inscription sur un autre type du même événement
    mock.db.waitlist = mock.db.waitlist.filter((w) => w.id !== other.id);
    mock.db.waitlist.push({ ...other, id: crypto.randomUUID(), ticketTypeId: crypto.randomUUID() });
    const otherId = mock.db.waitlist[mock.db.waitlist.length - 1]?.id ?? '';
    const a = await offered();
    expireOffer(a.id);
    await myEntry(a.id);
    expect(stored(otherId).status).toBe('WAITING'); // 1 sur 2 : rien ne change
    const b = await offered();
    expireOffer(b.id);
    await myEntry(b.id);
    expect(stored(otherId).status).toBe('EXPIRED');
  });

  it('moins de 15 min avant la fin des ventes ⇒ aucune offre ; sinon offre bornée par la fin des ventes', async () => {
    await login('acheteur@example.test', DEMO_PASSWORD);
    const event = mock.db.events.find((e) => e.id === IDS.eventSoldOut);
    if (!event) throw new Error('événement');
    const entry = await register();
    const tt = soldOutType();
    tt.held -= 1;
    event.salesEndAt = new Date(Date.now() + 14 * MIN).toISOString();
    offerToWaitlist(tt);
    expect(stored(entry.id).status).toBe('WAITING');
    event.salesEndAt = new Date(Date.now() + 20 * MIN).toISOString();
    offerToWaitlist(tt);
    expect(stored(entry.id).status).toBe('OFFERED');
    expect(stored(entry.id).offerExpiresAt).toBe(event.salesEndAt);
  });
});
