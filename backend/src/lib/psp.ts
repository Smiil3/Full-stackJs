import { getEnv } from '../config/env.js';
import { PSP_ID_MAX_LENGTH, PSP_TIMEOUT_MS } from '../config/payments.js';
import { HTTP_STATUS } from '../config/http.js';

/** Client du prestataire de paiement (mock en dev / test). Appels réseau bornés, JAMAIS dans une transaction. */
export interface PspSessionStatus {
  id: string;
  status: 'open' | 'paid' | 'failed' | 'expired';
  paymentId: string | null;
  amountCents: number;
  currency: string;
}

export interface PspClient {
  createCheckoutSession(input: {
    orderId: string; amountCents: number; currency: 'EUR'; successUrl: string; cancelUrl: string; idempotencyKey: string; expiresAt: Date;
  }): Promise<{ id: string; url: string }>;
  /** Consultation d'une session (rapprochement) ; null si inconnue. */
  getCheckoutSession(sessionId: string): Promise<PspSessionStatus | null>;
  createRefund(input: { paymentId: string; amountCents: number; idempotencyKey: string }): Promise<{ id: string; status: string }>;
  /** Remboursement déjà effectué pour cette clé d'idempotence ? null si inconnu du PSP. */
  findRefund(idempotencyKey: string): Promise<{ id: string; status: string } | null>;
}

export class PspError extends Error {
  constructor(public readonly status: number) {
    super(`Réponse PSP inattendue (${status})`);
    this.name = 'PspError';
  }
}

async function call<T>(path: string, body: unknown, idempotencyKey: string): Promise<T> {
  const { psp } = getEnv();
  const res = await fetch(`${psp.baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${psp.apiKey}`, 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(PSP_TIMEOUT_MS),
    redirect: 'error',
  });
  if (!res.ok) throw new PspError(res.status);
  return (await res.json()) as T;
}

async function get<T>(path: string): Promise<T | null> {
  const { psp } = getEnv();
  const res = await fetch(`${psp.baseUrl}${path}`, {
    headers: { Authorization: `Bearer ${psp.apiKey}` },
    signal: AbortSignal.timeout(PSP_TIMEOUT_MS),
    redirect: 'error',
  });
  if (res.status === HTTP_STATUS.NOT_FOUND) return null;
  if (!res.ok) throw new PspError(res.status);
  return (await res.json()) as T;
}

const SESSION_URL = /^https?:\/\/[^\s]{1,450}$/;
const SESSION_STATUSES = new Set(['open', 'paid', 'failed', 'expired']);

export const httpPspClient: PspClient = {
  async createCheckoutSession({ idempotencyKey, expiresAt, ...body }) {
    const out = await call<{ id?: unknown; url?: unknown }>('/v1/checkout-sessions', { ...body, expiresAt: expiresAt.toISOString() }, idempotencyKey);
    // Réponse externe validée avant usage : l'URL est renvoyée telle quelle au navigateur.
    if (typeof out.id !== 'string' || out.id.length > PSP_ID_MAX_LENGTH || typeof out.url !== 'string' || !SESSION_URL.test(out.url)
      || new URL(out.url).origin !== new URL(getEnv().psp.baseUrl).origin) {
      throw new PspError(HTTP_STATUS.BAD_GATEWAY);
    }
    return { id: out.id, url: out.url };
  },
  async getCheckoutSession(sessionId) {
    const out = await get<Record<string, unknown>>(`/v1/checkout-sessions/${encodeURIComponent(sessionId)}`);
    if (!out) return null;
    // Réponse externe validée avant usage.
    const status = out['status'];
    const paymentId = out['paymentId'];
    if (typeof out['id'] !== 'string' || typeof status !== 'string' || !SESSION_STATUSES.has(status)
      || (paymentId !== null && typeof paymentId !== 'string') || typeof out['amountCents'] !== 'number' || typeof out['currency'] !== 'string') {
      throw new PspError(HTTP_STATUS.BAD_GATEWAY);
    }
    return { id: out['id'], status: status as PspSessionStatus['status'], paymentId, amountCents: out['amountCents'], currency: out['currency'] };
  },
  async findRefund(idempotencyKey) {
    const out = await get<{ id?: unknown; status?: unknown }>(`/v1/refunds?idempotencyKey=${encodeURIComponent(idempotencyKey)}`);
    if (!out) return null;
    if (typeof out.id !== 'string' || typeof out.status !== 'string') throw new PspError(HTTP_STATUS.BAD_GATEWAY);
    return { id: out.id, status: out.status };
  },
  async createRefund({ idempotencyKey, ...body }) {
    const out = await call<{ id?: unknown; status?: unknown }>('/v1/refunds', body, idempotencyKey);
    if (typeof out.id !== 'string' || out.id.length > PSP_ID_MAX_LENGTH || typeof out.status !== 'string') throw new PspError(HTTP_STATUS.BAD_GATEWAY);
    return { id: out.id, status: out.status };
  },
};

let current: PspClient = httpPspClient;

export function getPspClient(): PspClient {
  return current;
}

/** Réservé aux tests (client en mémoire branché sur le mock). */
export function setPspClientForTests(client: PspClient): void {
  current = client;
}
