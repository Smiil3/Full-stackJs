/**
 * Gardes de forme à l'exécution pour les réponses critiques (session, utilisateur).
 * Une réponse mal formée ne doit jamais devenir un état d'authentification.
 */
import { ApiError } from './errors';
import { ORDER_STATUSES, type AuthSession, type EventStats, type Membership, type OrgSettings, type User } from './types';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const ROLES = new Set(['OWNER', 'MANAGER', 'SCANNER']);

function isMembership(v: unknown): v is Membership {
  return isObj(v) && isStr(v.orgId) && isStr(v.orgName) && isStr(v.orgSlug) && typeof v.role === 'string' && ROLES.has(v.role);
}

export function isUser(v: unknown): v is User {
  return (
    isObj(v) &&
    isStr(v.id) &&
    isStr(v.email) &&
    typeof v.displayName === 'string' &&
    typeof v.emailVerified === 'boolean' &&
    typeof v.isPlatformAdmin === 'boolean' &&
    Array.isArray(v.memberships) &&
    v.memberships.every(isMembership)
  );
}

/** Durée de vie max acceptée pour un access token (le contrat annonce 10 min). */
const MAX_EXPIRES_IN = 24 * 3600;

export function isAuthSession(v: unknown): v is AuthSession {
  return (
    isObj(v) &&
    isStr(v.accessToken) &&
    !/\s/.test(v.accessToken) &&
    typeof v.expiresIn === 'number' &&
    Number.isInteger(v.expiresIn) &&
    v.expiresIn > 0 &&
    v.expiresIn <= MAX_EXPIRES_IN &&
    isUser(v.user)
  );
}

const unexpected = () => new ApiError({ status: 200, code: 'UNEXPECTED_RESPONSE', message: 'invalid shape' });

export function parseAuthSession(v: unknown): AuthSession {
  if (!isAuthSession(v)) throw unexpected();
  return v;
}

export function parseUser(v: unknown): User {
  if (!isUser(v)) throw unexpected();
  return v;
}

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';

export function isOrgSettings(v: unknown): v is OrgSettings {
  if (!isObj(v) || !isObj(v.bank)) return false;
  const ints = ['cardHoldMinutes', 'transferHoldHours', 'cancellationDeadlineHours', 'refundPercent', 'maxPerOrder', 'maxPerUser', 'waitlistOfferMinutes', 'serviceFeeFixedCents', 'serviceFeeBasisPoints'];
  const bools = ['transferEnabled', 'selfCancellationEnabled', 'serviceFeeRefundable', 'waitlistEnabled'];
  const nullableStr = (x: unknown) => x === null || typeof x === 'string';
  return (
    ints.every((k) => isInt(v[k])) &&
    bools.every((k) => isBool(v[k])) &&
    typeof v.defaultTimezone === 'string' &&
    nullableStr(v.contactEmail) &&
    nullableStr(v.bank.beneficiary) &&
    nullableStr(v.bank.ibanMasked) &&
    nullableStr(v.bank.bic)
  );
}

export function isEventStats(v: unknown): v is EventStats {
  if (!isObj(v) || !isObj(v.totals) || !isObj(v.ordersByStatus) || !Array.isArray(v.ticketTypes)) return false;
  const totals = v.totals;
  const statuses = v.ordersByStatus;
  return (
    isStr(v.eventId) &&
    isStr(v.generatedAt) &&
    ['capacity', 'sold', 'held', 'remaining', 'checkedIn', 'revenueCents', 'refundedCents', 'serviceFeeCents', 'refundsToProcess'].every((k) => isInt(totals[k])) &&
    ORDER_STATUSES.every((s) => isInt(statuses[s])) &&
    isInt(v.waitlistWaiting) &&
    v.ticketTypes.every(
      (t) => isObj(t) && isStr(t.ticketTypeId) && typeof t.name === 'string' && ['capacity', 'sold', 'held', 'remaining', 'checkedIn', 'revenueCents', 'refundedCents'].every((k) => isInt(t[k])),
    )
  );
}

export function parseOrgSettings(v: unknown): OrgSettings {
  if (!isOrgSettings(v)) throw unexpected();
  return v;
}

export function parseEventStats(v: unknown): EventStats {
  if (!isEventStats(v)) throw unexpected();
  return v;
}
