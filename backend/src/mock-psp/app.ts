import { randomBytes } from 'node:crypto';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import Joi from 'joi';
import { safeEqual } from '../lib/crypto.js';
import { escapeHtml } from '../lib/mail/escape.js';
import { signatureHeader } from '../lib/pspSignature.js';
import { HTTP_STATUS, HTTP_SUCCESS_MAX_EXCLUSIVE, HTTP_SUCCESS_MIN } from '../config/http.js';
import { EURO_DECIMALS, MOCK_PSP_DELAYED_WEBHOOK_MS, MOCK_PSP_FORM_LIMIT, MOCK_PSP_ID_BYTES, MOCK_PSP_JSON_LIMIT, MOCK_PSP_KEY_MAX_LENGTH, MOCK_PSP_MAX_AMOUNT_CENTS, MOCK_PSP_RETRY_DELAYS_MS, MOCK_PSP_URL_MAX_LENGTH } from '../config/mockPsp.js';
import { CENTS_PER_EURO } from '../config/money.js';
import { toUnixSeconds } from '../config/units.js';

/**
 * Prestataire de paiement SIMULÉ (dev / test uniquement) : sessions de paiement, page hébergée,
 * remboursements et webhooks signés HMAC — y compris doublons et retards volontaires pour tester
 * l'idempotence du backend. Jamais démarré en production.
 */

export interface WebhookEvent {
  id: string;
  type: 'payment.succeeded' | 'payment.failed' | 'refund.succeeded';
  created: number;
  data: { paymentId: string; sessionId?: string; orderId: string; amountCents: number; currency: string; refundId?: string; idempotencyKey?: string };
}

/** Livraison d'un webhook (HTTP en dev ; injectée en test) : renvoie le statut HTTP de la réponse. */
export type WebhookDeliver = (rawBody: string, signature: string) => Promise<number>;

export interface MockPspOptions {
  apiKey: string;
  webhookSecret: string;
  /** Origine publique du mock (URL de la page de paiement). */
  publicUrl: string;
  /** Seules origines autorisées pour les redirections après paiement (pas de redirection ouverte). */
  allowedRedirectOrigins: string[];
  deliver: WebhookDeliver;
  nodeEnv: string;
  delayedWebhookMs?: number;
  retryDelaysMs?: number[];
}

interface Session {
  id: string;
  orderId: string;
  amountCents: number;
  currency: string;
  successUrl: string;
  cancelUrl: string;
  status: 'open' | 'paid' | 'failed';
  paymentId: string | null;
  /** Échéance (= échéance de la commande) : au-delà, le paiement est refusé. */
  expiresAt: number;
}

const id = (prefix: string) => `${prefix}_${randomBytes(MOCK_PSP_ID_BYTES).toString('base64url')}`;

export interface MockPsp {
  app: Express;
  /** Envoie un webhook signé (avec réessais si non acquitté). Pour les tests : rejeu, falsification… */
  emit(event: WebhookEvent): Promise<void>;
  /** Livraisons en attente de réessai (tests). */
  pendingRetries(): number;
  sessions: Map<string, Session>;
  refunds: Map<string, { id: string; paymentId: string; amountCents: number }>;
  /** Pour les tests : déclare un paiement encaissé (hors page de paiement), pour pouvoir le rembourser. */
  registerPayment(paymentId: string, orderId: string, amountCents: number): void;
}

