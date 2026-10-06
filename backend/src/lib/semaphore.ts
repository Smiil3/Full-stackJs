import { AppError } from './errors.js';

/**
 * Sémaphore à file bornée : au plus `max` tâches simultanées, au plus `maxQueue` en attente ;
 * au-delà, 429 immédiat (un afflux de calculs coûteux ne sature ni la mémoire ni le CPU).
 */
export class Semaphore {
  private active = 0;
  private readonly queue: (() => void)[] = [];

  constructor(private readonly max: number, private readonly maxQueue: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) {
      if (this.queue.length >= this.maxQueue) {
        throw new AppError(429, 'RATE_LIMITED', 'Serveur occupé, veuillez réessayer.', { retryAfterSeconds: 1 });
      }
      await new Promise<void>((resolve) => this.queue.push(resolve));
    } else {
      this.active += 1;
    }
    try {
      return await task();
    } finally {
      const next = this.queue.shift();
      // Le jeton est transmis directement à la tâche suivante (active inchangé), sinon libéré.
      if (next) next();
      else this.active -= 1;
    }
  }

  get stats(): { active: number; queued: number } {
    return { active: this.active, queued: this.queue.length };
  }
}
