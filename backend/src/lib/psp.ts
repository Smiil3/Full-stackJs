import { getEnv } from '../config/env.js';

/** Client du prestataire de paiement (mock en dev / test). Appels réseau bornés, JAMAIS dans une transaction. */
export interface PspClient {
  createCheckoutSession(input: {
    orderId: string; amountCents: number; currency: 'EUR'; successUrl: string; cancelUrl: string; idempotencyKey: string;
  }): Promise<{ id: string; url: string }>;
  createRefund(input: { paymentId: string; amountCents: number; idempotencyKey: string }): Promise<{ id: string; status: string }>;
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
    signal: AbortSignal.timeout(8_000),
    redirect: 'error',
  });
  if (!res.ok) throw new PspError(res.status);
  return (await res.json()) as T;
}

const SESSION_URL = /^https?:\/\/[^\s]{1,450}$/;

export const httpPspClient: PspClient = {
  async createCheckoutSession({ idempotencyKey, ...body }) {
    const out = await call<{ id?: unknown; url?: unknown }>('/v1/checkout-sessions', body, idempotencyKey);
    // Réponse externe validée avant usage : l'URL est renvoyée telle quelle au navigateur.
    if (typeof out.id !== 'string' || out.id.length > 100 || typeof out.url !== 'string' || !SESSION_URL.test(out.url)
      || new URL(out.url).origin !== new URL(getEnv().psp.baseUrl).origin) {
      throw new PspError(502);
    }
    return { id: out.id, url: out.url };
  },
  async createRefund({ idempotencyKey, ...body }) {
    const out = await call<{ id?: unknown; status?: unknown }>('/v1/refunds', body, idempotencyKey);
    if (typeof out.id !== 'string' || out.id.length > 100 || typeof out.status !== 'string') throw new PspError(502);
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
