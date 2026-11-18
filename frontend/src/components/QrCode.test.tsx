import { render, screen, waitFor } from '@testing-library/react';
import QRCode from 'qrcode';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QrCode } from './QrCode';

describe('QrCode', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('laisse le CSS dimensionner le QR : aucune taille en ligne, donc jamais étiré', async () => {
    const draw = vi.spyOn(QRCode, 'toCanvas');
    render(<QrCode value="NG-QR-TEST" size={720} label="QR code du billet" />);
    await waitFor(() => expect(draw).toHaveBeenCalled());
    await draw.mock.results[0]?.value;
    const canvas = screen.getByRole('img', { name: 'QR code du billet' });
    // La librairie pose width/height en ligne ; un max-width CSS ne bride alors que la largeur (QR 320 × 720).
    await waitFor(() => expect(canvas.style.height).toBe(''));
    expect(canvas.style.width).toBe('');
    expect(canvas).toHaveAttribute('width', '720');
    expect(canvas).toHaveAttribute('height', '720');
  });
});
