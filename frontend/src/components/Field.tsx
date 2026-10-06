import { useId, type InputHTMLAttributes } from 'react';

type Props = InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string; error?: string | undefined };

/** Champ accessible : label associé, aide et erreur reliées par aria-describedby. */
export function Field({ label, hint, error, id, ...input }: Props) {
  const autoId = useId();
  const fieldId = id ?? autoId;
  const hintId = hint ? `${fieldId}-hint` : undefined;
  const errorId = error ? `${fieldId}-error` : undefined;
  return (
    <div className="field">
      <label htmlFor={fieldId}>{label}</label>
      <input id={fieldId} aria-invalid={error ? true : undefined} aria-describedby={[hintId, errorId].filter(Boolean).join(' ') || undefined} {...input} />
      {hint ? (
        <span id={hintId} className="field__hint">
          {hint}
        </span>
      ) : null}
      {error ? (
        <span id={errorId} className="field__error">
          {error}
        </span>
      ) : null}
    </div>
  );
}
