import QRCode from 'qrcode';
import { useEffect, useRef, useState } from 'react';

/** QR dessiné dans un <canvas> (pas d'injection HTML/SVG, compatible CSP stricte). */
export function QrCode({ value, size = 260, label }: { value: string; size?: number; label: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    QRCode.toCanvas(canvas, value, { width: size, margin: 2, errorCorrectionLevel: 'M', color: { dark: '#000000', light: '#ffffff' } }).catch(() => {
      setFailed(true);
    });
  }, [value, size]);
  if (failed) return <p className="alert alert--error">QR code impossible à afficher.</p>;
  return <canvas ref={ref} role="img" aria-label={label} className="qr" width={size} height={size} />;
}
