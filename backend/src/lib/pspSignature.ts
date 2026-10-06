import { createHmac, timingSafeEqual } from 'node:crypto';
import { WEBHOOK_TOLERANCE_SECONDS } from '../config/payments.js';
import { toUnixSeconds } from '../config/units.js';

export function signPayload(secret: string, timestamp: number, rawBody: Buffer | string): string {
  return createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest('hex');
}

/** En-tête `Psp-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, t + "." + rawBody)>`. */
export function signatureHeader(secret: string, rawBody: Buffer | string, timestamp = toUnixSeconds(Date.now())): string {
  return `t=${timestamp},v1=${signPayload(secret, timestamp, rawBody)}`;
}

const HEADER_RE = /^t=(\d{1,12}),v1=([0-9a-f]{64})$/;

export type SignatureCheck = { ok: true } | { ok: false; reason: 'format' | 'timestamp' | 'signature' };

/**
 * Vérifie la signature d'un webhook sur les OCTETS EXACTS reçus : format strict, horodatage à ±5 min,
 * comparaison HMAC à temps constant (crypto.timingSafeEqual).
 */
export function verifySignature(secret: string, header: string | undefined, rawBody: Buffer, nowSeconds = toUnixSeconds(Date.now())): SignatureCheck {
  const match = typeof header === 'string' ? HEADER_RE.exec(header) : null;
  if (!match?.[1] || !match[2]) return { ok: false, reason: 'format' };
  const timestamp = Number(match[1]);
  if (Math.abs(nowSeconds - timestamp) > WEBHOOK_TOLERANCE_SECONDS) return { ok: false, reason: 'timestamp' };
  const expected = Buffer.from(signPayload(secret, timestamp, rawBody), 'hex');
  const received = Buffer.from(match[2], 'hex');
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) return { ok: false, reason: 'signature' };
  return { ok: true };
}
