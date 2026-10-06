import { useEffect, useId, useRef, type ReactNode } from 'react';

/** Boîte de confirmation explicite basée sur <dialog> (focus piégé et Échap gérés par le navigateur). */
export function ConfirmDialog(props: {
  open: boolean;
  title: string;
  children: ReactNode;
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
      <h2 id={titleId}>{props.title}</h2>
      <div className="dialog__body">{props.children}</div>
      <div className="dialog__actions">
        <button type="button" className="btn btn--secondary" onClick={props.onCancel} disabled={props.busy}>
          {props.cancelLabel ?? 'Annuler'}
        </button>
        <button type="button" className={`btn ${props.danger ? 'btn--danger' : ''}`} onClick={props.onConfirm} disabled={props.busy || props.confirmDisabled}>
          {props.busy ? 'Patientez…' : props.confirmLabel}
        </button>
      </div>
    </dialog>
  );
}
