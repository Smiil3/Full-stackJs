import { setTimeout as sleep } from 'node:timers/promises';
import type { Logger } from 'pino';
import { JOB_TIME_BUDGET_MS } from '../config/worker.js';
import { RETENTION_PURGE_INTERVAL_MS } from '../config/retention.js';
import { TimeBudget } from '../lib/budget.js';
import { processOutboxBatch, type MailTransport } from '../lib/outbox.js';
import { purgeExpiredBuckets } from '../lib/rateLimitStore.js';
import { expireWaitlistOffers, sweepWaitlist } from '../modules/waitlist/service.js';
import { processEventReschedules } from '../modules/events/reschedule.js';
import { expireOrders } from './expireOrders.js';
import { processEventCancellations } from './processEventCancellations.js';
import { processRefunds } from './processRefunds.js';
import { purgeRetention } from './purgeRetention.js';
import { reconcileRecentSessions } from './reconcilePayments.js';

export type WorkerJob = [name: string, run: (budget: TimeBudget) => Promise<unknown>];

/** Purge de rétention : au plus une fois par RETENTION_PURGE_INTERVAL_MS et par processus. */
const retentionState = { lastRunMs: Number.NEGATIVE_INFINITY };

/**
 * Jobs de fond d'un passage, DANS CET ORDRE :
 * - annulations d'événement d'abord : une commande d'un événement annulé est remboursée / annulée, jamais simplement expirée ;
 * - rapprochement des paiements avant l'expiration : un paiement dont le webhook est perdu n'est pas expiré à tort.
 * Les mails ont leur PROPRE boucle (`mailJobs`) : un PSP muet ne retarde plus les mails (audit M3).
 */
export function workerJobs(): WorkerJob[] {
  return [
    ['eventCancellations', (b) => processEventCancellations(b)],
    ['eventReschedules', (b) => processEventReschedules(b)],
    ['reconcilePayments', (b) => reconcileRecentSessions(b)],
    ['expireOrders', (b) => expireOrders(b)],
    ['expireWaitlistOffers', (b) => expireWaitlistOffers(b)],
    ['sweepWaitlist', () => sweepWaitlist()],
    ['refunds', (b) => processRefunds(b)],
    ['purgeRateLimits', () => purgeExpiredBuckets()],
    ['purgeRetention', async (b) => {
      if (performance.now() - retentionState.lastRunMs < RETENTION_PURGE_INTERVAL_MS) return null;
      retentionState.lastRunMs = performance.now();
      return purgeRetention(b);
    }],
  ];
}

/** Boucle des mails (outbox), indépendante des jobs de fond. */
export function mailJobs(transport: MailTransport): WorkerJob[] {
  return [['outbox', () => processOutboxBatch(transport)]];
}

/**
 * Boucle d'un groupe de jobs : chaque job a un budget de temps (JOB_TIME_BUDGET_MS) ; l'arrêt (SIGTERM) est
 * vérifié ENTRE les jobs et interrompt l'attente entre deux passages ; un job en échec n'arrête pas les autres.
 */
async function loop(jobs: () => WorkerJob[], intervalMs: number, signal: AbortSignal, logger: Logger, budgetMs: number): Promise<void> {
  // Lu via une fonction : l'arrêt survient pendant un job (TypeScript ne voit pas la mutation).
  const stopped = () => signal.aborted;
  while (!stopped()) {
    for (const [name, job] of jobs()) {
      if (stopped()) return;
      try {
        const result = await job(new TimeBudget(budgetMs));
        logger.debug({ job: name, result }, 'job exécuté');
      } catch (err) {
        logger.error({ err, job: name }, 'échec du job');
      }
    }
    await sleep(intervalMs, undefined, { signal }).catch(() => undefined);
  }
}

/** Worker : deux boucles concurrentes (jobs de fond, mails) jusqu'à l'arrêt. */
export async function runWorker(opts: {
  transport: MailTransport; intervalMs: number; signal: AbortSignal; logger: Logger; budgetMs?: number;
}): Promise<void> {
  const budgetMs = opts.budgetMs ?? JOB_TIME_BUDGET_MS;
  await Promise.all([
    loop(workerJobs, opts.intervalMs, opts.signal, opts.logger.child({ loop: 'jobs' }), budgetMs),
    loop(() => mailJobs(opts.transport), opts.intervalMs, opts.signal, opts.logger.child({ loop: 'mails' }), budgetMs),
  ]);
}
