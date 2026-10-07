import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CameraScanner } from './CameraScanner';

/** Lecteur ZXing simulé : on garde le rappel de décodage pour y injecter des lectures. */
const decoder: { emit: ((text: string) => void) | null; stop: ReturnType<typeof vi.fn> } = { emit: null, stop: vi.fn() };
vi.mock('@zxing/browser', () => ({
  BrowserQRCodeReader: class {
    decodeFromConstraints(_c: unknown, _v: unknown, cb: (r: { getText: () => string } | undefined) => void) {
      decoder.emit = (text) => {
        cb({ getText: () => text });
      };
      return Promise.resolve({ stop: decoder.stop });
    }
  },
}));

describe('CameraScanner : câblage de l’anti-doublon (audit n° 2, B\'2)', () => {
  let now = 1_000_000;
  beforeEach(() => {
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn() } });
    vi.spyOn(Date, 'now').mockImplementation(() => now);
  });
  afterEach(() => {
    Reflect.deleteProperty(navigator, 'mediaDevices');
    decoder.emit = null;
  });

  /** Lecture du `text` à l'instant courant + `afterMs`. */
  const read = (text: string, afterMs: number) => {
    now += afterMs;
    act(() => {
      decoder.emit?.(text);
    });
  };

  it('billet laissé devant la caméra ⇒ un seul passage ; re-présenté ⇒ scanné de nouveau ; jamais pendant un résultat', async () => {
    const onCode = vi.fn(() => true);
    const { rerender } = render(<CameraScanner onCode={onCode} paused={false} />);
    await vi.waitFor(() => expect(decoder.emit).not.toBeNull());

    read('NG1.A', 0);
    expect(onCode).toHaveBeenCalledTimes(1);
    rerender(<CameraScanner onCode={onCode} paused />); // résultat affiché
    for (let i = 0; i < 10; i++) read('NG1.A', 150); // toujours dans le champ pendant le résultat
    read('NG1.B', 150); // un autre billet pendant le résultat : ignoré
    rerender(<CameraScanner onCode={onCode} paused={false} />); // résultat fermé
    for (let i = 0; i < 10; i++) read('NG1.A', 150); // toujours dans le champ après la fermeture
    expect(onCode).toHaveBeenCalledTimes(1);

    read('NG1.A', 1500); // retiré puis re-présenté (capture partagée) : jamais un silence
    expect(onCode).toHaveBeenCalledTimes(2);
    expect(onCode).toHaveBeenLastCalledWith('NG1.A');
    read('NG1.B', 150); // un autre billet passe aussitôt
    expect(onCode).toHaveBeenLastCalledWith('NG1.B');
  });

  it('lecture refusée par la page (traitement en cours) ⇒ non mémorisée : la suivante est transmise', async () => {
    const onCode = vi.fn().mockReturnValueOnce(false).mockReturnValue(true);
    render(<CameraScanner onCode={onCode} paused={false} />);
    await vi.waitFor(() => expect(decoder.emit).not.toBeNull());
    read('NG1.A', 0);
    read('NG1.A', 150);
    expect(onCode).toHaveBeenCalledTimes(2);
  });
});
