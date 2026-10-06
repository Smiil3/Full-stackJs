import { registerSessionCleanup } from '../auth/sessionCleanup';
import { purgePersonal, scannerStorageAvailable } from './db';

/**
 * Fin de session : listes, conflits et accès connus effacés. La FILE de passages non transmis est
 * conservée (décision PO, revue F4.1) : elle sera transmise à la reconnexion du même compte.
 */
registerSessionCleanup(async () => {
  if (!scannerStorageAvailable()) return;
  await purgePersonal();
});
