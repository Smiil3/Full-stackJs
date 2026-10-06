import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ACCESS_TOKEN_TTL_SECONDS, EMAIL_TOKEN_TTL_MINUTES, FAILURE_WINDOW_MINUTES, MAIL_DAILY_WINDOW_MS, MAIL_MAX_PER_DAY,
  MAIL_MIN_INTERVAL_MINUTES, MAX_LOCK_MINUTES, REFRESH_FAMILY_MAX_MS, REFRESH_GRACE_MS, REFRESH_TTL_MS,
} from '../../src/config/auth.js';
import {
  CHECKIN_CLOSES_AFTER_MS, CHECKIN_OPENS_BEFORE_MS, QR_PAYLOAD_MAX_LENGTH, SCAN_FUTURE_TOLERANCE_MS, SYNC_MAX_SCANS,
  SYNC_SCANS_PER_MINUTE, TICKET_PUBLIC_ID_BYTES,
} from '../../src/config/checkin.js';
import { FIELD_LIMITS } from '../../src/config/fields.js';
import { SYNC_BODY_LIMIT, SYNC_BODY_LIMIT_BYTES } from '../../src/config/http.js';
import { OUTBOX_LEASE_MS, SMTP_CONNECTION_TIMEOUT_MS, SMTP_GREETING_TIMEOUT_MS, SMTP_SOCKET_TIMEOUT_MS } from '../../src/config/mail.js';
import { BASIS_POINTS_SCALE, LINE_QUANTITY_MAX, MAX_AMOUNT_CENTS, PERCENT_MAX, TICKET_PRICE_MAX_CENTS } from '../../src/config/money.js';
import { PSP_TIMEOUT_MS, RECONCILE_GRACE_MS, RECONCILE_RECHECK_MS, WEBHOOK_MAX_AMOUNT_CENTS } from '../../src/config/payments.js';
import { RATE_LIMITS } from '../../src/config/rateLimits.js';
import { REFUND_LEASE_MS } from '../../src/config/refunds.js';
import { SETTINGS_BOUNDS } from '../../src/config/settingsBounds.js';
import { MINUTE_MS, SECOND_MS, minutes } from '../../src/config/units.js';
import { MAX_ACCUMULATION_MINUTES } from '../../src/config/waitlist.js';
import { MOCK_PSP_RETRY_DELAYS_MS } from '../../src/config/mockPsp.js';

