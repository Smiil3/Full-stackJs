import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../src/lib/db.js';
import { csvCell, csvRow } from '../../src/lib/csv.js';
import { api, loggedInUser, type LoggedIn } from '../helpers.js';
import { createEvent, orgWithStaff, type OrgFixture } from '../fixtures.js';
import { openSession, paymentEvent, postWebhook, startPsp, type PspHarness } from '../psp.js';

let org: OrgFixture;
let h: PspHarness;

beforeEach(async () => {
  org = await orgWithStaff('collectif-stats');
  h = await startPsp();
});
afterEach(async () => {
  await h.close();
});

async function buy(who: LoggedIn, eventId: string, ttId: string, quantity: number, pay = true) {
  const res = await api().post('/api/v1/orders').set(who.auth).set('Idempotency-Key', randomUUID())
    .send({ eventId, paymentMethod: 'CARD', items: [{ ticketTypeId: ttId, quantity }] }).expect(201);
  if (pay) {
    const sessionId = await openSession(res.body.id as string, who.auth);
    await postWebhook(paymentEvent(res.body.id as string, res.body.totalCents as number, { sessionId })).expect(200);
  }
  return res.body.id as string;
}

describe('statistiques temps réel', () => {
  it('chiffres exacts après ventes, scans, remboursements', async () => {
    await api().patch(`/api/v1/orgs/${org.id}/settings`).set(org.owner.auth).send({ serviceFeeFixedCents: 100, refundPercent: 50 }).expect(200);
    const ev = await createEvent(org, { ticketTypes: [{ name: 'Fosse', capacity: 100, priceCents: 2000 }, { name: 'Balcon', capacity: 20, priceCents: 3000 }], publish: true });
    const [fosse, balcon] = ev.ticketTypeIds as [string, string];
    const a = await loggedInUser();
    const b = await loggedInUser({ displayName: 'Bob' });
    const c = await loggedInUser();
    await buy(a, ev.eventId, fosse, 3); // 6000 + 100 frais
    const bOrder = await buy(b, ev.eventId, balcon, 2); // 6000 + 100 frais
    await buy(c, ev.eventId, fosse, 1, false); // en attente : held
    // b annule : 50 % de 6000 = 3000 remboursés, frais non remboursables.
    await api().post(`/api/v1/orders/${bOrder}/cancel`).set(b.auth).expect(200);
    // un billet de a est scanné.
    const ticket = ((await api().get('/api/v1/me/tickets').set(a.auth)).body.items as { qrPayload: string }[])[0]!;
    await api().post(`/api/v1/orgs/${org.id}/events/${ev.eventId}/checkin/scan`).set(org.scanner.auth).send({ qrPayload: ticket.qrPayload, deviceId: randomUUID(), scanId: randomUUID() }).expect(200);
    const res = await api().get(`/api/v1/orgs/${org.id}/events/${ev.eventId}/stats`).set(org.manager.auth).expect(200);
    expect(res.body.ticketTypes).toEqual([
      { ticketTypeId: fosse, name: 'Fosse', capacity: 100, sold: 3, held: 1, remaining: 96, checkedIn: 1, revenueCents: 6000, refundedCents: 0 },
      { ticketTypeId: balcon, name: 'Balcon', capacity: 20, sold: 0, held: 0, remaining: 20, checkedIn: 0, revenueCents: 3000, refundedCents: 3000 },
    ]);
    expect(res.body.totals).toEqual({
      capacity: 120, sold: 3, held: 1, remaining: 116, checkedIn: 1, revenueCents: 9000, refundedCents: 3000, serviceFeeCents: 200, refundsToProcess: 0,
    });
    expect(res.body.ordersByStatus).toEqual({ PENDING_PAYMENT: 1, AWAITING_TRANSFER: 0, PAID: 1, EXPIRED: 0, CANCELLED: 0, REFUNDED: 1 });
    expect(res.body.waitlistWaiting).toBe(0);
    await getDb().refund.updateMany({ data: { status: 'MANUAL_REQUIRED' } });
    const again = await api().get(`/api/v1/orgs/${org.id}/events/${ev.eventId}/stats`).set(org.manager.auth).expect(200);
    expect(again.body.totals.refundsToProcess).toBe(1);
  });

  it('isolation : stats d’un autre collectif ⇒ 404 ; SCANNER ⇒ 403', async () => {
    const ev = await createEvent(org, { ticketTypes: [{ name: 'A', capacity: 10, priceCents: 1000 }], publish: true });
    const other = await orgWithStaff('autre-stats');
    await api().get(`/api/v1/orgs/${other.id}/events/${ev.eventId}/stats`).set(other.owner.auth).expect(404);
    await api().get(`/api/v1/orgs/${org.id}/events/${ev.eventId}/stats`).set(org.scanner.auth).expect(403);
  });
});

