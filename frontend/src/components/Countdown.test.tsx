import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Countdown, EXPIRED_RETRY_MS } from './Countdown';

describe('Countdown (revue F2.1 — M3)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('échéance passée ⇒ onExpire appelé puis relancé périodiquement', async () => {
    vi.useFakeTimers();
    const onExpire = vi.fn();
    render(<Countdown until={new Date(Date.now() - 1000).toISOString()} label="Reste" onExpire={onExpire} />);
    expect(screen.getByText('délai écoulé')).toBeInTheDocument();
    expect(onExpire).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(EXPIRED_RETRY_MS * 2 + 10));
    expect(onExpire).toHaveBeenCalledTimes(3);
  });

  it('réarmé quand l’échéance change (nouvelle offre / prolongation)', async () => {
    vi.useFakeTimers();
    const onExpire = vi.fn();
    const past = new Date(Date.now() - 1000).toISOString();
    const { rerender } = render(<Countdown until={past} label="Reste" onExpire={onExpire} />);
    expect(onExpire).toHaveBeenCalledTimes(1);
    const soon = new Date(Date.now() + 2000).toISOString();
    rerender(<Countdown until={soon} label="Reste" onExpire={onExpire} />);
    await act(() => vi.advanceTimersByTimeAsync(EXPIRED_RETRY_MS + 3000));
    expect(screen.getByText('délai écoulé')).toBeInTheDocument();
    expect(onExpire.mock.calls.length).toBeGreaterThanOrEqual(2); // ré-appelé à la nouvelle échéance
  });

  it('pas d’appel avant l’échéance', async () => {
    vi.useFakeTimers();
    const onExpire = vi.fn();
    render(<Countdown until={new Date(Date.now() + 60_000).toISOString()} label="Reste" onExpire={onExpire} />);
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(onExpire).not.toHaveBeenCalled();
  });
});
