import { describe, expect, it } from 'vitest';
import { SAME_CODE_QUIET_MS, SameCodeFilter } from './sameCodeFilter';

describe('anti-doublon caméra (audit M4)', () => {
  it('billet laissé devant la caméra : jamais relu pendant le résultat ni 3 s après sa fermeture', () => {
    const f = new SameCodeFilter();
    expect(f.seen('A', 0, false)).toBe(true);
    f.accepted('A', 0);
    // Réponse réseau lente puis résultat affiché 2,5 s : le code est relu en continu.
    for (let t = 150; t <= 4000; t += 150) expect(f.seen('A', t, true)).toBe(false);
    f.closed(4000); // fermeture du résultat (bien après la 1re lecture)
    // Toujours devant la caméra : ignoré tant qu'il est lu en continu…
    for (let t = 4150; t <= 9000; t += 150) expect(f.seen('A', t, false)).toBe(false);
  });

  it('délai de calme mesuré depuis la fermeture du résultat, pas depuis la 1re lecture', () => {
    const f = new SameCodeFilter();
    f.seen('A', 0, false);
    f.accepted('A', 0);
    f.closed(5000); // résultat fermé 5 s après la lecture (réseau lent)
    expect(f.seen('A', 5000 + SAME_CODE_QUIET_MS - 1, false)).toBe(false); // relu juste avant la fin du délai
    expect(f.seen('A', 5000 + 2 * SAME_CODE_QUIET_MS, false)).toBe(true); // retiré puis représenté plus tard
  });

  it('code retiré du champ puis représenté après le délai ⇒ traité (vraie 2e présentation)', () => {
    const f = new SameCodeFilter();
    f.seen('A', 0, false);
    f.accepted('A', 0);
    f.closed(2500);
    expect(f.seen('A', 2500 + SAME_CODE_QUIET_MS, false)).toBe(true);
  });

  it('un autre billet passe immédiatement ; aucune lecture pendant l’affichage d’un résultat', () => {
    const f = new SameCodeFilter();
    f.seen('A', 0, false);
    f.accepted('A', 0);
    expect(f.seen('B', 100, true)).toBe(false); // résultat affiché
    f.closed(200);
    expect(f.seen('B', 250, false)).toBe(true);
  });

  it('lecture non prise en compte (traitement déjà en cours) ⇒ pas mémorisée', () => {
    const f = new SameCodeFilter();
    expect(f.seen('A', 0, false)).toBe(true); // onCode a refusé : accepted() pas appelé
    expect(f.seen('A', 100, false)).toBe(true);
  });
});
