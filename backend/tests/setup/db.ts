import { afterAll, beforeEach } from 'vitest';
import { disconnectDb, getDb } from '../../src/lib/db.js';

/** Tables vidées entre deux tests ; `tests/infra/db.test.ts` vérifie que la liste couvre tout le schéma. */
export const TRUNCATED_TABLES = [
  'audit_logs', 'check_ins', 'email_outbox', 'email_tokens', 'events', 'memberships', 'order_items', 'orders',
  'organization_settings', 'organizations', 'payments', 'rate_limit_buckets', 'refresh_tokens', 'refunds', 'ticket_types', 'tickets',
  'users', 'waitlist_entries', 'webhook_events',
] as const;

/** Vide toutes les tables métier avant chaque test (la structure migrée est conservée). */
export async function resetDatabase(): Promise<void> {
  await getDb().$executeRaw`
    TRUNCATE TABLE "audit_logs", "check_ins", "email_outbox", "email_tokens", "events", "memberships",
      "order_items", "orders", "organization_settings", "organizations", "payments", "rate_limit_buckets", "refresh_tokens",
      "refunds", "ticket_types", "tickets", "users", "waitlist_entries", "webhook_events"
    RESTART IDENTITY CASCADE`;
}

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await disconnectDb();
});
