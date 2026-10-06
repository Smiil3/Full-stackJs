/**
 * Faux serveur en mémoire pour MSW (dev:mock + tests). Reproduit les RÈGLES du contrat
 * (prix serveur, plafonds, statuts, rôles, 404 inter-collectifs) pour que le front soit testé
 * contre un comportement réaliste. Ce code n'est jamais inclus dans le build de production.
 */
import type {
  AuditLogEntry,
  EventOverrides,
  EventRulesPublic,
  EventStatus,
  OrderStatus,
  OrgRole,
  OrgSettings,
  PaymentMethod,
  TicketStatus,
  WaitlistStatus,
} from '../api/types';

export type MockUser = {
  id: string;
  email: string;
  password: string;
  displayName: string;
  emailVerified: boolean;
  isPlatformAdmin: boolean;
};
export type MockOrg = { id: string; name: string; slug: string; createdAt: string };
export type MockMembership = { userId: string; orgId: string; role: OrgRole; createdAt: string };
export type MockSettings = Omit<OrgSettings, 'bank'> & { bank: { beneficiary: string | null; iban: string | null; bic: string | null } };
export type MockTicketType = {
  id: string;
  eventId: string;
  name: string;
  description: string | null;
  capacity: number;
  sold: number;
  held: number;
  priceCents: number;
  earlyPriceCents: number | null;
  earlyUntil: string | null;
  sortOrder: number;
};
export type MockEvent = {
  id: string;
  orgId: string;
  title: string;
  description: string | null;
  venue: string | null;
  address: string | null;
  isOnline: boolean;
  startsAt: string;
  endsAt: string;
  timezone: string;
  status: EventStatus;
  salesStartAt: string;
  salesEndAt: string;
  overrides: EventOverrides;
  offlineCheckinEnabled: boolean;
  /** Annulation asynchrone (v1.14) : commandes restant à traiter. */
  cancellationPending?: string[];
  createdAt: string;
  updatedAt: string;
};
export type MockOrder = {
  id: string;
  userId: string;
  eventId: string;
  status: OrderStatus;
  paymentMethod: PaymentMethod;
  items: { ticketTypeId: string; name: string; quantity: number; unitPriceCents: number }[];
  subtotalCents: number;
  serviceFeeCents: number;
  totalCents: number;
  expiresAt: string | null;
  paidAt: string | null;
  cancellableUntil: string | null;
  refundPercent: number;
  serviceFeeRefundable: boolean;
  refundAmountCents: number | null;
  createdAt: string;
  transferReference: string | null;
  idempotencyKey: string;
  bodyFingerprint: string;
};
export type MockTicket = {
  id: string;
  orderId: string;
  eventId: string;
  ticketTypeId: string;
  publicId: string;
  qrPayload: string;
  status: TicketStatus;
  usedAt: string | null;
};
export type MockWaitlist = {
  id: string;
  userId: string;
  eventId: string;
  ticketTypeId: string;
  quantity: number;
  status: WaitlistStatus;
  offerExpiresAt: string | null;
  createdAt: string;
};
export type MockRefund = {
  id: string;
  orgId: string;
  orderId: string;
  eventId: string;
  amountCents: number;
  reason: 'SELF_CANCELLATION' | 'EVENT_CANCELLED' | 'LATE_PAYMENT' | 'DUPLICATE_PAYMENT' | 'UNEXPECTED_PAYMENT';
  method: PaymentMethod;
  status: 'PENDING' | 'SUCCEEDED' | 'MANUAL_REQUIRED' | 'FAILED';
  note: string | null;
  createdAt: string;
  updatedAt: string;
};
export type MockCheckIn = { scanId: string; publicId: string | null; result: string; usedAt: string | null };

