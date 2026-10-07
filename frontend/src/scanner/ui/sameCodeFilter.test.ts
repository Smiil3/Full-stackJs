import { describe, expect, it } from 'vitest';
import { CONTINUOUS_READ_GAP_MS, SameCodeFilter } from './sameCodeFilter';

/** Lectures successives du même code toutes les 150 ms (cadence de la caméra) entre `from` et `to`. */
function readContinuously(f: SameCodeFilter, text: string, from: number, to: number, paused: boolean): boolean[] {
  const out: boolean[] = [];
  for (let t = from; t <= to; t += 150) out.push(f.seen(text, t, paused));
  return out;
}

describe('anti-doublon caméra (audits M4, n° 2 B\'2)', () => {
  it('billet laissé devant la caméra : jamais relu, ni pendant le résultat, ni après sa fermeture', () => {
    const f = new SameCodeFilter();
    expect(f.seen('A', 0, false)).toBe(true);
    f.accepted('A', 0);
    expect(readContinuously(f, 'A', 150, 4000, true).every((r) => !r)).toBe(true); // résultat affiché (réseau lent)
    expect(readContinuously(f, 'A', 4150, 9000, false).every((r) => !r)).toBe(true); // résultat fermé, toujours dans le champ
  });

  it('B\'2 : même QR retiré puis re-présenté (capture partagée) ⇒ scanné de nouveau, même 1 s après la fermeture', () => {
    const f = new SameCodeFilter();
    f.seen('A', 0, false);
    f.accepted('A', 0);
    readContinuously(f, 'A', 150, 2500, true); // 1er porteur : résultat affiché pendant qu'il est lu
    // Sorti du champ à 2,5 s ; le 2nd porteur le présente à 3,6 s (résultat fermé à 2,6 s).
    expect(f.seen('A', 2500 + CONTINUOUS_READ_GAP_MS + 100, false)).toBe(true);
  });

  it('frontière : lecture 999 ms après la précédente ⇒ toujours dans le champ ; 1000 ms ⇒ re-présenté', () => {
    const f = new SameCodeFilter();
    f.seen('A', 0, false);
    f.accepted('A', 0);
    expect(f.seen('A', CONTINUOUS_READ_GAP_MS - 1, false)).toBe(false);
    expect(f.seen('A', 2 * CONTINUOUS_READ_GAP_MS - 1, false)).toBe(true);
  });

  it('un autre billet passe dès que le résultat est fermé ; rien n’est lu pendant l’affichage d’un résultat', () => {
    const f = new SameCodeFilter();
    f.seen('A', 0, false);
    f.accepted('A', 0);
    expect(f.seen('B', 100, true)).toBe(false);
    expect(f.seen('B', 250, false)).toBe(true);
  });

  it('lecture refusée par la page (traitement en cours) ⇒ pas mémorisée, la suivante est traitée', () => {
    const f = new SameCodeFilter();
    expect(f.seen('A', 0, false)).toBe(true); // onCode a refusé : accepted() pas appelé
    expect(f.seen('A', 100, false)).toBe(true);
  });
});
