import { useEffect, useId, useRef, type ReactNode } from 'react';
import { Icon, type IconName } from './Icon';

/**
 * Boîte de confirmation explicite basée sur <dialog> (focus piégé et Échap gérés par le navigateur).
 * Action destructive : le bouton PRUDENT est l'action principale, le bouton destructif est en bordeaux.
 * `consequences` : ce qui va se passer, avec les chiffres (liste à icônes).
 */
export function ConfirmDialog(props: {
  open: boolean;
  title: string;
  children?: ReactNode;
  consequences?: ReactNode[];
  icon?: IconName;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
  busy?: boolean;
  confirmDisabled?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (props.open && !d.open) {
      if (typeof d.showModal === 'function') d.showModal();
      else d.setAttribute('open', '');
    } else if (!props.open && d.open) {
      if (typeof d.close === 'function') d.close();
      else d.removeAttribute('open');
    }
  }, [props.open]);
  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        props.onCancel();
      }}
    >
      <div className="stack">
        <div className="dialog__head">
          <span className="dialog__icon">
            <Icon name={props.icon ?? (props.danger ? 'alert-triangle' : 'info')} size="lg" />
          </span>
          <h2 id={titleId} className="dialog__title">
            {props.title}
          </h2>
        </div>
        {props.consequences && props.consequences.length > 0 ? (
          <ul className="dialog__consequences">
            {props.consequences.map((c, i) => (
              <li key={i}>
                <Icon name="arrow-right" size="sm" />
                <span>{c}</span>
              </li>
            ))}
          </ul>
        ) : null}
        {props.children ? <div className="stack stack--sm">{props.children}</div> : null}
        <div className="dialog__actions">
          <button type="button" className={props.danger ? 'btn' : 'btn btn--secondary'} onClick={props.onCancel} disabled={props.busy}>
            {props.cancelLabel ?? 'Annuler'}
          </button>
          <button type="button" className={props.danger ? 'btn btn--danger' : 'btn'} onClick={props.onConfirm} disabled={props.busy || props.confirmDisabled}>
            {props.busy ? 'Patientez…' : props.confirmLabel}
          </button>
        </div>
      </div>
    </dialog>
  );
}
