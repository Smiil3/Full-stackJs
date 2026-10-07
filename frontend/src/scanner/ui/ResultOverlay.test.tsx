import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ScanOutcome } from '../engine';
import { KEY_GUARD_MS, ResultOverlay } from './ResultOverlay';

/**
 * Garde clavier (F6-H3) au niveau du composant : horloge FIGÉE puis avancée exactement, rappels
 * synchrones (onAdmit / onClose), sans réseau ni IndexedDB ⇒ déterministe sur une machine chargée.
 */
const decision: ScanOutcome = {
  kind: 'UNKNOWN_AUTHENTIC',
  offline: true,
  reason: 'offline',
  pending: { orgId: 'o', eventId: 'e', qrPayload: 'NG1.e.p.s', scanId: 's', publicId: 'p', owner: 'w' },
};
const refusal: ScanOutcome = { kind: 'INVALID', offline: false };

function setup(outcome: ScanOutcome) {
  const t0 = 10_000;
  const clock = vi.spyOn(performance, 'now').mockReturnValue(t0);
  const onAdmit = vi.fn();
  const onClose = vi.fn();
  render(<ResultOverlay outcome={outcome} timezone="Europe/Paris" eventTitle="Concert" busy={false} onAdmit={onAdmit} onClose={onClose} />);
  return { onAdmit, onClose, advance: (ms: number) => clock.mockReturnValue(t0 + ms) };
}
const press = (key: string, target: Element = document.activeElement ?? document.body) => fireEvent.keyDown(target, { key });

describe('ResultOverlay — garde clavier et admission au seul pointeur', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('focus sur le TITRE à l’affichage, jamais sur « Laisser entrer »', () => {
    setup(decision);
    expect(document.activeElement?.id).toBe('scan-result-title');
  });

  it('refus : Entrée ignorée jusqu’à la dernière milliseconde du délai, puis ferme', () => {
    const { onClose, advance } = setup(refusal);
    press('Enter');
    advance(KEY_GUARD_MS - 1);
    press('Enter');
    expect(onClose).not.toHaveBeenCalled();
    advance(KEY_GUARD_MS);
    press('Enter');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Entrée / Espace bloqués (preventDefault) pendant le délai, n’importe où dans la page', () => {
    const { advance } = setup(refusal);
    const blocked = (key: string) => !fireEvent.keyDown(document.body, { key, cancelable: true });
    expect(blocked('Enter')).toBe(true);
    expect(blocked(' ')).toBe(true);
    expect(blocked('a')).toBe(false); // les autres touches passent
    advance(KEY_GUARD_MS);
    expect(blocked('Enter')).toBe(false);
  });

  it('« Laisser entrer » : jamais par le clavier (avant ou après le délai), seulement par un appui pointeur', async () => {
    const { onAdmit, advance } = setup(decision);
    const admit = screen.getByRole('button', { name: 'Laisser entrer' });
    admit.focus();
    const user = userEvent.setup();
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    advance(KEY_GUARD_MS * 3);
    admit.focus();
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    fireEvent.click(admit); // clic synthétique sans pointeur (detail = 0)
    expect(onAdmit).not.toHaveBeenCalled();
    await user.click(admit); // vrai appui : pointerdown puis click
    expect(onAdmit).toHaveBeenCalledTimes(1);
  });

  it('« Scanner le suivant » reste désactivé tant que l’horloge ne confirme pas la fin du délai', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { advance } = setup(refusal);
      const next = screen.getByRole('button', { name: 'Scanner le suivant' });
      await act(() => vi.advanceTimersByTimeAsync(KEY_GUARD_MS * 2)); // minuteurs écoulés, horloge figée
      expect(next).toBeDisabled();
      advance(KEY_GUARD_MS);
      await act(() => vi.advanceTimersByTimeAsync(KEY_GUARD_MS));
      expect(screen.getByRole('button', { name: 'Scanner le suivant' })).toBeEnabled();
    } finally {
      vi.useRealTimers();
    }
  });
});
