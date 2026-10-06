import { processOutboxBatch, type MailTransport } from '../lib/outbox.js';
import { purgeExpiredBuckets } from '../lib/rateLimitStore.js';
import { expireWaitlistOffers, sweepWaitlist } from '../modules/waitlist/service.js';
import { expireOrders } from './expireOrders.js';
import { processEventCancellations } from './processEventCancellations.js';
import { processRefunds } from './processRefunds.js';
import { reconcileRecentSessions } from './reconcilePayments.js';

export type WorkerJob = [name: string, run: () => Promise<unknown>];

/**
 * Jobs d'un passage du worker, DANS CET ORDRE :
 * - annulations d'événement d'abord : une commande d'un événement annulé est remboursée / annulée, jamais simplement expirée ;
 * - rapprochement des paiements avant l'expiration : un paiement dont le webhook est perdu n'est pas expiré à tort.
 */
export function workerJobs(transport: MailTransport): WorkerJob[] {
  return [
    ['eventCancellations', () => processEventCancellations()],
    ['reconcilePayments', () => reconcileRecentSessions()],
    ['expireOrders', () => expireOrders()],
    ['expireWaitlistOffers', () => expireWaitlistOffers()],
    ['sweepWaitlist', () => sweepWaitlist()],
    ['refunds', () => processRefunds()],
    ['outbox', () => processOutboxBatch(transport)],
    ['purgeRateLimits', () => purgeExpiredBuckets()],
  ];
}
