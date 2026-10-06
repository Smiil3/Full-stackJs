import { useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import type { ScanOutcome } from '../engine';
import { describeOutcome } from './describeOutcome';

/**
 * Délai pendant lequel Entrée / Espace sont ignorés après l'affichage d'un résultat : une douchette
 * (lecteur clavier « code + Entrée ») qui enchaîne les codes ne doit jamais fermer ni valider un
 * résultat que personne n'a vu.
 */
export const KEY_GUARD_MS = 1500;

/** Résultat plein écran, très lisible ; annoncé immédiatement aux lecteurs d'écran. */
export function ResultOverlay(props: { outcome: ScanOutcome; timezone: string; onClose: () => void; onAdmit: () => void; busy: boolean }) {
  const v = describeOutcome(props.outcome, props.timezone);
  const decision = props.outcome.kind === 'UNKNOWN_AUTHENTIC';
  const titleRef = useRef<HTMLParagraphElement>(null);
  const armedRef = useRef(false);
  // Résultat pour lequel le délai de garde est écoulé (un nouveau résultat repart désarmé).
  const [armedFor, setArmedFor] = useState<ScanOutcome | null>(null);
  const armed = armedFor === props.outcome;
  const pointerOnAdmit = useRef(false);

  // Chaque nouveau résultat : focus sur le TITRE (jamais sur « Laisser entrer »), délai de garde réarmé.
  // Effets « layout » : actifs dès l'affichage, avant qu'une touche de la douchette puisse être traitée.
  useLayoutEffect(() => {
    const outcome = props.outcome;
    armedRef.current = false;
    titleRef.current?.focus();
    const t = setTimeout(() => {
      armedRef.current = true;
      setArmedFor(outcome);
    }, KEY_GUARD_MS);
    return () => {
      clearTimeout(t);
    };
  }, [props.outcome]);

  // Pendant le délai de garde, Entrée / Espace n'atteignent aucun élément de la page.
  useLayoutEffect(() => {
    const swallow = (e: globalThis.KeyboardEvent) => {
      if (!armedRef.current && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    document.addEventListener('keydown', swallow, true);
    return () => {
      document.removeEventListener('keydown', swallow, true);
    };
  }, []);

  const close = () => {
    if (armedRef.current) props.onClose();
  };

  // Après le délai, Entrée ferme un résultat sans décision ; une décision exige un appui à l'écran.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' && e.target === titleRef.current && !decision) close();
  };

  // « Laisser entrer » : uniquement un clic / tap réel (pointeur), jamais une touche du clavier.
  const admit = (e: MouseEvent<HTMLButtonElement>) => {
    const fromPointer = pointerOnAdmit.current;
    pointerOnAdmit.current = false;
    if (!fromPointer || e.detail === 0) return;
    props.onAdmit();
  };

  return (
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- raccourci Entrée de la douchette sur le dialogue
    <div className={`scan-result scan-result--${v.tone}`} role="alertdialog" aria-modal="true" aria-labelledby="scan-result-title" aria-describedby={v.detail ? 'scan-result-detail' : undefined} onKeyDown={onKeyDown}>
      <p id="scan-result-title" ref={titleRef} tabIndex={-1} className="scan-result__title">
        {v.title}
      </p>
      {v.detail ? (
        <p id="scan-result-detail" className="scan-result__detail">
          {v.detail}
        </p>
      ) : null}
      {props.outcome.offline ? <p className="scan-result__mode">Vérifié hors-ligne</p> : null}
      {decision ? (
        <div className="scan-result__actions">
          <button
            type="button"
            className="btn btn--block scan-result__btn"
            disabled={props.busy}
            onPointerDown={() => {
              pointerOnAdmit.current = true;
            }}
            onClick={admit}
          >
            Laisser entrer
          </button>
          <p className="scan-result__mode">Appuyez sur l’écran pour laisser entrer.</p>
          <button type="button" className="btn btn--block btn--secondary scan-result__btn" onClick={props.onClose}>
            Refuser
          </button>
        </div>
      ) : (
        <button type="button" className="btn btn--block scan-result__btn" disabled={!armed} onClick={close}>
          Scanner le suivant
        </button>
      )}
    </div>
  );
}
