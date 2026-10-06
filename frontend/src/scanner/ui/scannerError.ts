import { errorMessage } from '../../api/errors';
import { EventNotAvailableError, NoSnapshotError } from '../engine';

export function scannerErrorMessage(e: unknown): string {
  if (e instanceof EventNotAvailableError) return 'Événement non disponible au contrôle (non publié, annulé ou terminé depuis plus de 24 h).';
  if (e instanceof NoSnapshotError) return 'La liste hors-ligne de cet événement n’est pas préparée sur cet appareil.';
  return errorMessage(e);
}
