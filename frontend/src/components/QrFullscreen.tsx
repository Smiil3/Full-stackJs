import { useEffect, useRef } from 'react';
import { QrCode } from './QrCode';

/**
 * QR plein écran pour le contrôle d'entrée : grand, contrasté, écran maintenu allumé si possible.
 */
export function QrFullscreen({ value, title, subtitle, onClose }: { value: string; title: string; subtitle: string; onClose: () => void }) {
  // `onClose` est souvent une fonction inline : on la lit par référence pour ne pas rejouer l'effet.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    let lock: WakeLockSentinel | null = null;
    let disposed = false;
    const acquire = () => {
      if (!('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
      navigator.wakeLock
        .request('screen')
        .then((l) => {
          if (disposed) void l.release();
          else lock = l;
        })
        .catch(() => undefined);
    };
    // Le navigateur libère le verrou quand la page passe en arrière-plan : on le redemande au retour.
    const onVisibility = () => {
      if (document.visibilityState === 'visible') acquire();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCloseRef.current();
    };
    acquire();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('keydown', onKey);
    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('keydown', onKey);
      void lock?.release();
    };
  }, []);

  return (
    <div className="qr-full" role="dialog" aria-modal="true" aria-label={`Billet ${title}`}>
      <p className="qr-full__title">{title}</p>
      <p className="qr-full__subtitle">{subtitle}</p>
      <QrCode value={value} size={720} label={`QR code du billet ${title}`} />
      <p className="qr-full__hint">Augmentez la luminosité de votre écran pour faciliter le scan.</p>
      {/* eslint-disable-next-line jsx-a11y/no-autofocus -- le focus doit aller sur la seule action de la vue plein écran */}
      <button type="button" className="btn btn--block" onClick={onClose} autoFocus>
        Fermer
      </button>
    </div>
  );
}
