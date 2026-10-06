import { useEffect } from 'react';
import { QrCode } from './QrCode';

/**
 * QR plein écran pour le contrôle d'entrée : grand, contrasté, écran maintenu allumé si possible.
 */
export function QrFullscreen({ value, title, subtitle, onClose }: { value: string; title: string; subtitle: string; onClose: () => void }) {
  useEffect(() => {
    let lock: WakeLockSentinel | null = null;
    let cancelled = false;
    if ('wakeLock' in navigator) {
      navigator.wakeLock
        .request('screen')
        .then((l) => {
          if (cancelled) void l.release();
          else lock = l;
        })
        .catch(() => undefined);
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      cancelled = true;
      window.removeEventListener('keydown', onKey);
      void lock?.release();
    };
  }, [onClose]);

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
