/**
 * Horloge de l'application : tous les calculs métier datés (early, expiration, annulation, scan)
 * passent par ici, ce qui permet aux tests de se placer à 1 ms d'une borne sans attendre.
 */
let offsetMs = 0;
let frozen: number | null = null;

export const clock = {
  now(): Date {
    return new Date(frozen ?? Date.now() + offsetMs);
  },
};

/** Réservé aux tests. */
export const testClock = {
  freeze(at: Date): void {
    frozen = at.getTime();
  },
  shift(ms: number): void {
    offsetMs += ms;
  },
  reset(): void {
    offsetMs = 0;
    frozen = null;
  },
};
