import { errorMessage, isApiError } from '../api/errors';
import { Icon } from './Icon';

/** Échecs de chargement dus au réseau ou au serveur : message rassurant (HANDOFF § 7), jamais de code. */
const LOAD_CODES = new Set(['NETWORK_ERROR', 'TIMEOUT', 'INTERNAL_ERROR', 'UNEXPECTED_RESPONSE']);
export const LOAD_FAILED_MESSAGE = 'La page n’a pas pu se charger. Ça arrive, souvent à cause du réseau. Vos billets ne sont pas concernés.';

/**
 * Message d'erreur compréhensible (jamais le détail technique). `onRetry` : erreur de CHARGEMENT ⇒ texte
 * rassurant + bouton « Réessayer » ; sinon le message correspondant au code d'erreur du contrat.
 */
export function ErrorAlert({ error, title, onRetry }: { error: unknown; title?: string; onRetry?: () => void }) {
  if (!error) return null;
  const loadFailure = onRetry !== undefined && (!isApiError(error) || LOAD_CODES.has(error.code));
  return (
    <div className="alert alert--error" role="alert">
      <Icon name="info" />
      <div className="stack stack--sm">
        <p>
          {title ? <strong>{title} </strong> : null}
          {loadFailure ? LOAD_FAILED_MESSAGE : errorMessage(error)}
        </p>
        {onRetry ? (
          <p>
            <button type="button" className="btn btn--secondary btn--small" onClick={onRetry}>
              <Icon name="retry" size="sm" /> Réessayer
            </button>
          </p>
        ) : null}
      </div>
    </div>
  );
}
