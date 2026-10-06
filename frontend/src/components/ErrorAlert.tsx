import { errorMessage } from '../api/errors';

/** Affiche un message d'erreur compréhensible (jamais le détail technique). */
export function ErrorAlert({ error, title }: { error: unknown; title?: string }) {
  if (!error) return null;
  return (
    <div className="alert alert--error" role="alert">
      {title ? <strong>{title} </strong> : null}
      {errorMessage(error)}
    </div>
  );
}
