import { BrowserQRCodeReader, type IScannerControls } from '@zxing/browser';
import { useEffect, useRef, useState } from 'react';

/** Même QR relu par la caméra pendant ce délai ⇒ ignoré (évite une avalanche de résultats). */
const SAME_CODE_DEBOUNCE_MS = 3000;

/**
 * Lecture continue des QR par la caméra arrière. `paused` : les lectures sont ignorées (résultat affiché).
 * Le flux vidéo est arrêté au démontage (pas de caméra laissée allumée).
 */
/** `onCode` renvoie false si la lecture a été ignorée (traitement en cours) : elle n'est alors pas mémorisée. */
export function CameraScanner({ onCode, paused }: { onCode: (text: string) => boolean; paused: boolean }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const onCodeRef = useRef(onCode);
  const pausedRef = useRef(paused);
  const last = useRef<{ text: string; at: number } | null>(null);
  // Absence d'API caméra (navigateur ancien, contexte non sécurisé) : connue dès le premier rendu.
  const [error, setError] = useState<string | null>(() =>
    typeof navigator.mediaDevices === 'object' && typeof navigator.mediaDevices.getUserMedia === 'function' ? null : 'Caméra indisponible sur cet appareil : utilisez la saisie manuelle.',
  );
  useEffect(() => {
    onCodeRef.current = onCode;
    pausedRef.current = paused;
  });

  useEffect(() => {
    const video = videoRef.current;
    if (!video || error) return;
    let controls: IScannerControls | null = null;
    let stopped = false;
    const reader = new BrowserQRCodeReader(undefined, { delayBetweenScanAttempts: 150 });
    reader
      .decodeFromConstraints({ video: { facingMode: { ideal: 'environment' } }, audio: false }, video, (result) => {
        if (!result || pausedRef.current) return;
        const text = result.getText();
        const now = Date.now();
        if (last.current && last.current.text === text && now - last.current.at < SAME_CODE_DEBOUNCE_MS) return;
        if (onCodeRef.current(text)) last.current = { text, at: now };
      })
      .then((c) => {
        if (stopped) c.stop();
        else controls = c;
      })
      .catch((e: unknown) => {
        const name = e instanceof Error ? e.name : '';
        setError(
          name === 'NotAllowedError'
            ? 'Accès à la caméra refusé. Autorisez la caméra dans les réglages du navigateur, ou utilisez la saisie manuelle.'
            : 'Impossible de démarrer la caméra : utilisez la saisie manuelle.',
        );
      });
    return () => {
      stopped = true;
      controls?.stop();
    };
    // Effet volontairement exécuté UNE seule fois (au montage) : relancer la caméra à chaque changement
    // de `error` couperait puis rouvrirait le flux vidéo (et redemanderait l'autorisation). Seule la
    // valeur initiale de `error` (API caméra absente) compte ; les callbacks passent par des refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- montage unique assumé, voir ci-dessus
  }, []);

  return (
    <div className="camera">
      <video ref={videoRef} className="camera__video" muted playsInline aria-label="Image de la caméra" />
      {error ? (
        <p className="alert alert--warning" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
