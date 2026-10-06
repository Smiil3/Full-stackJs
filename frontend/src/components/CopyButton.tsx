import { useEffect, useState } from 'react';

const RESET_MS = 2000;

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
        Copier
      </button>
      <span role="status" className="muted">
        {state === 'ok' ? 'Copié !' : state === 'ko' ? 'Copie impossible : sélectionnez le texte.' : ''}
      </span>
    </>
  );
}
