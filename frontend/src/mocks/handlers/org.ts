import * as ed from '@noble/ed25519';
import type { OrderStatus, OrgRole, ScanResult, SyncResult } from '../../api/types';
import { ORDER_STATUSES } from '../../api/types';
import { base64urlToBytes } from '../../lib/base64url';
import { audit, control, fail, json, mock, noContent, notFound, param, paginate, readBody, readQuery, requireOrgRole, route, type Validator } from '../core';
import { mockPublicKeyJwk } from '../crypto';
import { cancelOrder, expireDueOrders, markPaid } from '../domain';
import { toEventAdmin, toMember, toOrderAdmin, toRefund, toSettings, toTicketTypeAdmin, typesOf } from '../serializers';
import { maskIban, NO_OVERRIDES, remaining, type MockEvent, type MockSettings } from '../state';

const ORG_ROLES: readonly OrgRole[] = ['OWNER', 'MANAGER', 'SCANNER'];
/** Taille des lots d'annulation simulés (v1.14). */
const CANCEL_BATCH = 2;

/** Bornes du plan (§ Paramètres configurables). */
const BOUNDS = {
  cardHoldMinutes: [5, 60],
  transferHoldHours: [1, 240],
  cancellationDeadlineHours: [0, 720],
  refundPercent: [0, 100],
  maxPerOrder: [1, 20],
  maxPerUser: [1, 50],
  waitlistOfferMinutes: [15, 2880],
  serviceFeeFixedCents: [0, 1000],
  serviceFeeBasisPoints: [0, 1500],
} as const;
const BOOLS = ['transferEnabled', 'selfCancellationEnabled', 'waitlistEnabled'] as const;

export function ibanIsValid(raw: string): boolean {
  const iban = raw.replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(iban)) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let rem = 0;
  for (const ch of rearranged) {
    const n = ch >= 'A' ? ch.charCodeAt(0) - 55 : Number(ch);
    rem = Number(String(rem) + String(n)) % 97;
  }
  return rem === 1;
}

function orgEvent(orgId: string, eventId: string): MockEvent {
  return mock.db.events.find((e) => e.id === eventId && e.orgId === orgId) ?? notFound();
}

function readOverrides(v: Validator, raw: unknown) {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    v.custom('overrides', 'Objet attendu');
    return undefined;
  }
  const o = raw as Record<string, unknown>;
  const out: Record<string, number | boolean | null> = {};
  for (const [k, val] of Object.entries(o)) {
    if (k in BOUNDS) {
      const [min, max] = BOUNDS[k as keyof typeof BOUNDS];
      if (val === null) out[k] = null;
      else if (typeof val !== 'number' || !Number.isInteger(val) || val < min || val > max) v.custom(`overrides.${k}`, `Entier entre ${min} et ${max}`);
      else out[k] = val;
    } else if ((BOOLS as readonly string[]).includes(k)) {
      if (val === null || typeof val === 'boolean') out[k] = val;
      else v.custom(`overrides.${k}`, 'Booléen ou null');
    } else v.custom(`overrides.${k}`, 'Champ non autorisé');
  }
  return out;
}

const EVENT_FIELDS = ['title', 'description', 'venue', 'address', 'isOnline', 'startsAt', 'endsAt', 'timezone', 'salesStartAt', 'salesEndAt', 'overrides'];

function validateEventBody(v: Validator, partial: boolean) {
  const o = { optional: partial };
  const data = {
    title: v.str('title', { ...o, min: 1, max: 150 }),
    description: v.str('description', { optional: true, nullable: true, max: 5000 }),
    venue: v.str('venue', { optional: true, nullable: true, max: 150 }),
    address: v.str('address', { optional: true, nullable: true, max: 300 }),
    isOnline: v.bool('isOnline', o),
    startsAt: v.date('startsAt', o),
    endsAt: v.date('endsAt', o),
    timezone: v.str('timezone', { ...o, min: 1, max: 64 }),
    salesStartAt: v.date('salesStartAt', o),
    salesEndAt: v.date('salesEndAt', o),
    overrides: readOverrides(v, v.body.overrides),
  };
  if (typeof data.timezone === 'string') {
    try {
      new Intl.DateTimeFormat('fr', { timeZone: data.timezone });
    } catch {
      v.custom('timezone', 'Fuseau IANA inconnu');
    }
  }
  return data;
}

function validateTicketType(v: Validator, partial: boolean) {
  const o = { optional: partial };
  const d = {
    name: v.str('name', { ...o, min: 1, max: 80 }),
    description: v.str('description', { optional: true, nullable: true, max: 500 }),
    capacity: v.int('capacity', { ...o, min: 1, max: 100_000 }),
    priceCents: v.int('priceCents', { ...o, min: 0, max: 1_000_000 }),
    earlyPriceCents: v.int('earlyPriceCents', { optional: true, nullable: true, min: 0, max: 1_000_000 }),
    earlyUntil: v.date('earlyUntil', { optional: true, nullable: true }),
    sortOrder: v.int('sortOrder', { optional: true, min: 0, max: 1000 }),
  };
  return d;
}