/** Cohérence des constantes de src/config entre elles (B10) : une valeur modifiée seule ne casse pas un invariant. */
describe('invariants de configuration', () => {
  it('sessions : grâce de rotation < durée du jeton d’accès ≤ durée du refresh ≤ durée d’une famille', () => {
    expect(REFRESH_GRACE_MS).toBeLessThan(ACCESS_TOKEN_TTL_SECONDS * SECOND_MS);
    expect(ACCESS_TOKEN_TTL_SECONDS * SECOND_MS).toBeLessThan(REFRESH_TTL_MS);
    expect(REFRESH_TTL_MS).toBeLessThanOrEqual(REFRESH_FAMILY_MAX_MS);
  });

  it('verrouillage : verrou maximal ≤ fenêtre de comptage des échecs', () => {
    expect(MAX_LOCK_MINUTES).toBeLessThanOrEqual(FAILURE_WINDOW_MINUTES);
  });

  it('mails d’authentification : intervalle minimal × plafond quotidien tient dans 24 h ; un lien vit plus que l’intervalle', () => {
    expect(minutes(MAIL_MIN_INTERVAL_MINUTES) * MAIL_MAX_PER_DAY).toBeLessThanOrEqual(MAIL_DAILY_WINDOW_MS);
    expect(EMAIL_TOKEN_TTL_MINUTES).toBeGreaterThan(MAIL_MIN_INTERVAL_MINUTES);
  });

  it('synchronisation : un lot de 500 vrais QR tient dans la limite de corps (160 ko) et dans le quota par minute', () => {
    expect(Number.parseInt(SYNC_BODY_LIMIT, 10) * 1024).toBe(SYNC_BODY_LIMIT_BYTES);
    // QR réel le plus long : NG1.<uuid>.<publicId base64url>.<signature Ed25519 base64url (64 octets)>.
    const publicIdChars = Math.ceil((TICKET_PUBLIC_ID_BYTES * 8) / 6);
    const signatureChars = Math.ceil((64 * 8) / 6);
    const qr = `NG1.${randomUUID()}.${'A'.repeat(publicIdChars)}.${'A'.repeat(signatureChars)}`;
    expect(qr.length).toBeLessThanOrEqual(QR_PAYLOAD_MAX_LENGTH);
    const scannedAt = 'X'.repeat(FIELD_LIMITS.isoDateInput);
    const body = JSON.stringify({
      deviceId: randomUUID(),
      scans: Array.from({ length: SYNC_MAX_SCANS }, () => ({ scanId: randomUUID(), qrPayload: qr, scannedAt })),
    });
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(SYNC_BODY_LIMIT_BYTES);
    expect(SYNC_SCANS_PER_MINUTE).toBeGreaterThanOrEqual(SYNC_MAX_SCANS);
  });

  it('contrôle : l’avance tolérée sur l’horloge reste dans la fenêtre d’ouverture', () => {
    expect(SCAN_FUTURE_TOLERANCE_MS).toBeLessThan(CHECKIN_OPENS_BEFORE_MS);
    expect(CHECKIN_CLOSES_AFTER_MS).toBeGreaterThan(0);
  });

  it('réglages : bornes ordonnées, plafond par commande ≤ plafond par personne, champs d’entrée alignés', () => {
    for (const { min, max } of Object.values(SETTINGS_BOUNDS)) expect(min).toBeLessThanOrEqual(max);
    expect(SETTINGS_BOUNDS.maxPerOrder.max).toBeLessThanOrEqual(SETTINGS_BOUNDS.maxPerUser.max);
    expect(FIELD_LIMITS.quantityPerLine).toBe(SETTINGS_BOUNDS.maxPerOrder.max);
    expect(SETTINGS_BOUNDS.refundPercent.max).toBe(PERCENT_MAX);
    expect(BigInt(SETTINGS_BOUNDS.serviceFeeBasisPoints.max)).toBeLessThan(BASIS_POINTS_SCALE);
    // L'accumulation de la liste d'attente n'est jamais plus courte que le plus court délai d'offre autorisé.
    expect(MAX_ACCUMULATION_MINUTES).toBeGreaterThanOrEqual(SETTINGS_BOUNDS.waitlistOfferMinutes.min);
  });

  it('montants : la plus grosse commande possible reste un entier sûr, sous les bornes de calcul et de webhook', () => {
    expect(TICKET_PRICE_MAX_CENTS).toBeLessThanOrEqual(MAX_AMOUNT_CENTS);
    expect(LINE_QUANTITY_MAX).toBeGreaterThanOrEqual(FIELD_LIMITS.quantityPerLine);
    // Une commande compte au plus maxPerOrder places au total, toutes lignes confondues (vérifié à la réservation).
    const subtotal = TICKET_PRICE_MAX_CENTS * SETTINGS_BOUNDS.maxPerOrder.max;
    const fee = SETTINGS_BOUNDS.serviceFeeFixedCents.max + Math.ceil((subtotal * SETTINGS_BOUNDS.serviceFeeBasisPoints.max) / Number(BASIS_POINTS_SCALE));
    expect(subtotal + fee).toBeLessThanOrEqual(WEBHOOK_MAX_AMOUNT_CENTS);
    expect(Number.isSafeInteger(subtotal + fee)).toBe(true);
  });

  it('worker : les baux couvrent les appels réseau qu’ils protègent ; le rapprochement repasse avant la fin du délai de grâce', () => {
    expect(OUTBOX_LEASE_MS).toBeGreaterThan(SMTP_CONNECTION_TIMEOUT_MS + SMTP_GREETING_TIMEOUT_MS + SMTP_SOCKET_TIMEOUT_MS);
    expect(REFUND_LEASE_MS).toBeGreaterThan(PSP_TIMEOUT_MS);
    expect(RECONCILE_RECHECK_MS).toBeLessThan(RECONCILE_GRACE_MS);
  });

  it('rate limiting : le suivi de commande du front (toutes les 2 s pendant 60 s) passe ; plafond par compte ≤ filet par IP', () => {
    const frontPollsPerMinute = MINUTE_MS / (2 * SECOND_MS);
    expect(RATE_LIMITS.orderPoll.max).toBeGreaterThanOrEqual(frontPollsPerMinute);
    expect(RATE_LIMITS.global.max).toBeLessThanOrEqual(RATE_LIMITS.globalIp.max);
    expect(RATE_LIMITS.scanPerUser.max).toBeLessThanOrEqual(RATE_LIMITS.scan.max);
    expect(RATE_LIMITS.ordersPerUser.max).toBeLessThanOrEqual(RATE_LIMITS.orders.max);
  });

  it('PSP simulé : réessais de webhook à délais croissants', () => {
    for (let i = 1; i < MOCK_PSP_RETRY_DELAYS_MS.length; i += 1) {
      expect(MOCK_PSP_RETRY_DELAYS_MS[i]!).toBeGreaterThan(MOCK_PSP_RETRY_DELAYS_MS[i - 1]!);
    }
  });
});
