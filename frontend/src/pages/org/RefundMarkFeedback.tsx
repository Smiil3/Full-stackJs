import { errorMessage, isApiError } from '../../api/errors';
import type { PaymentMethod } from '../../api/types';
import { RetryLater } from '../../components/RetryLater';

/**
 * Retour de « Marquer comme effectué » (contrat v1.17 §7.3 bis) : pour une carte, le serveur interroge
 * d'abord le prestataire. 409 ⇒ déjà traité ou remboursement EN COURS chez le prestataire (ne pas
 * rembourser à la main) ; 503 ⇒ prestataire injoignable, nouvel essai après Retry-After.
 */
export function RefundMarkFeedback({ error, method, retryAt, onRetry, busy }: { error: unknown; method: PaymentMethod | null; retryAt: number | null; onRetry: () => void; busy: boolean }) {
  if (!error) return null;
  if (isApiError(error) && error.code === 'PAYMENT_PROVIDER_UNAVAILABLE' && retryAt !== null) {
    return (
      <RetryLater retryAt={retryAt} onRetry={onRetry} busy={busy}>
        Le prestataire de paiement est momentanément injoignable : impossible de vérifier ce remboursement pour l’instant. Rien n’a été modifié. Réessayez dans un instant.
      </RetryLater>
    );
  }
  return (
    <p className="alert alert--error" role="alert">
      {isApiError(error) && error.code === 'INVALID_STATE'
        ? method === 'CARD'
          ? 'Ce remboursement est en cours chez le prestataire de paiement, ou déjà effectué : ne remboursez pas à la main. La liste a été actualisée.'
          : 'Ce remboursement a déjà été traité. La liste a été actualisée.'
        : errorMessage(error)}
    </p>
  );
}
