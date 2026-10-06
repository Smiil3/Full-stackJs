import type { ScanOutcome } from '../engine';
import { describeOutcome } from './describeOutcome';

/** Résultat plein écran, très lisible ; annoncé immédiatement aux lecteurs d'écran. */
export function ResultOverlay(props: { outcome: ScanOutcome; timezone: string; onClose: () => void; onAdmit: () => void; busy: boolean }) {
  const v = describeOutcome(props.outcome, props.timezone);
  const decision = props.outcome.kind === 'UNKNOWN_AUTHENTIC';
  return (
    <div className={`scan-result scan-result--${v.tone}`} role="alertdialog" aria-modal="true" aria-labelledby="scan-result-title" aria-describedby="scan-result-detail">
      <p id="scan-result-title" className="scan-result__title">
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
          <button type="button" className="btn btn--block scan-result__btn" disabled={props.busy} onClick={props.onAdmit}>
            Laisser entrer
          </button>
          <button type="button" className="btn btn--block btn--secondary scan-result__btn" onClick={props.onClose}>
            Refuser
          </button>
        </div>
      ) : (
        <button type="button" className="btn btn--block scan-result__btn" onClick={props.onClose}>
          Scanner le suivant
        </button>
      )}
    </div>
  );
}
