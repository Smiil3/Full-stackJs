/**
 * Accès au contrôle d'entrée du compte connecté, réécrits à CHAQUE réponse du serveur sur l'utilisateur
 * (/auth/me, refresh) : un contrôleur retiré d'un collectif perd aussi, sur cet appareil, la liste
 * locale de ses événements (la file de passages non transmis est conservée).
 */
import type { User } from '../api/types';
import { roleAtLeast } from '../auth/roles';
import { getScannerAccess, listSnapshots, ownerHash, purgeEvent, scannerStorageAvailable, setScannerAccess } from './db';

export async function rememberScannerAccess(user: User): Promise<void> {
  if (!scannerStorageAvailable()) return;
  const orgIds = user.memberships.filter((m) => roleAtLeast(m.role, 'SCANNER')).map((m) => m.orgId).sort();
  const hash = await ownerHash(user.id);
  const stored = await getScannerAccess();
  // Écriture seulement si quelque chose a changé (pas d'écriture IndexedDB à chaque affichage).
  if (!stored || stored.ownerHash !== hash || stored.orgIds.length !== orgIds.length || stored.orgIds.some((id, i) => id !== orgIds[i])) {
    await setScannerAccess({ ownerHash: hash, orgIds });
  }
  for (const s of await listSnapshots()) if (!orgIds.includes(s.orgId)) await purgeEvent(s.eventId);
}
