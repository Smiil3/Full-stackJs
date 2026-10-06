import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

const update = vi.fn(() => Promise.resolve());
const registered = vi.fn();
vi.mock('virtual:pwa-register/react', () => ({
  useRegisterSW: (opts: unknown) => {
    registered(opts);
    return { needRefresh: [true, vi.fn()], offlineReady: [false, vi.fn()], updateServiceWorker: update };
  },
}));

describe('service worker (revue F1.1 — B2)', () => {
  it('s’enregistre immédiatement et propose la mise à jour sans recharger d’office', async () => {
    const { PwaUpdatePrompt } = await import('./PwaUpdatePrompt');
    render(<PwaUpdatePrompt />);
    expect(registered).toHaveBeenCalledWith(expect.objectContaining({ immediate: true }));
    expect(update).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Mettre à jour' }));
    expect(update).toHaveBeenCalledWith(true);
  });

  it('F6-B7 : recherche de mise à jour toutes les 30 min quand visible, rattrapage au retour au premier plan', async () => {
    const { startPeriodicUpdate, UPDATE_CHECK_MS } = await import('../lib/pwaUpdate');
    vi.useFakeTimers();
    let visibility: DocumentVisibilityState = 'visible';
    const spy = vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
    const reg = { update: vi.fn(() => Promise.resolve()) };
    const stop = startPeriodicUpdate(reg);
    try {
      await vi.advanceTimersByTimeAsync(UPDATE_CHECK_MS);
      expect(reg.update).toHaveBeenCalledTimes(1);
      visibility = 'hidden';
      await vi.advanceTimersByTimeAsync(2 * UPDATE_CHECK_MS);
      expect(reg.update).toHaveBeenCalledTimes(1); // arrière-plan : aucune requête
      visibility = 'visible';
      document.dispatchEvent(new Event('visibilitychange'));
      expect(reg.update).toHaveBeenCalledTimes(2); // retour au premier plan après plus de 30 min
      document.dispatchEvent(new Event('visibilitychange'));
      expect(reg.update).toHaveBeenCalledTimes(2); // pas plus d'une fois par période
    } finally {
      stop();
      spy.mockRestore();
      vi.useRealTimers();
    }
  });
});
