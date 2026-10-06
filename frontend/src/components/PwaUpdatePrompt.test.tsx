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
});
