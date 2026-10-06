import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import supertest from 'supertest';
import { resetEnvCache } from '../src/config/env.js';
import { createMockPsp, type MockPsp, type WebhookEvent } from '../src/mock-psp/app.js';
import { signatureHeader } from '../src/lib/pspSignature.js';
import { createApp } from '../src/app.js';
import { FRONT } from './helpers.js';

export interface PspHarness {
  psp: MockPsp;
  server: Server;
  baseUrl: string;
  deliveries: { status: number; body: unknown }[];
  close(): Promise<void>;
}

/**
 * Démarre le PSP simulé sur un port local aléatoire ; ses webhooks sont livrés directement à
 * l'application de test (corps brut + signature réelle).
 */
export async function startPsp(): Promise<PspHarness> {
  const app = createApp({ rateLimitMultiplier: 1000 });
  const deliveries: { status: number; body: unknown }[] = [];
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env['PSP_BASE_URL'] = baseUrl;
  resetEnvCache();
  const psp = createMockPsp({
    apiKey: process.env['PSP_API_KEY']!,
    webhookSecret: process.env['PSP_WEBHOOK_SECRET']!,
    publicUrl: baseUrl,
    allowedRedirectOrigins: [FRONT],
    nodeEnv: 'test',
    delayedWebhookMs: 50,
    deliver: async (raw, signature) => {
      const res = await supertest(app).post('/api/v1/webhooks/psp').set('Content-Type', 'application/json').set('Psp-Signature', signature).send(raw);
      deliveries.push({ status: res.status, body: res.body });
    },
  });
  server.on('request', psp.app);
  return {
    psp, server, baseUrl, deliveries,
    close: () => new Promise<void>((resolve) => server.close(() => { resolve(); })),
  };
}

/** Envoie un webhook signé (ou falsifié) directement à l'application. */
export function postWebhook(event: WebhookEvent | string, opts: { secret?: string; timestamp?: number; signature?: string } = {}) {
  const raw = typeof event === 'string' ? event : JSON.stringify(event);
  const signature = opts.signature ?? signatureHeader(opts.secret ?? process.env['PSP_WEBHOOK_SECRET']!, raw, opts.timestamp);
  return supertest(createApp({ rateLimitMultiplier: 1000 }))
    .post('/api/v1/webhooks/psp').set('Content-Type', 'application/json').set('Psp-Signature', signature).send(raw);
}

export function paymentEvent(orderId: string, amountCents: number, over: Partial<WebhookEvent> & { paymentId?: string; currency?: string } = {}): WebhookEvent {
  return {
    id: over.id ?? `evt_${randomBytes(9).toString('base64url')}`,
    type: over.type ?? 'payment.succeeded',
    created: Math.floor(Date.now() / 1000),
    data: { paymentId: over.paymentId ?? `pay_${randomBytes(9).toString('base64url')}`, orderId, amountCents, currency: over.currency ?? 'EUR' },
  };
}
