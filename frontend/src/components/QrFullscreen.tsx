import { useEffect, useRef } from 'react';
import { Icon } from './Icon';
import { QrCode } from './QrCode';

export type QrTicket = { id: string; qrPayload: string; ticketTypeName: string; publicId: string };

/**
 * QR plein écran pour le contrôle d'entrée : toujours sombre autour, code sur carte blanche, écran
 * maintenu allumé si possible, navigation entre les billets du même événement. Fonctionne sans réseau
 * (billets en cache, polices et icônes précachées).
 */
export function QrFullscreen({
  eventTitle,
  subtitle,
  tickets,
  index,
  onNavigate,
  onClose,
}: {
  eventTitle: string;
  subtitle: string;
  tickets: QrTicket[];
  index: number;
  onNavigate: (index: number) => void;
  onClose: () => void;
}) {
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

  const ticket = tickets[index];
  if (!ticket) return null;
  return (
    <div className="qr-full" role="dialog" aria-modal="true" aria-label={`Billet ${eventTitle}`}>
      <div className="qr-full__top">
        {/* eslint-disable-next-line jsx-a11y/no-autofocus -- le focus doit aller sur la seule action de la vue plein écran */}
        <button type="button" className="btn btn--small btn--secondary qr-full__close" onClick={onClose} autoFocus>
          <Icon name="close" size="sm" /> Fermer
        </button>
        <span className="qr-full__badge">
          <Icon name="wifi-off" size="sm" /> Fonctionne sans réseau
        </span>
      </div>
      <div className="qr-full__event">
        <p className="qr-full__event-title">{eventTitle}</p>
        <p>{subtitle}</p>
      </div>
      <div className="qr-full__code">
        <QrCode value={ticket.qrPayload} size={720} label={`QR code du billet ${ticket.ticketTypeName}`} />
        <div className="qr-full__ticket">
          <span className="qr-full__type">{ticket.ticketTypeName}</span>
          <span className="mono">{ticket.publicId}</span>
        </div>
      </div>
      {tickets.length > 1 ? (
        <nav className="qr-full__nav" aria-label="Billets de cet événement">
          <button type="button" className="btn btn--small" disabled={index === 0} onClick={() => onNavigate(index - 1)} aria-label="Billet précédent">
            <Icon name="chevron-left" />
          </button>
          <span aria-live="polite">
            Billet {index + 1} sur {tickets.length}
          </span>
          <button type="button" className="btn btn--small" disabled={index === tickets.length - 1} onClick={() => onNavigate(index + 1)} aria-label="Billet suivant">
            <Icon name="chevron-right" />
          </button>
        </nav>
      ) : null}
      <p className="qr-full__tip">
        <Icon name="info" />
        <span>Augmentez la luminosité de votre écran pour faciliter le scan.</span>
      </p>
    </div>
  );
}
