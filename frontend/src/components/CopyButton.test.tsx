import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CopyButton } from './CopyButton';

describe('CopyButton (revue F2.1 — B3)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('copie la valeur puis efface « Copié ! » après 2 s', async () => {
    vi.useFakeTimers();
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    render(<CopyButton value="NG-ABCD1234" label="la référence" />);
    await act(async () => {
      screen.getByRole('button', { name: 'Copier la référence' }).click();
      await Promise.resolve();
    });
    expect(writeText).toHaveBeenCalledWith('NG-ABCD1234');
    expect(screen.getByRole('status')).toHaveTextContent('Copié !');
    await act(() => vi.advanceTimersByTimeAsync(2100));
    expect(screen.getByRole('status')).toHaveTextContent('');
  });
});