export type MockDb = {
  users: MockUser[];
  orgs: MockOrg[];
  memberships: MockMembership[];
  settings: Map<string, MockSettings>;
  events: MockEvent[];
  ticketTypes: MockTicketType[];
  orders: MockOrder[];
  tickets: MockTicket[];
  waitlist: MockWaitlist[];
  audit: (AuditLogEntry & { orgId: string })[];
  checkins: MockCheckIn[];
  refunds: MockRefund[];
  /** access token → session */
  accessTokens: Map<string, { userId: string; expiresAt: number }>;
  /** Simule le cookie HttpOnly `nuits_rt` (le navigateur ne le voit pas, le front non plus). */
  refreshCookie: { token: string; userId: string } | null;
  /** Anciens refresh tokens déjà utilisés (détection de réutilisation). */
  usedRefreshTokens: Set<string>;
  verifyTokens: Map<string, string>;
  resetTokens: Map<string, string>;
  /** Durée de vie des access tokens (secondes) — réduite dans certains tests. */
  accessTtlSeconds: number;
  /** Compteurs d'appels, utiles aux tests (ex. nombre de POST /auth/refresh). */
  calls: Map<string, number>;
};

export const DEFAULT_SETTINGS: Omit<MockSettings, 'bank' | 'contactEmail'> = {
  cardHoldMinutes: 15,
  transferHoldHours: 72,
  transferEnabled: true,
  cancellationDeadlineHours: 48,
  selfCancellationEnabled: true,
  refundPercent: 100,
  serviceFeeRefundable: false,
  maxPerOrder: 6,
  maxPerUser: 6,
  waitlistOfferMinutes: 120,
  waitlistEnabled: true,
  serviceFeeFixedCents: 0,
  serviceFeeBasisPoints: 0,
  defaultTimezone: 'Europe/Paris',
};

export const NO_OVERRIDES: EventOverrides = {
  cardHoldMinutes: null,
  transferHoldHours: null,
  transferEnabled: null,
  cancellationDeadlineHours: null,
  selfCancellationEnabled: null,
  refundPercent: null,
  maxPerOrder: null,
  maxPerUser: null,
  waitlistOfferMinutes: null,
  waitlistEnabled: null,
  serviceFeeFixedCents: null,
  serviceFeeBasisPoints: null,
};

/** Identifiants de démonstration (mock uniquement), documentés dans le README. */
export const DEMO_PASSWORD = 'demo-nuits-2026';
export const IDS = {
  orgNuits: '11111111-1111-4111-8111-111111111111',
  orgPartner: '22222222-2222-4222-8222-222222222222',
  userBuyer: 'aaaaaaaa-0000-4000-8000-000000000001',
  userOwner: 'aaaaaaaa-0000-4000-8000-000000000002',
  userManager: 'aaaaaaaa-0000-4000-8000-000000000003',
  userScanner: 'aaaaaaaa-0000-4000-8000-000000000004',
  userAdmin: 'aaaaaaaa-0000-4000-8000-000000000005',
  userUnverified: 'aaaaaaaa-0000-4000-8000-000000000006',
  userPartnerOwner: 'aaaaaaaa-0000-4000-8000-000000000007',
  eventConcert: 'eeeeeeee-0000-4000-8000-000000000001',
  eventSoldOut: 'eeeeeeee-0000-4000-8000-000000000002',
  eventOnline: 'eeeeeeee-0000-4000-8000-000000000003',
  eventDraft: 'eeeeeeee-0000-4000-8000-000000000004',
  eventPartner: 'eeeeeeee-0000-4000-8000-000000000005',
  ttFosse: 'bbbbbbbb-0000-4000-8000-000000000001',
  ttBalcon: 'bbbbbbbb-0000-4000-8000-000000000002',
  ttSoldOut: 'bbbbbbbb-0000-4000-8000-000000000003',
  ttOnline: 'bbbbbbbb-0000-4000-8000-000000000004',
  ttDraft: 'bbbbbbbb-0000-4000-8000-000000000005',
  ttPartner: 'bbbbbbbb-0000-4000-8000-000000000006',
} as const;

const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

