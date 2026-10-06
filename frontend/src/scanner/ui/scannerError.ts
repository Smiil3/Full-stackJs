import { errorMessage } from '../../api/errors';
import { AccessRevokedError, EventClosedError, EventNotAvailableError, NoSnapshotError, SessionExpiredError, StaleSnapshotError } from '../engine';
import { OfflineDisabledError, OtherEventBlockedError } from '../snapshot';
import { SyncForbiddenError } from '../sync';
import { SessionChangedError } from '../db';

export function scannerErrorMessage(e: unknown): string {
  if (e instanceof EventNotAvailableError) return 'Événement non disponible au contrôle (contrôle ouvert de 12 h avant le début à 24 h après la fin, événement publié).';
  if (e instanceof EventClosedError) return 'Le contrôle de cet événement est terminé (plus de 24 h après la fin) : contrôle local refusé.';
  if (e instanceof StaleSnapshotError) return 'Liste hors-ligne de plus de 24 h : mettez-la à jour avant de contrôler.';
  if (e instanceof NoSnapshotError) return 'La liste hors-ligne de cet événement n’est pas préparée sur cet appareil.';
  if (e instanceof AccessRevokedError) return 'Vous n’avez plus accès au contrôle de ce collectif : la liste locale a été effacée. Contactez l’organisateur.';
  if (e instanceof SessionExpiredError) return 'Votre session a expiré : reconnectez-vous pour continuer le contrôle.';
  if (e instanceof OfflineDisabledError) return 'Le mode secours hors-ligne a été désactivé pour cet événement : la liste locale a été effacée. Le contrôle continue en ligne.';
  if (e instanceof OtherEventBlockedError) {
    return e.reason === 'pending'
      ? `Des passages de « ${e.title} » ne sont pas encore transmis : synchronisez-les avant de préparer un autre événement.`
      : `Des conflits de « ${e.title} » n’ont pas été consultés : ouvrez cet événement et prenez-en connaissance d’abord.`;
  }
  if (e instanceof SyncForbiddenError) return `Synchronisation refusée par le serveur : ${e.pending} passage(s) ne peuvent pas être confirmés. Contactez l’organisateur.`;
  if (e instanceof SessionChangedError) return 'Session terminée pendant l’opération : rien n’a été enregistré.';
  return errorMessage(e);
}