describe('export CSV des participants', () => {
  it('cellules protégées contre l’injection de formules et échappées', () => {
    expect(csvCell('=HYPERLINK("http://x")')).toBe(`"'=HYPERLINK(""http://x"")"`);
    for (const p of ['+1', '-1', '@SUM(A1)', '\tx', '\rx']) expect(csvCell(p).replace(/^"/, '').startsWith("'")).toBe(true);
    expect(csvCell('a;b')).toBe('"a;b"');
    expect(csvCell('ligne1\nligne2')).toBe('"ligne1\nligne2"');
    expect(csvCell('normal')).toBe('normal');
    expect(csvCell(null)).toBe('');
    expect(csvRow(['a', 'b'])).toBe('a;b\r\n');
  });

  it('flux CSV : en-têtes, BOM, colonnes, heure locale, injection neutralisée, audit', async () => {
    const ev = await createEvent(org, { ticketTypes: [{ name: '=Fosse', capacity: 10, priceCents: 0 }], publish: true, body: { timezone: 'America/New_York' } });
    const evil = await loggedInUser({ displayName: '=cmd|"/C calc"!A0', email: 'evil@test.fr' });
    await buy(evil, ev.eventId, ev.ticketTypeIds[0]!, 1, false);
    const ticket = ((await api().get('/api/v1/me/tickets').set(evil.auth)).body.items as { qrPayload: string; publicId: string }[])[0]!;
    await api().post(`/api/v1/orgs/${org.id}/events/${ev.eventId}/checkin/scan`).set(org.scanner.auth).send({ qrPayload: ticket.qrPayload, deviceId: randomUUID(), scanId: randomUUID() }).expect(200);
    const res = await api().get(`/api/v1/orgs/${org.id}/events/${ev.eventId}/attendees.csv`).set(org.manager.auth).buffer(true).parse((r, cb) => {
      let data = '';
      r.setEncoding('utf8');
      r.on('data', (c: string) => { data += c; });
      r.on('end', () => { cb(null, data); });
    }).expect(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toBe(`attachment; filename="participants-${ev.eventId}.csv"`);
    const text = res.body as string;
    expect(text.charCodeAt(0)).toBe(0xfeff);
    const lines = text.slice(1).split('\r\n');
    expect(lines[0]).toBe('billet;type;nom;email;statut;scanne_le');
    expect(lines[1]!.startsWith(`${ticket.publicId};'=Fosse;"'=cmd|""/C calc""!A0";evil@test.fr;scanné;`)).toBe(true);
    const used = await getDb().ticket.findFirstOrThrow({ where: { publicId: ticket.publicId } });
    const local = new Intl.DateTimeFormat('fr-FR', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(used.usedAt!);
    expect(lines[1]!.endsWith(local)).toBe(true);
    expect(await getDb().auditLog.count({ where: { action: 'attendees.export', orgId: org.id } })).toBe(1);
  });

  it('export d’un autre collectif ⇒ 404 ; SCANNER ⇒ 403', async () => {
    const ev = await createEvent(org, { ticketTypes: [{ name: 'A', capacity: 10, priceCents: 1000 }], publish: true });
    const other = await orgWithStaff('autre-export');
    await api().get(`/api/v1/orgs/${other.id}/events/${ev.eventId}/attendees.csv`).set(other.owner.auth).expect(404);
    await api().get(`/api/v1/orgs/${org.id}/events/${ev.eventId}/attendees.csv`).set(org.scanner.auth).expect(403);
  });
});