export function createMockPsp(options: MockPspOptions): MockPsp {
  if (options.nodeEnv === 'production') throw new Error('Le PSP simulé ne peut pas être démarré en production.');
  const sessions = new Map<string, Session>();
  const sessionsByKey = new Map<string, string>();
  const refunds = new Map<string, { id: string; paymentId: string; amountCents: number }>();
  const paymentsById = new Map<string, { orderId: string; amountCents: number }>();
  const refundedByPayment = new Map<string, number>();

  const retryDelays = options.retryDelaysMs ?? MOCK_PSP_RETRY_DELAYS_MS;
  let pending = 0;
  /** Livraison avec réessais : signature recalculée à chaque tentative (horodatage frais). */
  const emit = async (event: WebhookEvent, attempt = 0): Promise<void> => {
    const raw = JSON.stringify(event);
    let status: number;
    try {
      status = await options.deliver(raw, signatureHeader(options.webhookSecret, raw));
    } catch {
      status = 0;
    }
    if (status >= HTTP_SUCCESS_MIN && status < HTTP_SUCCESS_MAX_EXCLUSIVE) return;
    const delay = retryDelays[attempt];
    if (delay === undefined) return;
    pending += 1;
    setTimeout(() => {
      pending -= 1;
      void emit(event, attempt + 1);
    }, delay).unref();
  };
  const isExpired = (s: Session) => Date.now() >= s.expiresAt;

  const paymentEvent = (s: Session, type: WebhookEvent['type']): WebhookEvent => ({
    id: id('evt'),
    type,
    created: toUnixSeconds(Date.now()),
    data: { paymentId: s.paymentId ?? id('pay'), sessionId: s.id, orderId: s.orderId, amountCents: s.amountCents, currency: s.currency },
  });

  const app = express();
  app.disable('x-powered-by');
  // form-action couvre aussi la redirection 303 qui suit la soumission (Chromium) : on autorise exactement
  // les origines de retour configurées (le front), sans joker.
  const redirectOrigins = options.allowedRedirectOrigins.map((o) => new URL(o).origin);
  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: { defaultSrc: ["'none'"], styleSrc: ["'unsafe-inline'"], formAction: ["'self'", ...redirectOrigins], frameAncestors: ["'none'"] },
    },
  }));
  app.use(express.json({ limit: MOCK_PSP_JSON_LIMIT }));
  app.use(express.urlencoded({ extended: false, limit: MOCK_PSP_FORM_LIMIT }));

  const requireApiKey = (req: Request, res: Response, next: NextFunction): void => {
    const header = req.headers.authorization ?? '';
    if (!safeEqual(header, `Bearer ${options.apiKey}`)) {
      res.status(HTTP_STATUS.UNAUTHORIZED).json({ error: 'invalid_api_key' });
      return;
    }
    next();
  };

  const redirectAllowed = (url: string) => {
    try {
      return options.allowedRedirectOrigins.includes(new URL(url).origin);
    } catch {
      return false;
    }
  };

  const sessionSchema = Joi.object({
    orderId: Joi.string().guid().required(),
    amountCents: Joi.number().integer().min(1).max(MOCK_PSP_MAX_AMOUNT_CENTS).required(),
    currency: Joi.string().valid('EUR').required(),
    successUrl: Joi.string().uri({ scheme: ['http', 'https'] }).max(MOCK_PSP_URL_MAX_LENGTH).required(),
    cancelUrl: Joi.string().uri({ scheme: ['http', 'https'] }).max(MOCK_PSP_URL_MAX_LENGTH).required(),
    expiresAt: Joi.string().isoDate().required(),
  });

  app.post('/v1/checkout-sessions', requireApiKey, (req, res) => {
    const validated = sessionSchema.validate(req.body as unknown, { allowUnknown: false });
    const value = validated.value as (Omit<Session, 'id' | 'status' | 'paymentId' | 'expiresAt'> & { expiresAt: string }) | undefined;
    if (validated.error || !value || !redirectAllowed(value.successUrl) || !redirectAllowed(value.cancelUrl)) {
      res.status(HTTP_STATUS.BAD_REQUEST).json({ error: 'invalid_request' });
      return;
    }
    // Idempotence : même Idempotency-Key ⇒ même session (checkout rejoué ou concurrent).
    const key = typeof req.headers['idempotency-key'] === 'string' ? req.headers['idempotency-key'].slice(0, MOCK_PSP_KEY_MAX_LENGTH) : null;
    const existing = key ? sessions.get(sessionsByKey.get(key) ?? '') : undefined;
    if (existing && existing.status === 'open' && !isExpired(existing) && existing.amountCents === value.amountCents) {
      res.status(HTTP_STATUS.OK).json({ id: existing.id, url: `${options.publicUrl}/checkout/${existing.id}` });
      return;
    }
    const session: Session = { ...value, id: id('cs'), status: 'open', paymentId: null, expiresAt: new Date(value.expiresAt).getTime() };
    sessions.set(session.id, session);
    if (key) sessionsByKey.set(key, session.id);
    res.status(HTTP_STATUS.CREATED).json({ id: session.id, url: `${options.publicUrl}/checkout/${session.id}` });
  });

  // Consultation d'une session (rapprochement par le backend, filet si un webhook a été perdu).
  app.get('/v1/checkout-sessions/:sessionId', requireApiKey, (req: Request<{ sessionId: string }>, res) => {
    const s = sessions.get(req.params.sessionId);
    if (!s) {
      res.status(HTTP_STATUS.NOT_FOUND).json({ error: 'unknown_session' });
      return;
    }
    const status = s.status === 'open' && isExpired(s) ? 'expired' : s.status;
    res.json({ id: s.id, status, paymentId: s.paymentId, amountCents: s.amountCents, currency: s.currency });
  });

  app.get('/checkout/:sessionId', (req, res) => {
    const s = sessions.get(req.params.sessionId);
    if (!s) {
      res.status(HTTP_STATUS.NOT_FOUND).type('text/plain').send('Session inconnue');
      return;
    }
    const action = (path: string, label: string) =>
      `<form method="post" action="/checkout/${encodeURIComponent(s.id)}/${path}" style="margin:8px 0"><button style="padding:10px 16px;width:100%">${escapeHtml(label)}</button></form>`;
    res.type('html').send(`<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PSP simulé</title></head>
<body style="font-family:Arial,sans-serif;max-width:420px;margin:24px auto;padding:0 16px">
<h1 style="font-size:20px">Paiement simulé</h1>
<p>Commande <code>${escapeHtml(s.orderId)}</code></p>
<p>Montant : <strong>${escapeHtml((s.amountCents / CENTS_PER_EURO).toFixed(EURO_DECIMALS))} ${escapeHtml(s.currency)}</strong></p>
${s.status === 'open' && isExpired(s)
    ? '<p>Session expirée : la réservation a dépassé son échéance.</p>'
    : s.status === 'open'
    ? action('pay', 'Payer') + action('fail', 'Refuser') + action('pay-twice', 'Payer + envoyer le webhook 2 fois') + action('pay-delayed', 'Payer + webhook retardé 30 s')
    : `<p>Session déjà traitée (${escapeHtml(s.status)}).</p>`}
</body></html>`);
  });

  app.post('/checkout/:sessionId/:action', async (req, res) => {
    const s = sessions.get(req.params.sessionId);
    const { action } = req.params;
    if (!s || !['pay', 'fail', 'pay-twice', 'pay-delayed'].includes(action)) {
      res.status(HTTP_STATUS.NOT_FOUND).type('text/plain').send('Introuvable');
      return;
    }
    if (s.status !== 'open') {
      res.redirect(HTTP_STATUS.SEE_OTHER, s.status === 'paid' ? s.successUrl : s.cancelUrl);
      return;
    }
    // Session échue : paiement refusé (une réservation expirée ne peut pas être payée après coup).
    if (isExpired(s)) {
      res.redirect(HTTP_STATUS.SEE_OTHER, s.cancelUrl);
      return;
    }
    if (action === 'fail') {
      s.status = 'failed';
      await emit(paymentEvent(s, 'payment.failed')).catch(() => undefined);
      res.redirect(HTTP_STATUS.SEE_OTHER, s.cancelUrl);
      return;
    }
    s.status = 'paid';
    s.paymentId = id('pay');
    paymentsById.set(s.paymentId, { orderId: s.orderId, amountCents: s.amountCents });
    const event = paymentEvent(s, 'payment.succeeded');
    if (action === 'pay-delayed') {
      setTimeout(() => void emit(event).catch(() => undefined), options.delayedWebhookMs ?? MOCK_PSP_DELAYED_WEBHOOK_MS).unref();
    } else {
      await emit(event).catch(() => undefined);
      // Doublon volontaire : même événement (même id) renvoyé une seconde fois.
      if (action === 'pay-twice') await emit(event).catch(() => undefined);
    }
    res.redirect(HTTP_STATUS.SEE_OTHER, s.successUrl);
  });

  const refundSchema = Joi.object({ paymentId: Joi.string().max(MOCK_PSP_KEY_MAX_LENGTH).required(), amountCents: Joi.number().integer().min(1).required() });

  app.post('/v1/refunds', requireApiKey, async (req, res) => {
    const validated = refundSchema.validate(req.body as unknown, { allowUnknown: false });
    const value = validated.value as { paymentId: string; amountCents: number } | undefined;
    const key = typeof req.headers['idempotency-key'] === 'string' ? req.headers['idempotency-key'].slice(0, MOCK_PSP_KEY_MAX_LENGTH) : null;
    if (validated.error || !value || !key) {
      res.status(HTTP_STATUS.BAD_REQUEST).json({ error: 'invalid_request' });
      return;
    }
    const already = refunds.get(key);
    if (already) {
      // Idempotence stricte : même clé + corps différent ⇒ conflit.
      if (already.paymentId !== value.paymentId || already.amountCents !== value.amountCents) {
        res.status(HTTP_STATUS.CONFLICT).json({ error: 'idempotency_conflict' });
        return;
      }
      res.status(HTTP_STATUS.OK).json({ id: already.id, status: 'succeeded' });
      return;
    }
    const payment = paymentsById.get(value.paymentId);
    if (!payment) {
      res.status(HTTP_STATUS.NOT_FOUND).json({ error: 'unknown_payment' });
      return;
    }
    const refunded = refundedByPayment.get(value.paymentId) ?? 0;
    if (refunded + value.amountCents > payment.amountCents) {
      res.status(HTTP_STATUS.UNPROCESSABLE_ENTITY).json({ error: 'amount_exceeds_payment' });
      return;
    }
    refundedByPayment.set(value.paymentId, refunded + value.amountCents);
    const refund = { id: id('re'), paymentId: value.paymentId, amountCents: value.amountCents };
    refunds.set(key, refund);
    res.status(HTTP_STATUS.CREATED).json({ id: refund.id, status: 'succeeded' });
    await emit({
      id: id('evt'), type: 'refund.succeeded', created: toUnixSeconds(Date.now()),
      data: { paymentId: value.paymentId, refundId: refund.id, idempotencyKey: key, orderId: payment.orderId, amountCents: value.amountCents, currency: 'EUR' },
    }).catch(() => undefined);
  });

  // Consultation d'un remboursement par clé d'idempotence (le backend vérifie avant de passer en manuel).
  app.get('/v1/refunds', requireApiKey, (req, res) => {
    const key = typeof req.query['idempotencyKey'] === 'string' ? req.query['idempotencyKey'].slice(0, MOCK_PSP_KEY_MAX_LENGTH) : '';
    const refund = refunds.get(key);
    if (!refund) {
      res.status(HTTP_STATUS.NOT_FOUND).json({ error: 'unknown_refund' });
      return;
    }
    res.json({ id: refund.id, status: 'succeeded', paymentId: refund.paymentId, amountCents: refund.amountCents });
  });

  const registerPayment = (paymentId: string, orderId: string, amountCents: number) => {
    paymentsById.set(paymentId, { orderId, amountCents });
  };

  return { app, emit: (event) => emit(event), pendingRetries: () => pending, sessions, refunds, registerPayment };
}