function checkEarly(v: Validator, price: number, earlyPrice: number | null, earlyUntil: string | null, salesEndAt: string) {
  if ((earlyPrice === null) !== (earlyUntil === null)) v.custom('earlyPriceCents', 'Tarif early : prix et date ensemble ou aucun');
  if (earlyUntil && earlyUntil > salesEndAt) v.custom('earlyUntil', 'Doit précéder la fin des ventes');
  if (earlyPrice !== null && earlyPrice >= price) v.custom('earlyPriceCents', 'Le tarif early doit être inférieur au prix normal');
}

async function scanOne(eventId: string, qrPayload: string): Promise<{ result: ScanResult; publicId: string | null }> {
  const parts = qrPayload.split('.');
  if (parts.length !== 4 || parts[0] !== 'NG1') return { result: 'INVALID', publicId: null };
  const [, qrEvent, publicId, sigB64] = parts as [string, string, string, string];
  const sig = base64urlToBytes(sigB64);
  const pub = base64urlToBytes((await mockPublicKeyJwk()).x);
  if (!sig || !pub || sig.length !== 64) return { result: 'INVALID', publicId: null };
  const ok = await ed.verifyAsync(sig, new TextEncoder().encode(`NG1.${qrEvent}.${publicId}`), pub).catch(() => false);
  if (!ok) return { result: 'INVALID', publicId: null };
  if (qrEvent !== eventId) return { result: 'WRONG_EVENT', publicId };
  const ticket = mock.db.tickets.find((t) => t.publicId === publicId && t.eventId === eventId);
  if (!ticket) return { result: 'INVALID', publicId };
  if (ticket.status === 'CANCELLED') return { result: 'CANCELLED', publicId };
  if (ticket.status === 'USED') return { result: 'ALREADY_USED', publicId };
  ticket.status = 'USED';
  ticket.usedAt = new Date().toISOString();
  return { result: 'OK', publicId };
}

function initials(name: string): string {
  return name
    .split(/[\s-]+/)
    .filter(Boolean)
    .slice(0, 3)
    .map((p) => `${p[0]?.toUpperCase() ?? ''}.`)
    .join('');
}

function holderOf(publicId: string) {
  const t = mock.db.tickets.find((x) => x.publicId === publicId);
  const order = t && mock.db.orders.find((o) => o.id === t.orderId);
  const user = order && mock.db.users.find((u) => u.id === order.userId);
  const tt = t && mock.db.ticketTypes.find((x) => x.id === t.ticketTypeId);
  return t ? { publicId, ticketTypeName: tt?.name ?? '', holderInitials: initials(user?.displayName ?? '') } : null;
}