export function createSeed(now: number = Date.now()): MockDb {
  const created = iso(now - 30 * DAY);
  const users: MockUser[] = [
    { id: IDS.userBuyer, email: 'acheteur@example.test', password: DEMO_PASSWORD, displayName: 'Jeanne Dupont', emailVerified: true, isPlatformAdmin: false },
    { id: IDS.userOwner, email: 'owner@nuits.test', password: DEMO_PASSWORD, displayName: 'Olivia Owner', emailVerified: true, isPlatformAdmin: false },
    { id: IDS.userManager, email: 'manager@nuits.test', password: DEMO_PASSWORD, displayName: 'Marc Manager', emailVerified: true, isPlatformAdmin: false },
    { id: IDS.userScanner, email: 'scanner@nuits.test', password: DEMO_PASSWORD, displayName: 'Sami Scanner', emailVerified: true, isPlatformAdmin: false },
    { id: IDS.userAdmin, email: 'admin@plateforme.test', password: DEMO_PASSWORD, displayName: 'Alex Admin', emailVerified: true, isPlatformAdmin: true },
    { id: IDS.userUnverified, email: 'nonverifie@example.test', password: DEMO_PASSWORD, displayName: 'Noé Nonvérifié', emailVerified: false, isPlatformAdmin: false },
    { id: IDS.userPartnerOwner, email: 'owner@partenaire.test', password: DEMO_PASSWORD, displayName: 'Paula Partenaire', emailVerified: true, isPlatformAdmin: false },
  ];
  const orgs: MockOrg[] = [
    { id: IDS.orgNuits, name: 'Les Nuits de la Garonne', slug: 'nuits-garonne', createdAt: created },
    { id: IDS.orgPartner, name: 'Collectif Rive Droite', slug: 'rive-droite', createdAt: created },
  ];
  const memberships: MockMembership[] = [
    { userId: IDS.userOwner, orgId: IDS.orgNuits, role: 'OWNER', createdAt: created },
    { userId: IDS.userManager, orgId: IDS.orgNuits, role: 'MANAGER', createdAt: created },
    { userId: IDS.userScanner, orgId: IDS.orgNuits, role: 'SCANNER', createdAt: created },
    { userId: IDS.userPartnerOwner, orgId: IDS.orgPartner, role: 'OWNER', createdAt: created },
    { userId: IDS.userOwner, orgId: IDS.orgPartner, role: 'MANAGER', createdAt: created },
  ];
  const settings = new Map<string, MockSettings>([
    [
      IDS.orgNuits,
      {
        ...DEFAULT_SETTINGS,
        serviceFeeFixedCents: 50,
        serviceFeeBasisPoints: 250,
        contactEmail: 'contact@nuits.test',
        bank: { beneficiary: 'Les Nuits de la Garonne', iban: 'FR7630006000011234567890189', bic: 'AGRIFRPPXXX' },
      },
    ],
    [IDS.orgPartner, { ...DEFAULT_SETTINGS, contactEmail: null, bank: { beneficiary: null, iban: null, bic: null } }],
  ]);

  const ev = (e: Omit<MockEvent, 'createdAt' | 'updatedAt' | 'overrides' | 'offlineCheckinEnabled'> & { overrides?: Partial<EventOverrides>; offlineCheckinEnabled?: boolean }): MockEvent => ({
    offlineCheckinEnabled: false,
    ...e,
    overrides: { ...NO_OVERRIDES, ...e.overrides },
    createdAt: created,
    updatedAt: created,
  });
  // 14 nov. 2026 20:00 heure de Paris (UTC+1) = 19:00Z — gardé fixe pour des captures stables.
  const concertStart = Date.parse('2026-11-14T19:00:00.000Z');
  const events: MockEvent[] = [
    ev({
      id: IDS.eventConcert,
      orgId: IDS.orgNuits,
      title: 'Garonne Électrique — soirée d’ouverture',
      description: 'Trois artistes de la scène bordelaise.\nOuverture des portes à 19h30.\n<script>alert(1)</script> doit rester du texte.',
      venue: 'Le Rocher de Palmer',
      address: '1 rue Aristide Briand, 33150 Cenon',
      isOnline: false,
      startsAt: iso(Math.max(concertStart, now + 20 * DAY)),
      endsAt: iso(Math.max(concertStart, now + 20 * DAY) + 5 * 3_600_000),
      timezone: 'Europe/Paris',
      status: 'PUBLISHED',
      salesStartAt: iso(now - 10 * DAY),
      salesEndAt: iso(Math.max(concertStart, now + 20 * DAY)),
      offlineCheckinEnabled: true, // démo du mode secours
    }),
    ev({
      id: IDS.eventSoldOut,
      orgId: IDS.orgNuits,
      title: 'Nuit Électro — Hangar 14',
      description: 'Complet, inscrivez-vous sur la liste d’attente.',
      venue: 'Hangar 14',
      address: 'Quai des Chartrons, 33000 Bordeaux',
      isOnline: false,
      startsAt: iso(now + 35 * DAY),
      endsAt: iso(now + 35 * DAY + 6 * 3_600_000),
      timezone: 'Europe/Paris',
      status: 'PUBLISHED',
      salesStartAt: iso(now - 20 * DAY),
      salesEndAt: iso(now + 35 * DAY),
    }),
    ev({
      id: IDS.eventOnline,
      orgId: IDS.orgNuits,
      title: 'Session acoustique en ligne',
      description: 'Concert diffusé en direct. Lien envoyé par mail.',
      venue: null,
      address: null,
      isOnline: true,
      startsAt: iso(now + 12 * DAY),
      endsAt: iso(now + 12 * DAY + 2 * 3_600_000),
      timezone: 'America/New_York',
      status: 'PUBLISHED',
      salesStartAt: iso(now - 5 * DAY),
      salesEndAt: iso(now + 12 * DAY),
      overrides: { transferEnabled: false, maxPerOrder: 2, maxPerUser: 2 },
    }),
    ev({
      id: IDS.eventDraft,
      orgId: IDS.orgNuits,
      title: 'Brouillon — Fête de fin d’année',
      description: null,
      venue: 'La Belle Saison',
      address: null,
      isOnline: false,
      startsAt: iso(now + 60 * DAY),
      endsAt: iso(now + 60 * DAY + 4 * 3_600_000),
      timezone: 'Europe/Paris',
      status: 'DRAFT',
      salesStartAt: iso(now + 10 * DAY),
      salesEndAt: iso(now + 60 * DAY),
    }),
    ev({
      id: IDS.eventPartner,
      orgId: IDS.orgPartner,
      title: 'Rive Droite Jazz Club',
      description: 'Jazz au bord de l’eau.',
      venue: 'Darwin',
      address: '87 quai des Queyries, 33100 Bordeaux',
      isOnline: false,
      startsAt: iso(now + 25 * DAY),
      endsAt: iso(now + 25 * DAY + 3 * 3_600_000),
      timezone: 'Europe/Paris',
      status: 'PUBLISHED',
      salesStartAt: iso(now - 3 * DAY),
      salesEndAt: iso(now + 25 * DAY),
    }),
  ];
  const ticketTypes: MockTicketType[] = [
    { id: IDS.ttFosse, eventId: IDS.eventConcert, name: 'Fosse', description: 'Debout, accès bar.', capacity: 400, sold: 120, held: 4, priceCents: 2500, earlyPriceCents: 1800, earlyUntil: iso(now + 5 * DAY), sortOrder: 0 },
    { id: IDS.ttBalcon, eventId: IDS.eventConcert, name: 'Balcon', description: 'Places assises numérotées.', capacity: 80, sold: 74, held: 0, priceCents: 3500, earlyPriceCents: null, earlyUntil: null, sortOrder: 1 },
    { id: IDS.ttSoldOut, eventId: IDS.eventSoldOut, name: 'Entrée', description: null, capacity: 200, sold: 198, held: 2, priceCents: 1500, earlyPriceCents: null, earlyUntil: null, sortOrder: 0 },
    { id: IDS.ttOnline, eventId: IDS.eventOnline, name: 'Accès streaming', description: null, capacity: 600, sold: 42, held: 0, priceCents: 800, earlyPriceCents: null, earlyUntil: null, sortOrder: 0 },
    { id: IDS.ttDraft, eventId: IDS.eventDraft, name: 'Standard', description: null, capacity: 150, sold: 0, held: 0, priceCents: 1200, earlyPriceCents: null, earlyUntil: null, sortOrder: 0 },
    { id: IDS.ttPartner, eventId: IDS.eventPartner, name: 'Standard', description: null, capacity: 90, sold: 10, held: 0, priceCents: 2000, earlyPriceCents: null, earlyUntil: null, sortOrder: 0 },
  ];
  const audit: MockDb['audit'] = [
    { id: crypto.randomUUID(), orgId: IDS.orgNuits, actorEmail: 'owner@nuits.test', action: 'settings.update', target: 'organization', meta: { serviceFeeBasisPoints: { before: 0, after: 250 } }, createdAt: iso(now - 2 * DAY) },
    { id: crypto.randomUUID(), orgId: IDS.orgNuits, actorEmail: 'manager@nuits.test', action: 'event.publish', target: `event:${IDS.eventConcert}`, meta: null, createdAt: iso(now - 10 * DAY) },
    { id: crypto.randomUUID(), orgId: IDS.orgNuits, actorEmail: null, action: 'order.expire', target: 'order:—', meta: { count: 3 }, createdAt: iso(now - 11 * DAY) },
    { id: crypto.randomUUID(), orgId: IDS.orgNuits, actorEmail: 'Administrateur plateforme', action: 'org.create', target: 'organization', meta: null, createdAt: iso(now - 30 * DAY) },
  ];

  return {
    users,
    orgs,
    memberships,
    settings,
    events,
    ticketTypes,
    orders: [],
    tickets: [],
    waitlist: [],
    audit,
    checkins: [],
    refunds: [],
    accessTokens: new Map(),
    refreshCookie: null,
    usedRefreshTokens: new Set(),
    verifyTokens: new Map(),
    resetTokens: new Map(),
    accessTtlSeconds: 600,
    calls: new Map(),
  };
}

