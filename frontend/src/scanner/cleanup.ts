import { registerSessionCleanup } from '../auth/sessionCleanup';
import { purgeAll, scannerStorageAvailable } from './db';

/** Fin de session : listes, file et conflits du scanner effacés (l'identifiant d'appareil reste). */
registerSessionCleanup(async () => {
  if (!scannerStorageAvailable()) return;
  await purgeAll();
});
