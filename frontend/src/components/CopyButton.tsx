import { useEffect, useState } from 'react';
import { Icon } from './Icon';

const RESET_MS = 2000;

/** « Copier » devient « Copié » (icône check) pendant 2 s, avec une annonce polie aux lecteurs d'écran. */
export function CopyButton({ value, label }: { value: string; label: string }) {
  const [state, setState] = useState<'idle' | 'ok' | 'ko'>('idle');
  useEffect(() => {
    if (state === 'idle') return;
    const timer = setTimeout(() => {
      setState('idle');
    }, RESET_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [state]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setState('ok');
    } catch {
      setState('ko');
    }
  };
  return (
    <>
      <button type="button" className="btn btn--secondary btn--small" onClick={() => void copy()} aria-label={`Copier ${label}`}>
        {state === 'ok' ? (
          <>
            <Icon name="check" size="sm" /> Copié
          </>
        ) : (
          'Copier'
        )}
      </button>
      <span role="status" aria-live="polite" className="visually-hidden">
        {state === 'ok' ? 'Copié !' : state === 'ko' ? 'Copie impossible : sélectionnez le texte.' : ''}
      </span>
      {state === 'ko' ? <span className="field__hint">Copie impossible : sélectionnez le texte.</span> : null}
    </>
  );
}
