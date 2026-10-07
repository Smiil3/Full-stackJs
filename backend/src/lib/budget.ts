import { performance } from 'node:perf_hooks';

/**
 * Budget de temps d'un job du worker (audit M3) : le job s'arrête proprement entre deux unités de travail quand
 * le budget est épuisé ; le reste est repris au passage suivant. Temps monotone (indépendant de l'horloge métier).
 */
export class TimeBudget {
  private readonly end: number;

  constructor(ms: number) {
    this.end = performance.now() + ms;
  }

  /** Budget illimité (appels directs, tests). */
  static unlimited(): TimeBudget {
    return new TimeBudget(Number.POSITIVE_INFINITY);
  }

  exhausted(): boolean {
    return performance.now() >= this.end;
  }
}