// ---------------------------------------------------------------------------
// Règles métier calculées « côté serveur »
// ---------------------------------------------------------------------------

export function effectiveRules(db: MockDb, event: MockEvent): EventRulesPublic {
  const s = db.settings.get(event.orgId) ?? { ...DEFAULT_SETTINGS, contactEmail: null, bank: { beneficiary: null, iban: null, bic: null } };
  const o = event.overrides;
  const bankReady = Boolean(s.bank.iban && s.bank.bic && s.bank.beneficiary);
  return {
    maxPerOrder: o.maxPerOrder ?? s.maxPerOrder,
    maxPerUser: o.maxPerUser ?? s.maxPerUser,
    transferEnabled: (o.transferEnabled ?? s.transferEnabled) && bankReady,
    cardHoldMinutes: o.cardHoldMinutes ?? s.cardHoldMinutes,
    transferHoldHours: o.transferHoldHours ?? s.transferHoldHours,
    selfCancellationEnabled: o.selfCancellationEnabled ?? s.selfCancellationEnabled,
    cancellationDeadlineHours: o.cancellationDeadlineHours ?? s.cancellationDeadlineHours,
    refundPercent: o.refundPercent ?? s.refundPercent,
    serviceFeeFixedCents: o.serviceFeeFixedCents ?? s.serviceFeeFixedCents,
    serviceFeeBasisPoints: o.serviceFeeBasisPoints ?? s.serviceFeeBasisPoints,
    waitlistEnabled: o.waitlistEnabled ?? s.waitlistEnabled,
  };
}

