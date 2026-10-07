import { afterAll, beforeEach } from 'vitest';
import { disconnectDb, getDb } from '../../src/lib/db.js';

/** Tables vidées entre deux tests ; `tests/infra/db.test.ts` vérifie que la liste couvre tout le schéma. */
export const TRUNCATED_TABLES = [
  'audit_logs', 'check_ins', 'email_outbox', 'email_tokens', 'event_reschedules', 'events', 'memberships', 'order_items', 'orders',
  'organization_settings', 'organizations', 'payments', 'psp_sessions', 'rate_limit_buckets', 'refresh_tokens', 'refunds',
  'reschedule_notifications', 'ticket_types', 'tickets',
  'users', 'waitlist_entries', 'webhook_events',
] as const;

/** Vide toutes les tables métier avant chaque test (la structure migrée est conservée). */
export async function resetDatabase(): Promise<void> {
  await getDb().$executeRaw`
    TRUNCATE TABLE "audit_logs", "check_ins", "email_outbox", "email_tokens", "event_reschedules", "events", "memberships",
      "order_items", "orders", "organization_settings", "organizations", "payments", "psp_sessions", "rate_limit_buckets", "refresh_tokens",
      "refunds", "reschedule_notifications", "ticket_types", "tickets", "users", "waitlist_entries", "webhook_events"
    RESTART IDENTITY CASCADE`;
}

/**
 * Nettoyage avec nouvel essai : TRUNCATE prend des verrous exclusifs sur toutes les tables ; une transaction
 * résiduelle du test précédent (webhook émis par le PSP simulé après sa réponse) peut provoquer un
 * interblocage ponctuel (40P01). Propre à l'outillage de test, jamais au code applicatif.
 */
beforeEach(async () => {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await resetDatabase();
      return;
    } catch (err) {
      if (attempt >= 3 || !String(err).includes('40P01')) throw err;
      await new Promise((r) => setTimeout(r, 100 * attempt));
    }
  }
});

afterAll(async () => {
  await disconnectDb();
});
