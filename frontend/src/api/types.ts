// Types alignés à la lettre sur docs/api-contract.md (v1.1).
// Toute évolution du contrat doit être répercutée ici ET dans les handlers MSW (src/mocks).

export type Uuid = string;
/** Date ISO 8601 UTC avec `Z`. */
export type IsoDateTime = string;
/** Fuseau IANA, ex. "Europe/Paris". */
export type IanaTimeZone = string;

export type Page<T> = { items: T[]; page: number; pageSize: number; total: number };
export type ItemsResponse<T> = { items: T[] };
export type PageQuery = { page?: number; pageSize?: number };

// ---------- Erreurs ----------
export const ERROR_CODES = [
  'VALIDATION_ERROR',
  'UNAUTHENTICATED',
  'INVALID_CREDENTIALS',
  'INVALID_REFRESH_TOKEN',
  'FORBIDDEN',
  'EMAIL_NOT_VERIFIED',
  'CSRF_CHECK_FAILED',
  'NOT_FOUND',
  'SOLD_OUT',
  'SALES_CLOSED',
  'ORDER_EXPIRED',
  'INVALID_STATE',
  'IDEMPOTENCY_CONFLICT',
  'ALREADY_IN_WAITLIST',
  'NOT_SOLD_OUT',
  'OFFER_EXPIRED',
  'WAITLIST_DISABLED',
  'OFFLINE_CHECKIN_DISABLED',
  'CANCELLATION_CLOSED',
  'CONFLICT',
  'LIMIT_EXCEEDED',
  'PAYMENT_METHOD_UNAVAILABLE',
  'AMOUNT_MISMATCH',
  'PAYLOAD_TOO_LARGE',
  'UNSUPPORTED_MEDIA_TYPE',
  'RATE_LIMITED',
  'INTERNAL_ERROR',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export type ValidationFieldError = { path: string; message: string };
export type ErrorDetails = {
  fields?: ValidationFieldError[];
  ticketTypeId?: Uuid;
  max?: number;
  alreadyOwned?: number;
  [key: string]: unknown;
};
export type ErrorBody = { error: { code: ErrorCode; message: string; details?: ErrorDetails } };

// ---------- Auth ----------
export type OrgRole = 'OWNER' | 'MANAGER' | 'SCANNER';
export type Membership = { orgId: Uuid; orgName: string; orgSlug: string; role: OrgRole };
export type User = {
  id: Uuid;
  email: string;
  displayName: string;
  emailVerified: boolean;
  isPlatformAdmin: boolean;
  memberships: Membership[];
};
export type AuthSession = { accessToken: string; expiresIn: number; user: User };
export type MessageResponse = { message: string };

export type RegisterBody = { email: string; password: string; displayName: string };
export type LoginBody = { email: string; password: string };
export type TokenBody = { token: string };
export type EmailBody = { email: string };
export type ResetPasswordBody = { token: string; password: string };
export type ChangePasswordBody = { currentPassword: string; newPassword: string };

// ---------- Catalogue public ----------
export type Availability = 'AVAILABLE' | 'LOW' | 'SOLD_OUT';
export type TicketTypePublic = {
  id: Uuid;
  name: string;
  description: string | null;
  currentPriceCents: number;
  regularPriceCents: number;
  isEarly: boolean;
  earlyUntil: IsoDateTime | null;
  availability: Availability;
};
export type EventRulesPublic = {
  maxPerOrder: number;
  maxPerUser: number;
  transferEnabled: boolean;
  cardHoldMinutes: number;
  transferHoldHours: number;
  selfCancellationEnabled: boolean;
  cancellationDeadlineHours: number;
  refundPercent: number;
  serviceFeeFixedCents: number;
  serviceFeeBasisPoints: number;
  waitlistEnabled: boolean;
};
export type EventSummary = {
  id: Uuid;
  orgId: Uuid;
  orgName: string;
  orgSlug: string;
  title: string;
  venue: string | null;
  isOnline: boolean;
  startsAt: IsoDateTime;
  endsAt: IsoDateTime;
  timezone: IanaTimeZone;
  coverAvailability: Availability;
  fromPriceCents: number;
};
export type EventPublic = EventSummary & {
  description: string | null;
  address: string | null;
  salesStartAt: IsoDateTime;
  salesEndAt: IsoDateTime;
  salesOpen: boolean;
  ticketTypes: TicketTypePublic[];
  rules: EventRulesPublic;
  contactEmail: string | null;
};
export type EventsQuery = PageQuery & { orgSlug?: string; from?: IsoDateTime; to?: IsoDateTime };

// ---------- Commandes ----------
export type OrderStatus = 'PENDING_PAYMENT' | 'AWAITING_TRANSFER' | 'PAID' | 'EXPIRED' | 'CANCELLED' | 'REFUNDED';
export const ORDER_STATUSES: readonly OrderStatus[] = [
  'PENDING_PAYMENT',
  'AWAITING_TRANSFER',
  'PAID',
  'EXPIRED',
  'CANCELLED',
  'REFUNDED',
];
export type PaymentMethod = 'CARD' | 'TRANSFER';
export type OrderItem = { ticketTypeId: Uuid; name: string; quantity: number; unitPriceCents: number };
export type TransferInstructions = {
  beneficiary: string;
  iban: string;
  bic: string;
  reference: string;
  amountCents: number;
  deadline: IsoDateTime;
};
export type Order = {
  id: Uuid;
  eventId: Uuid;
  eventTitle: string;
  eventStartsAt: IsoDateTime;
  eventTimezone: IanaTimeZone;
  status: OrderStatus;
  paymentMethod: PaymentMethod;
  items: OrderItem[];
  subtotalCents: number;
  serviceFeeCents: number;
  totalCents: number;
  currency: 'EUR';
  expiresAt: IsoDateTime | null;
  paidAt: IsoDateTime | null;
  cancellableUntil: IsoDateTime | null;
  refundPercent: number;
  refundAmountCents: number | null;
  /** Montant qui serait remboursé si l'acheteur annulait maintenant ; null si annulation impossible (contrat v1.6). */
  refundPreviewCents: number | null;
  createdAt: IsoDateTime;
  transferInstructions: TransferInstructions | null;
};
/** Le client n'envoie JAMAIS de prix. */
export type CreateOrderBody = {
  eventId: Uuid;
  paymentMethod: PaymentMethod;
  items: { ticketTypeId: Uuid; quantity: number }[];
};
export type CheckoutResponse = { redirectUrl: string };

// ---------- Billets ----------
export type TicketStatus = 'VALID' | 'USED' | 'CANCELLED';
export type Ticket = {
  id: Uuid;
  publicId: string;
  status: TicketStatus;
  usedAt: IsoDateTime | null;
  qrPayload: string;
  ticketTypeName: string;
  orderId: Uuid;
  event: {
    id: Uuid;
    title: string;
    venue: string | null;
    isOnline: boolean;
    startsAt: IsoDateTime;
    endsAt: IsoDateTime;
    timezone: IanaTimeZone;
  };
};

// ---------- Liste d'attente ----------
export type WaitlistStatus = 'WAITING' | 'OFFERED' | 'CONVERTED' | 'EXPIRED' | 'LEFT';
export type WaitlistEntry = {
  id: Uuid;
  eventId: Uuid;
  eventTitle: string;
  ticketTypeId: Uuid;
  ticketTypeName: string;
  quantity: number;
  status: WaitlistStatus;
  position: number | null;
  offerExpiresAt: IsoDateTime | null;
  createdAt: IsoDateTime;
};

// ---------- Back-office : collectif ----------
export type Organization = { id: Uuid; name: string; slug: string; createdAt: IsoDateTime };
export type BankInfoMasked = { beneficiary: string | null; ibanMasked: string | null; bic: string | null };
export type OrgSettings = {
  cardHoldMinutes: number;
  transferHoldHours: number;
  transferEnabled: boolean;
  cancellationDeadlineHours: number;
  selfCancellationEnabled: boolean;
  refundPercent: number;
  serviceFeeRefundable: boolean;
  maxPerOrder: number;
  maxPerUser: number;
  waitlistOfferMinutes: number;
  waitlistEnabled: boolean;
  serviceFeeFixedCents: number;
  serviceFeeBasisPoints: number;
  defaultTimezone: IanaTimeZone;
  contactEmail: string | null;
  bank: BankInfoMasked;
};
export type OrgSettingsPatch = Partial<Omit<OrgSettings, 'bank'>> & {
  bank?: { beneficiary: string; iban: string; bic: string };
  /** Ré-authentification obligatoire si `bank` est présent (contrat v1.7). */
  currentPassword?: string;
};
export type Member = { userId: Uuid; email: string; displayName: string; role: OrgRole; createdAt: IsoDateTime };
export type AuditLogEntry = {
  id: Uuid;
  /** « Administrateur plateforme » pour un admin non membre ; null pour une action système (v1.7). */
  actorEmail: string | null;
  action: string;
  target: string;
  meta: unknown;
  createdAt: IsoDateTime;
};

// ---------- Back-office : événements ----------
export type EventStatus = 'DRAFT' | 'PUBLISHED' | 'CANCELLED';
export type EventOverrides = {
  cardHoldMinutes: number | null;
  transferHoldHours: number | null;
  transferEnabled: boolean | null;
  cancellationDeadlineHours: number | null;
  selfCancellationEnabled: boolean | null;
  refundPercent: number | null;
  maxPerOrder: number | null;
  maxPerUser: number | null;
  waitlistOfferMinutes: number | null;
  waitlistEnabled: boolean | null;
  serviceFeeFixedCents: number | null;
  serviceFeeBasisPoints: number | null;
};
export type TicketTypeAdmin = {
  id: Uuid;
  name: string;
  description: string | null;
  capacity: number;
  sold: number;
  held: number;
  remaining: number;
  priceCents: number;
  earlyPriceCents: number | null;
  earlyUntil: IsoDateTime | null;
  sortOrder: number;
};
export type EventAdmin = {
  id: Uuid;
  orgId: Uuid;
  title: string;
  description: string | null;
  venue: string | null;
  address: string | null;
  isOnline: boolean;
  startsAt: IsoDateTime;
  endsAt: IsoDateTime;
  timezone: IanaTimeZone;
  status: EventStatus;
  salesStartAt: IsoDateTime;
  salesEndAt: IsoDateTime;
  overrides: EventOverrides;
  /** Mode secours hors-ligne du contrôle d'accès (v1.13) : défaut false, modifiable par l'OWNER seul. */
  offlineCheckinEnabled: boolean;
  effectiveRules: EventRulesPublic;
  ticketTypes: TicketTypeAdmin[];
  /** Annulation d'événement traitée en arrière-plan : commandes restant à traiter (v1.14). */
  cancellationPendingOrders: number;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
};
export type EventCreateBody = {
  title: string;
  description?: string | null;
  venue?: string | null;
  address?: string | null;
  isOnline: boolean;
  startsAt: IsoDateTime;
  endsAt: IsoDateTime;
  timezone: IanaTimeZone;
  salesStartAt: IsoDateTime;
  salesEndAt: IsoDateTime;
  overrides?: Partial<EventOverrides>;
};
export type EventPatchBody = Partial<Omit<EventCreateBody, 'overrides'>> & {
  overrides?: Partial<EventOverrides>;
  /** Obligatoire en cas de report (dates modifiées alors qu'il existe des commandes) — OWNER seulement (v1.7). */
  rescheduleReason?: string;
  /** OWNER seulement (v1.13). */
  offlineCheckinEnabled?: boolean;
};
export type TicketTypeBody = {
  name: string;
  description?: string | null;
  capacity: number;
  priceCents: number;
  earlyPriceCents?: number | null;
  earlyUntil?: IsoDateTime | null;
  sortOrder?: number;
};
export type TicketTypePatchBody = Partial<TicketTypeBody>;

// ---------- Back-office : commandes, stats ----------
/** `transferInstructions` si AWAITING_TRANSFER, avec `iban` MASQUÉ (contrat v1.2). */
export type OrderAdmin = Order & {
  buyer: { id: Uuid; email: string; displayName: string };
};
export type AdminOrdersQuery = PageQuery & { status?: OrderStatus; q?: string };
export type TicketTypeStats = {
  ticketTypeId: Uuid;
  name: string;
  capacity: number;
  sold: number;
  held: number;
  remaining: number;
  checkedIn: number;
  revenueCents: number;
  refundedCents: number;
};
export type EventStats = {
  eventId: Uuid;
  generatedAt: IsoDateTime;
  currency: 'EUR';
  ticketTypes: TicketTypeStats[];
  totals: {
    capacity: number;
    sold: number;
    held: number;
    remaining: number;
    checkedIn: number;
    revenueCents: number;
    refundedCents: number;
    serviceFeeCents: number;
    /** Remboursements MANUAL_REQUIRED + FAILED à traiter par l'organisateur (v1.10). */
    refundsToProcess: number;
  };
  ordersByStatus: Record<OrderStatus, number>;
  waitlistWaiting: number;
};

// ---------- Remboursements (v1.10) ----------
export type RefundStatus = 'PENDING' | 'SUCCEEDED' | 'MANUAL_REQUIRED' | 'FAILED';
export const REFUND_STATUSES: readonly RefundStatus[] = ['PENDING', 'SUCCEEDED', 'MANUAL_REQUIRED', 'FAILED'];
export type RefundReason = 'SELF_CANCELLATION' | 'EVENT_CANCELLED' | 'LATE_PAYMENT' | 'DUPLICATE_PAYMENT' | 'UNEXPECTED_PAYMENT';
export type RefundAdmin = {
  id: Uuid;
  orderId: Uuid;
  eventId: Uuid;
  eventTitle: string;
  buyerEmail: string;
  amountCents: number;
  reason: RefundReason;
  method: PaymentMethod;
  status: RefundStatus;
  note: string | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
};
export type RefundsQuery = PageQuery & { status?: RefundStatus; eventId?: Uuid };

// ---------- Contrôle d'accès ----------
/** GET /orgs/:orgId/checkin/events (SCANNER+) : sans aucun chiffre de vente (v1.7). */
export type CheckinEvent = {
  id: Uuid;
  title: string;
  venue: string | null;
  isOnline: boolean;
  startsAt: IsoDateTime;
  endsAt: IsoDateTime;
  timezone: IanaTimeZone;
  status: EventStatus;
  /** Mode secours hors-ligne autorisé pour cet événement (v1.13). */
  offlineCheckinEnabled: boolean;
};
export type PublicKeyJwk = { kty: 'OKP'; crv: 'Ed25519'; x: string };
export type SnapshotTicket = {
  publicId: string;
  ticketTypeName: string;
  holderInitials: string;
  status: TicketStatus;
  usedAt: IsoDateTime | null;
};
export type CheckinSnapshot = {
  eventId: Uuid;
  generatedAt: IsoDateTime;
  publicKeyJwk: PublicKeyJwk;
  tickets: SnapshotTicket[];
};
export type ScanResult = 'OK' | 'ALREADY_USED' | 'INVALID' | 'CANCELLED' | 'WRONG_EVENT';
export type ScanBody = { qrPayload: string; deviceId: Uuid; scanId: Uuid };
export type ScanResponse = {
  result: ScanResult;
  ticket: { publicId: string; ticketTypeName: string; holderInitials: string } | null;
  usedAt: IsoDateTime | null;
};
export type SyncScan = { scanId: Uuid; qrPayload: string; scannedAt: IsoDateTime };
export type SyncBody = { deviceId: Uuid; scans: SyncScan[] };
export type SyncResult = 'ACCEPTED' | 'ALREADY_USED' | 'INVALID' | 'CANCELLED' | 'WRONG_EVENT';
export type SyncResponse = { results: { scanId: Uuid; result: SyncResult; usedAt: IsoDateTime | null }[] };

// ---------- Admin plateforme ----------
export type CreateOrgBody = { name: string; slug: string; ownerEmail: string };