export function currentPrice(tt: MockTicketType, now: number = Date.now()): { cents: number; isEarly: boolean } {
  if (tt.earlyPriceCents !== null && tt.earlyUntil && now < Date.parse(tt.earlyUntil)) return { cents: tt.earlyPriceCents, isEarly: true };
  return { cents: tt.priceCents, isEarly: false };
}

export function remaining(tt: MockTicketType): number {
  return Math.max(0, tt.capacity - tt.sold - tt.held);
}

export function availability(tt: MockTicketType): 'AVAILABLE' | 'LOW' | 'SOLD_OUT' {
  const r = remaining(tt);
  if (r <= 0) return 'SOLD_OUT';
  return r <= tt.capacity * 0.1 ? 'LOW' : 'AVAILABLE';
}

export function serviceFee(subtotalCents: number, rules: EventRulesPublic): number {
  return rules.serviceFeeFixedCents + Math.floor((subtotalCents * rules.serviceFeeBasisPoints + 5000) / 10000);
}

export function maskIban(iban: string | null): string | null {
  if (!iban) return null;
  const clean = iban.replace(/\s+/g, '');
  return `${clean.slice(0, 4)} •••• •••• ${clean.slice(-4)}`;
}

export function bump(db: MockDb, key: string): void {
  db.calls.set(key, (db.calls.get(key) ?? 0) + 1);
}
