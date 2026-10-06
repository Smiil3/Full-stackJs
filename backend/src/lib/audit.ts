import type { Prisma } from '../generated/prisma/client.js';
import type { Tx } from './db.js';

/** Journal d'audit (append-only) : jamais d'IBAN en clair ni de secret dans `meta`. */
export async function writeAudit(
  tx: Tx,
  entry: { orgId: string | null; actorId: string | null; action: string; target: string; meta?: Record<string, unknown> },
): Promise<void> {
  // Sérialisation JSON explicite : dates en ISO, `undefined` retirés, aucun objet non sérialisable.
  const meta = JSON.parse(JSON.stringify(entry.meta ?? {})) as Prisma.InputJsonObject;
  await tx.auditLog.create({ data: { orgId: entry.orgId, actorId: entry.actorId, action: entry.action, target: entry.target, meta } });
}

/** Différence avant / après limitée aux champs modifiés. */
export function diff(before: Record<string, unknown>, after: Record<string, unknown>): Record<string, { from: unknown; to: unknown }> {
  const out: Record<string, { from: unknown; to: unknown }> = {};
  for (const key of Object.keys(after)) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) out[key] = { from: before[key] ?? null, to: after[key] ?? null };
  }
  return out;
}
