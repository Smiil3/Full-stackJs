import { useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import type { ScanOutcome } from '../engine';
import { Icon } from '../../components/Icon';
import { describeOutcome } from './describeOutcome';

/**
 * Délai pendant lequel Entrée / Espace sont ignorés après l'affichage d'un résultat : une douchette
 * (lecteur clavier « code + Entrée ») qui enchaîne les codes ne doit jamais fermer ni valider un
 * résultat que personne n'a vu.
 */
export const KEY_GUARD_MS = 1500;

/** Résultat plein écran, très lisible ; annoncé immédiatement aux lecteurs d'écran. */
export function ResultOverlay(props: {
  outcome: ScanOutcome;
  timezone: string;
  eventTitle: string;
  /** Bandeau hors-ligne PERMANENT tant que le réseau n'est pas revenu. */
  banner?: string | null;
  autoCloseSeconds?: number;
  onClose: () => void;
  onAdmit: () => void;
  busy: boolean;
}) {
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

  // Rôles (HANDOFF § 6.3) : entrée = status, refus = alert, décision humaine = dialogue modal.
  const role = decision ? 'alertdialog' : v.tone === 'ok' ? 'status' : 'alert';
  return (
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- raccourci Entrée de la douchette sur le résultat
    <section
      className={`scan-result scan-result--${v.tone}`}
      role={role}
      aria-modal={decision ? true : undefined}
      aria-labelledby="scan-result-title"
      aria-describedby="scan-result-line"
      onKeyDown={onKeyDown}
    >
      <header className="scan-topbar">
        <span>{props.eventTitle}</span>
        {props.outcome.offline ? <span>Vérifié hors-ligne</span> : null}
      </header>
      {props.banner ? (
        <div className="scan-banner" role="status">
          <Icon name="wifi-off" />
          <span>{props.banner}</span>
        </div>
      ) : null}
      <div className="scan-result__view">
        <div className="scan-result__frame">
          <span className="scan-result__icon">
            <Icon name={v.icon} />
          </span>
        </div>
      </div>
      <div className="scan-result__sheet">
        <p id="scan-result-title" ref={titleRef} tabIndex={-1} className="scan-result__title">
          {v.title}
        </p>
        <p id="scan-result-line" className="scan-result__line">
          {v.line}
        </p>
        {v.detail ? <p className="scan-result__detail">{v.detail}</p> : null}
        {decision ? (
          <>
            <div className="scan-result__actions">
              <button
                type="button"
                className="btn"
                disabled={props.busy}
                onPointerDown={() => {
                  pointerOnAdmit.current = true;
                }}
                onClick={admit}
              >
                Laisser entrer
              </button>
              <button type="button" className="btn btn--secondary" onClick={props.onClose}>
                Refuser
              </button>
            </div>
            <p className="scan-result__foot">Appuyez sur l’écran pour laisser entrer.</p>
          </>
        ) : (
          <>
            <div className="scan-result__actions">
              <button type="button" className="btn btn--secondary" disabled={!armed} onClick={close}>
                Scanner le suivant
              </button>
            </div>
            {v.tone === 'ok' && props.autoCloseSeconds ? <p className="scan-result__foot">Retour à la caméra dans {props.autoCloseSeconds} s</p> : null}
          </>
        )}
      </div>
    </section>
  );
}