function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[;"\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** Contrat v1.15 : contrôle possible de startsAt − 12 h à endsAt + 24 h, événement PUBLISHED. */
function checkinOpen(e: MockEvent): boolean {
  const now = Date.now();
  return e.status === 'PUBLISHED' && now >= Date.parse(e.startsAt) - 12 * 3_600_000 && now < Date.parse(e.endsAt) + 24 * 3_600_000;
}

export const orgHandlers = [
  // ---------------- Collectif ----------------
  route('get', '/orgs/:orgId', ({ request, params }) => {
    const orgId = param(params, 'orgId');
    requireOrgRole(request, orgId, 'SCANNER');
    const org = mock.db.orgs.find((o) => o.id === orgId) ?? notFound();
    return json({ id: org.id, name: org.name, slug: org.slug, createdAt: org.createdAt });
  }),

  route('get', '/orgs/:orgId/settings', ({ request, params }) => {
    const orgId = param(params, 'orgId');
    requireOrgRole(request, orgId, 'MANAGER');
    return json(toSettings(mock.db.settings.get(orgId) ?? notFound()));
  }),

  route('patch', '/orgs/:orgId/settings', async ({ request, params }) => {
    const orgId = param(params, 'orgId');
    const actor = requireOrgRole(request, orgId, 'OWNER');
    const current = mock.db.settings.get(orgId) ?? notFound();
    const v = await readBody(request, [...Object.keys(BOUNDS), ...BOOLS, 'serviceFeeRefundable', 'defaultTimezone', 'contactEmail', 'bank', 'currentPassword']);
    const next: MockSettings = { ...current, bank: { ...current.bank } };
    for (const [k, [min, max]] of Object.entries(BOUNDS)) {
      const n = v.int(k, { optional: true, min, max });
      if (typeof n === 'number') (next as Record<string, unknown>)[k] = n;
    }
    for (const k of [...BOOLS, 'serviceFeeRefundable'] as const) {
      const b = v.bool(k, { optional: true });
      if (typeof b === 'boolean') next[k] = b;
    }
    const tz = v.str('defaultTimezone', { optional: true, min: 1, max: 64 });
    if (typeof tz === 'string') next.defaultTimezone = tz;
    const email = v.email('contactEmail', { optional: true, nullable: true });
    if (email !== undefined) next.contactEmail = email;
    if (v.has('bank')) {
      const bank = v.body.bank as Record<string, unknown> | null;
      if (!bank || typeof bank !== 'object' || Object.keys(bank).some((k) => !['beneficiary', 'iban', 'bic'].includes(k))) v.custom('bank', 'Objet { beneficiary, iban, bic } attendu');
      else {
        const { beneficiary, iban, bic } = bank;
        if (typeof beneficiary !== 'string' || beneficiary.trim().length < 1 || beneficiary.length > 140) v.custom('bank.beneficiary', 'Titulaire requis');
        if (typeof iban !== 'string' || !ibanIsValid(iban)) v.custom('bank.iban', 'IBAN invalide');
        if (typeof bic !== 'string' || !/^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(bic.toUpperCase())) v.custom('bank.bic', 'BIC invalide');
        if (typeof beneficiary === 'string' && typeof iban === 'string' && typeof bic === 'string') {
          next.bank = { beneficiary: beneficiary.trim(), iban: iban.replace(/\s+/g, '').toUpperCase(), bic: bic.toUpperCase() };
        }
      }
    }
    if (next.maxPerUser < next.maxPerOrder) v.custom('maxPerUser', 'Doit être ≥ au plafond par commande');
    const currentPassword = v.str('currentPassword', { optional: true, min: 1, max: 128 });
    if (v.has('bank') && currentPassword === undefined) v.custom('currentPassword', 'Mot de passe requis pour modifier les coordonnées bancaires');
    v.done();
    if (v.has('bank') && currentPassword !== actor.password) fail(401, 'INVALID_CREDENTIALS', 'Identifiants invalides');
    mock.db.settings.set(orgId, next);
    audit(orgId, actor, 'settings.update', 'organization', { ibanMasked: maskIban(next.bank.iban) });
    return json(toSettings(next));
  }),

  route('get', '/orgs/:orgId/members', ({ request, params }) => {
    const orgId = param(params, 'orgId');
    requireOrgRole(request, orgId, 'MANAGER');
    return json({ items: mock.db.memberships.filter((m) => m.orgId === orgId).map(toMember) });
  }),

  route('post', '/orgs/:orgId/members', async ({ request, params }) => {
    const orgId = param(params, 'orgId');
    const actor = requireOrgRole(request, orgId, 'OWNER');
    const v = await readBody(request, ['email', 'role']);
    const email = v.email('email');
    const role = v.oneOf('role', ORG_ROLES);
    v.done();
    const user = mock.db.users.find((u) => u.email === email?.trim().toLowerCase() && u.emailVerified);
    if (!user || !role) return notFound();
    if (mock.db.memberships.some((m) => m.orgId === orgId && m.userId === user.id)) fail(409, 'CONFLICT', 'Déjà membre');
    const m = { userId: user.id, orgId, role, createdAt: new Date().toISOString() };
    mock.db.memberships.push(m);
    audit(orgId, actor, 'member.add', `user:${user.id}`, { role });
    return json(toMember(m), 201);
  }),

  route('patch', '/orgs/:orgId/members/:userId', async ({ request, params }) => {
    const orgId = param(params, 'orgId');
    const actor = requireOrgRole(request, orgId, 'OWNER');
    const m = mock.db.memberships.find((x) => x.orgId === orgId && x.userId === param(params, 'userId')) ?? notFound();
    const v = await readBody(request, ['role']);
    const role = v.oneOf('role', ORG_ROLES);
    v.done();
    const owners = mock.db.memberships.filter((x) => x.orgId === orgId && x.role === 'OWNER').length;
    if (m.role === 'OWNER' && role !== 'OWNER' && owners <= 1) fail(409, 'CONFLICT', 'Dernier propriétaire');
    if (role) m.role = role;
    audit(orgId, actor, 'member.role', `user:${m.userId}`, { role });
    return json(toMember(m));
  }),

  route('delete', '/orgs/:orgId/members/:userId', ({ request, params }) => {
    const orgId = param(params, 'orgId');
    const actor = requireOrgRole(request, orgId, 'OWNER');
    const m = mock.db.memberships.find((x) => x.orgId === orgId && x.userId === param(params, 'userId')) ?? notFound();
    const owners = mock.db.memberships.filter((x) => x.orgId === orgId && x.role === 'OWNER').length;
    if (m.role === 'OWNER' && owners <= 1) fail(409, 'CONFLICT', 'Dernier propriétaire');
    mock.db.memberships = mock.db.memberships.filter((x) => x !== m);
    audit(orgId, actor, 'member.remove', `user:${m.userId}`);
    return noContent();
  }),

  route('get', '/orgs/:orgId/audit-log', ({ request, params, url }) => {
    const orgId = param(params, 'orgId');
    requireOrgRole(request, orgId, 'OWNER');
    const q = readQuery(url, []);
    const items = mock.db.audit.filter((a) => a.orgId === orgId).map((a) => ({ id: a.id, actorEmail: a.actorEmail, action: a.action, target: a.target, meta: a.meta, createdAt: a.createdAt }));
    return json(paginate(items, q.page, q.pageSize));
  }),

  // ---------------- Événements ----------------
  route('get', '/orgs/:orgId/events', ({ request, params, url }) => {
    const orgId = param(params, 'orgId');
    requireOrgRole(request, orgId, 'MANAGER');
    const q = readQuery(url, ['status']);
    const status = q.get('status');
    if (status && !['DRAFT', 'PUBLISHED', 'CANCELLED'].includes(status)) fail(400, 'VALIDATION_ERROR', 'Statut invalide', { fields: [{ path: 'status', message: 'Statut invalide' }] });
    const list = mock.db.events
      .filter((e) => e.orgId === orgId && (!status || e.status === status))
      .sort((a, b) => a.startsAt.localeCompare(b.startsAt))
      .map(toEventAdmin);
    return json(paginate(list, q.page, q.pageSize));
  }),

  route('post', '/orgs/:orgId/events', async ({ request, params }) => {
    const orgId = param(params, 'orgId');
    const actor = requireOrgRole(request, orgId, 'MANAGER');
    const v = await readBody(request, EVENT_FIELDS);
    const d = validateEventBody(v, false);
    if (d.startsAt && d.endsAt && d.endsAt <= d.startsAt) v.custom('endsAt', 'Doit être après le début');
    if (d.salesEndAt && d.endsAt && d.salesEndAt > d.endsAt) v.custom('salesEndAt', 'Doit être avant la fin de l’événement');
    if (d.salesStartAt && d.salesEndAt && d.salesEndAt <= d.salesStartAt) v.custom('salesEndAt', 'Doit être après l’ouverture des ventes');
    v.done();
    const now = new Date().toISOString();
    const e: MockEvent = {
      id: crypto.randomUUID(),
      orgId,
      title: d.title ?? '',
      description: d.description ?? null,
      venue: d.venue ?? null,
      address: d.address ?? null,
      isOnline: d.isOnline ?? false,
      startsAt: d.startsAt ?? now,
      endsAt: d.endsAt ?? now,
      timezone: d.timezone ?? 'Europe/Paris',
      status: 'DRAFT',
      salesStartAt: d.salesStartAt ?? now,
      salesEndAt: d.salesEndAt ?? now,
      overrides: { ...NO_OVERRIDES, ...(d.overrides as Partial<typeof NO_OVERRIDES> | undefined) },
      offlineCheckinEnabled: false,
      createdAt: now,
      updatedAt: now,
    };
    mock.db.events.push(e);
    audit(orgId, actor, 'event.create', `event:${e.id}`);
    return json(toEventAdmin(e), 201);
  }),

  route('get', '/orgs/:orgId/events/:eventId', ({ request, params }) => {
    const orgId = param(params, 'orgId');
    requireOrgRole(request, orgId, 'MANAGER');
    expireDueOrders();
    return json(toEventAdmin(orgEvent(orgId, param(params, 'eventId'))));
  }),

  route('patch', '/orgs/:orgId/events/:eventId', async ({ request, params }) => {
    const orgId = param(params, 'orgId');
    const actor = requireOrgRole(request, orgId, 'MANAGER');
    const e = orgEvent(orgId, param(params, 'eventId'));
    const v = await readBody(request, [...EVENT_FIELDS, 'rescheduleReason', 'offlineCheckinEnabled']);
    const offline = v.bool('offlineCheckinEnabled', { optional: true });
    const d = validateEventBody(v, true);
    const rescheduleReason = v.str('rescheduleReason', { optional: true, min: 1, max: 500 });
    const merged = { ...e, ...Object.fromEntries(Object.entries(d).filter(([k, val]) => val !== undefined && k !== 'overrides')) };
    const datesChanged = merged.startsAt !== e.startsAt || merged.endsAt !== e.endsAt;
    const hasOrders = mock.db.orders.some((o) => o.eventId === e.id && ['PENDING_PAYMENT', 'AWAITING_TRANSFER', 'PAID'].includes(o.status));
    const isReschedule = datesChanged && hasOrders;
    if (isReschedule && !rescheduleReason) v.custom('rescheduleReason', 'Motif du report obligatoire');
    if (merged.endsAt <= merged.startsAt) v.custom('endsAt', 'Doit être après le début');
    if (merged.salesEndAt > merged.endsAt) v.custom('salesEndAt', 'Doit être avant la fin de l’événement');
    v.done();
    if (e.status === 'CANCELLED') fail(409, 'CONFLICT', 'Événement annulé');
    const role = mock.db.memberships.find((m) => m.orgId === orgId && m.userId === actor.id)?.role;
    if (typeof offline === 'boolean' && role !== 'OWNER') fail(403, 'FORBIDDEN', 'Mode secours réservé au propriétaire');
    if (typeof offline === 'boolean' && offline !== e.offlineCheckinEnabled) {
      e.offlineCheckinEnabled = offline;
      audit(orgId, actor, offline ? 'event.offlineCheckin.enable' : 'event.offlineCheckin.disable', `event:${e.id}`);
    }
    merged.offlineCheckinEnabled = e.offlineCheckinEnabled; // la copie fusionnée ne doit pas réécrire l'ancienne valeur
    if (isReschedule && mock.db.memberships.find((m) => m.orgId === orgId && m.userId === actor.id)?.role !== 'OWNER') fail(403, 'FORBIDDEN', 'Report réservé au propriétaire');
    if (isReschedule) {
      for (const o of mock.db.orders.filter((x) => x.eventId === e.id && x.status === 'PAID')) {
        o.refundPercent = 100;
        o.serviceFeeRefundable = true;
      }
      audit(orgId, actor, 'event.reschedule', `event:${e.id}`, { reason: rescheduleReason });
    }
    Object.assign(e, merged, { overrides: { ...e.overrides, ...(d.overrides as object | undefined) }, updatedAt: new Date().toISOString() });
    audit(orgId, actor, 'event.update', `event:${e.id}`);
    return json(toEventAdmin(e));
  }),

  route('post', '/orgs/:orgId/events/:eventId/publish', ({ request, params }) => {
    const orgId = param(params, 'orgId');
    const actor = requireOrgRole(request, orgId, 'MANAGER');
    const e = orgEvent(orgId, param(params, 'eventId'));
    if (e.status === 'CANCELLED') fail(409, 'INVALID_STATE', 'Événement annulé');
    if (typesOf(e.id).length === 0) fail(409, 'CONFLICT', 'Aucun type de place');
    if (Date.parse(e.salesEndAt) <= Date.now()) fail(409, 'CONFLICT', 'Fin des ventes passée');
    e.status = 'PUBLISHED';
    e.updatedAt = new Date().toISOString();
    audit(orgId, actor, 'event.publish', `event:${e.id}`);
    return json(toEventAdmin(e));
  }),

  route('post', '/orgs/:orgId/events/:eventId/cancel', async ({ request, params }) => {
    const orgId = param(params, 'orgId');
    const actor = requireOrgRole(request, orgId, 'OWNER');
    const e = orgEvent(orgId, param(params, 'eventId'));
    const v = await readBody(request, ['reason']);
    const reason = v.str('reason', { min: 1, max: 500 });
    v.done();
    if (e.status === 'CANCELLED') return json(toEventAdmin(e)); // idempotent (v1.14)
    if (Date.parse(e.startsAt) <= Date.now()) fail(409, 'CONFLICT', 'Événement déjà commencé');
    e.status = 'CANCELLED';
    // v1.14 : traitement des commandes en arrière-plan, par lots.
    e.cancellationPending = mock.db.orders.filter((x) => x.eventId === e.id && ['PAID', 'PENDING_PAYMENT', 'AWAITING_TRANSFER'].includes(x.status)).map((o) => o.id);
    const step = () => {
      const batch = (e.cancellationPending ?? []).splice(0, CANCEL_BATCH);
      for (const id of batch) {
        const o = mock.db.orders.find((x) => x.id === id);
        if (!o) continue;
        if (o.status === 'PAID') {
          o.refundPercent = 100;
          o.serviceFeeRefundable = true;
        }
        if (['PAID', 'PENDING_PAYMENT', 'AWAITING_TRANSFER'].includes(o.status)) cancelOrder(o, 'EVENT_CANCELLED');
      }
      if ((e.cancellationPending ?? []).length > 0) setTimeout(step, control.cancelBatchDelayMs);
    };
    setTimeout(step, control.cancelBatchDelayMs);
    audit(orgId, actor, 'event.cancel', `event:${e.id}`, { reason });
    return json(toEventAdmin(e));
  }),

  // ---------------- Types de places ----------------
  route('post', '/orgs/:orgId/events/:eventId/ticket-types', async ({ request, params }) => {
    const orgId = param(params, 'orgId');
    const actor = requireOrgRole(request, orgId, 'MANAGER');
    const e = orgEvent(orgId, param(params, 'eventId'));
    const v = await readBody(request, ['name', 'description', 'capacity', 'priceCents', 'earlyPriceCents', 'earlyUntil', 'sortOrder']);
    const d = validateTicketType(v, false);
    checkEarly(v, d.priceCents ?? 0, d.earlyPriceCents ?? null, d.earlyUntil ?? null, e.salesEndAt);
    v.done();
    const tt = {
      id: crypto.randomUUID(),
      eventId: e.id,
      name: d.name ?? '',
      description: d.description ?? null,
      capacity: d.capacity ?? 1,
      sold: 0,
      held: 0,
      priceCents: d.priceCents ?? 0,
      earlyPriceCents: d.earlyPriceCents ?? null,
      earlyUntil: d.earlyUntil ?? null,
      sortOrder: d.sortOrder ?? typesOf(e.id).length,
    };
    mock.db.ticketTypes.push(tt);
    audit(orgId, actor, 'ticketType.create', `ticketType:${tt.id}`);
    return json(toTicketTypeAdmin(tt), 201);
  }),

  route('patch', '/orgs/:orgId/events/:eventId/ticket-types/:ticketTypeId', async ({ request, params }) => {
    const orgId = param(params, 'orgId');
    const actor = requireOrgRole(request, orgId, 'MANAGER');
    const e = orgEvent(orgId, param(params, 'eventId'));
    const tt = mock.db.ticketTypes.find((t) => t.id === param(params, 'ticketTypeId') && t.eventId === e.id) ?? notFound();
    const v = await readBody(request, ['name', 'description', 'capacity', 'priceCents', 'earlyPriceCents', 'earlyUntil', 'sortOrder']);
    const d = validateTicketType(v, true);
    const next = { ...tt, ...Object.fromEntries(Object.entries(d).filter(([, val]) => val !== undefined)) };
    checkEarly(v, next.priceCents, next.earlyPriceCents, next.earlyUntil, e.salesEndAt);
    v.done();
    if (next.capacity < tt.sold + tt.held) fail(409, 'CONFLICT', 'Capacité inférieure aux places vendues ou réservées');
    Object.assign(tt, next);
    audit(orgId, actor, 'ticketType.update', `ticketType:${tt.id}`);
    return json(toTicketTypeAdmin(tt));
  }),

  route('delete', '/orgs/:orgId/events/:eventId/ticket-types/:ticketTypeId', ({ request, params }) => {
    const orgId = param(params, 'orgId');
    const actor = requireOrgRole(request, orgId, 'MANAGER');
    const e = orgEvent(orgId, param(params, 'eventId'));
    const tt = mock.db.ticketTypes.find((t) => t.id === param(params, 'ticketTypeId') && t.eventId === e.id) ?? notFound();
    if (mock.db.orders.some((o) => o.items.some((i) => i.ticketTypeId === tt.id))) fail(409, 'CONFLICT', 'Déjà des commandes');
    mock.db.ticketTypes = mock.db.ticketTypes.filter((t) => t !== tt);
    audit(orgId, actor, 'ticketType.delete', `ticketType:${tt.id}`);
    return noContent();
  }),

  // ---------------- Commandes, virements, stats, export ----------------
  route('get', '/orgs/:orgId/events/:eventId/orders', ({ request, params, url }) => {
    const orgId = param(params, 'orgId');
    requireOrgRole(request, orgId, 'MANAGER');
    expireDueOrders();
    const e = orgEvent(orgId, param(params, 'eventId'));
    const query = readQuery(url, ['status', 'q']);
    const status = query.get('status');
    const q = query.get('q')?.toLowerCase();
    if (status && !(ORDER_STATUSES as readonly string[]).includes(status)) fail(400, 'VALIDATION_ERROR', 'Statut invalide', { fields: [{ path: 'status', message: 'Statut invalide' }] });
    if (q && q.length > 100) fail(400, 'VALIDATION_ERROR', 'Recherche trop longue', { fields: [{ path: 'q', message: '100 caractères max' }] });
    const list = mock.db.orders
      .filter((o) => o.eventId === e.id && (!status || o.status === status))
      .map(toOrderAdmin)
      .filter((o) => !q || o.buyer.email.includes(q))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return json(paginate(list, query.page, query.pageSize));
  }),

  route('post', '/orgs/:orgId/orders/:orderId/confirm-transfer', async ({ request, params }) => {
    const orgId = param(params, 'orgId');
    const actor = requireOrgRole(request, orgId, 'MANAGER');
    expireDueOrders();
    const o = mock.db.orders.find((x) => x.id === param(params, 'orderId') && mock.db.events.find((e) => e.id === x.eventId)?.orgId === orgId) ?? notFound();
    const v = await readBody(request, ['receivedAmountCents']);
    const received = v.int('receivedAmountCents', { min: 0, max: 100_000_000 });
    v.done();
    if (o.status === 'EXPIRED') fail(409, 'ORDER_EXPIRED', 'Réservation expirée');
    if (o.status !== 'AWAITING_TRANSFER') fail(409, 'INVALID_STATE', 'Pas en attente de virement');
    if (received !== o.totalCents) fail(422, 'AMOUNT_MISMATCH', 'Montant différent', { expected: o.totalCents, received });
    await markPaid(o);
    audit(orgId, actor, 'order.confirmTransfer', `order:${o.id}`, { receivedAmountCents: received });
    return json(toOrderAdmin(o));
  }),

  route('get', '/orgs/:orgId/events/:eventId/stats', ({ request, params }) => {
    const orgId = param(params, 'orgId');
    requireOrgRole(request, orgId, 'MANAGER');
    expireDueOrders();
    const e = orgEvent(orgId, param(params, 'eventId'));
    const orders = mock.db.orders.filter((o) => o.eventId === e.id);
    const ticketTypes = typesOf(e.id).map((tt) => {
      const lines = orders.flatMap((o) => o.items.filter((i) => i.ticketTypeId === tt.id).map((i) => ({ o, i })));
      const paid = lines.filter(({ o }) => o.status === 'PAID' || o.status === 'REFUNDED').reduce((s, { i }) => s + i.unitPriceCents * i.quantity, 0);
      const refunded = lines.filter(({ o }) => o.status === 'REFUNDED').reduce((s, { o, i }) => s + Math.floor((i.unitPriceCents * i.quantity * o.refundPercent) / 100), 0);
      return {
        ticketTypeId: tt.id,
        name: tt.name,
        capacity: tt.capacity,
        sold: tt.sold,
        held: tt.held,
        remaining: remaining(tt),
        checkedIn: mock.db.tickets.filter((t) => t.ticketTypeId === tt.id && t.status === 'USED').length,
        revenueCents: paid - refunded,
        refundedCents: refunded,
      };
    });
    const sum = (k: 'capacity' | 'sold' | 'held' | 'remaining' | 'checkedIn' | 'revenueCents' | 'refundedCents') => ticketTypes.reduce((s, t) => s + t[k], 0);
    const ordersByStatus = Object.fromEntries(ORDER_STATUSES.map((s) => [s, orders.filter((o) => o.status === s).length])) as Record<OrderStatus, number>;
    return json({
      eventId: e.id,
      generatedAt: new Date().toISOString(),
      currency: 'EUR',
      ticketTypes,
      totals: {
        capacity: sum('capacity'),
        sold: sum('sold'),
        held: sum('held'),
        remaining: sum('remaining'),
        checkedIn: sum('checkedIn'),
        revenueCents: sum('revenueCents'),
        refundedCents: sum('refundedCents'),
        serviceFeeCents: orders.filter((o) => o.status === 'PAID').reduce((s, o) => s + o.serviceFeeCents, 0),
        refundsToProcess: mock.db.refunds.filter((r) => r.eventId === e.id && (r.status === 'MANUAL_REQUIRED' || r.status === 'FAILED')).length,
      },
      ordersByStatus,
      waitlistWaiting: mock.db.waitlist.filter((w) => w.eventId === e.id && w.status === 'WAITING').length,
    });
  }),

  route('get', '/orgs/:orgId/events/:eventId/attendees.csv', ({ request, params }) => {
    const orgId = param(params, 'orgId');
    const actor = requireOrgRole(request, orgId, 'MANAGER');
    const e = orgEvent(orgId, param(params, 'eventId'));
    const rows = mock.db.tickets
      .filter((t) => t.eventId === e.id)
      .map((t) => {
        const o = mock.db.orders.find((x) => x.id === t.orderId);
        const u = o && mock.db.users.find((x) => x.id === o.userId);
        const tt = mock.db.ticketTypes.find((x) => x.id === t.ticketTypeId);
        return [t.publicId, tt?.name ?? '', u?.displayName ?? '', u?.email ?? '', t.status, t.usedAt ?? ''].map(csvCell).join(';');
      });
    audit(orgId, actor, 'export.attendees', `event:${e.id}`);
    const body = `\uFEFFbillet;type;nom;email;statut;scanne_le\r\n${rows.join('\r\n')}`;
    return new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="participants-${e.id}.csv"` },
    });
  }),

  // ---------------- Remboursements (v1.10) ----------------
  route('get', '/orgs/:orgId/refunds', ({ request, params, url }) => {
    const orgId = param(params, 'orgId');
    requireOrgRole(request, orgId, 'MANAGER');
    const q = readQuery(url, ['status', 'eventId']);
    const status = q.get('status');
    const eventId = q.get('eventId');
    if (status && !['PENDING', 'SUCCEEDED', 'MANUAL_REQUIRED', 'FAILED'].includes(status)) fail(400, 'VALIDATION_ERROR', 'Statut invalide', { fields: [{ path: 'status', message: 'Statut invalide' }] });
    const list = mock.db.refunds
      .filter((r) => r.orgId === orgId && (!status || r.status === status) && (!eventId || r.eventId === eventId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(toRefund);
    return json(paginate(list, q.page, q.pageSize));
  }),

  route('post', '/orgs/:orgId/refunds/:refundId/mark-done', async ({ request, params }) => {
    const orgId = param(params, 'orgId');
    const actor = requireOrgRole(request, orgId, 'MANAGER');
    const r = mock.db.refunds.find((x) => x.id === param(params, 'refundId') && x.orgId === orgId) ?? notFound();
    const v = await readBody(request, ['note']);
    const note = v.str('note', { min: 1, max: 500 });
    v.done();
    if (r.status !== 'MANUAL_REQUIRED' && r.status !== 'FAILED') fail(409, 'INVALID_STATE', 'Remboursement déjà traité');
    r.status = 'SUCCEEDED';
    r.note = note ?? null;
    r.updatedAt = new Date().toISOString();
    audit(orgId, actor, 'refund.markDone', `refund:${r.id}`, { amountCents: r.amountCents });
    return json(toRefund(r));
  }),

  // ---------------- Contrôle d'accès ----------------

  route('get', '/orgs/:orgId/checkin/events', ({ request, params }) => {
    const orgId = param(params, 'orgId');
    requireOrgRole(request, orgId, 'SCANNER');
    const limit = Date.now() - 24 * 3_600_000;
    const items = mock.db.events
      .filter((e) => e.orgId === orgId && e.status === 'PUBLISHED' && Date.parse(e.endsAt) > limit)
      .sort((a, b) => a.startsAt.localeCompare(b.startsAt))
      .map((e) => ({ id: e.id, title: e.title, venue: e.venue, isOnline: e.isOnline, startsAt: e.startsAt, endsAt: e.endsAt, timezone: e.timezone, status: e.status, offlineCheckinEnabled: e.offlineCheckinEnabled }));
    return json({ items });
  }),

  route('get', '/orgs/:orgId/events/:eventId/checkin/snapshot', async ({ request, params }) => {
    const orgId = param(params, 'orgId');
    requireOrgRole(request, orgId, 'SCANNER');
    const e = orgEvent(orgId, param(params, 'eventId'));
    if (!checkinOpen(e)) return notFound();
    if (!e.offlineCheckinEnabled) return fail(409, 'OFFLINE_CHECKIN_DISABLED', 'Mode secours hors-ligne désactivé');
    return json({
      eventId: e.id,
      generatedAt: new Date().toISOString(),
      publicKeyJwk: await mockPublicKeyJwk(),
      tickets: mock.db.tickets
        .filter((t) => t.eventId === e.id)
        .map((t) => {
          const h = holderOf(t.publicId);
          return { publicId: t.publicId, ticketTypeName: h?.ticketTypeName ?? '', holderInitials: h?.holderInitials ?? '', status: t.status, usedAt: t.usedAt };
        }),
    });
  }),

  route('post', '/orgs/:orgId/events/:eventId/checkin/scan', async ({ request, params }) => {
    const orgId = param(params, 'orgId');
    requireOrgRole(request, orgId, 'SCANNER');
    const e = orgEvent(orgId, param(params, 'eventId'));
    const v = await readBody(request, ['qrPayload', 'deviceId', 'scanId']);
    const qrPayload = v.str('qrPayload', { min: 1, max: 256 });
    v.uuid('deviceId');
    const scanId = v.uuid('scanId');
    v.done();
    const previous = mock.db.checkins.find((c) => c.scanId === scanId);
    if (previous) {
      return json({ result: previous.result, ticket: previous.publicId ? holderOf(previous.publicId) : null, usedAt: previous.usedAt });
    }
    if (e.status === 'CANCELLED') return json({ result: 'CANCELLED', ticket: null, usedAt: null });
    if (!checkinOpen(e)) return notFound();
    const { result, publicId } = await scanOne(e.id, qrPayload ?? '');
    const ticket = publicId ? mock.db.tickets.find((t) => t.publicId === publicId) : undefined;
    const usedAt = result === 'OK' || result === 'ALREADY_USED' ? (ticket?.usedAt ?? null) : null;
    mock.db.checkins.push({ scanId: scanId ?? '', publicId, result, usedAt });
    return json({ result, ticket: publicId && result !== 'WRONG_EVENT' ? holderOf(publicId) : null, usedAt });
  }),

  route('post', '/orgs/:orgId/events/:eventId/checkin/sync', async ({ request, params }) => {
    const orgId = param(params, 'orgId');
    requireOrgRole(request, orgId, 'SCANNER');
    const e = orgEvent(orgId, param(params, 'eventId'));
    const v = await readBody(request, ['deviceId', 'scans']);
    v.uuid('deviceId');
    const scans = v.body.scans;
    if (!Array.isArray(scans) || scans.length < 1 || scans.length > 500) v.custom('scans', 'Entre 1 et 500 scans');
    v.done();
    if (e.status !== 'CANCELLED' && !checkinOpen(e)) return notFound();
    const list = (scans as { scanId: string; qrPayload: string; scannedAt: string }[]).slice().sort((a, b) => a.scannedAt.localeCompare(b.scannedAt));
    if (new Set(list.map((s) => s.scanId)).size !== list.length) fail(400, 'VALIDATION_ERROR', 'scanId en double', { fields: [{ path: 'scans', message: 'scanId uniques' }] });
    const results: { scanId: string; result: SyncResult; usedAt: string | null }[] = [];
    for (const s of list) {
      const previous = mock.db.checkins.find((c) => c.scanId === s.scanId);
      if (previous) {
        results.push({ scanId: s.scanId, result: previous.result === 'OK' ? 'ACCEPTED' : (previous.result as SyncResult), usedAt: previous.usedAt });
        continue;
      }
      const { result, publicId } = e.status === 'CANCELLED' ? { result: 'CANCELLED' as const, publicId: null } : await scanOne(e.id, s.qrPayload);
      const ticket = publicId ? mock.db.tickets.find((t) => t.publicId === publicId) : undefined;
      if (result === 'OK' && ticket) ticket.usedAt = s.scannedAt;
      const usedAt = result === 'OK' || result === 'ALREADY_USED' ? (ticket?.usedAt ?? null) : null;
      mock.db.checkins.push({ scanId: s.scanId, publicId, result, usedAt });
      results.push({ scanId: s.scanId, result: result === 'OK' ? 'ACCEPTED' : result, usedAt });
    }
    return json({ results });
  }),
];
