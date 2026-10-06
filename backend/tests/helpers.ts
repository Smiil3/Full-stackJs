import supertest from 'supertest';
import { createApp } from '../src/app.js';

/** Application de test : rate limiting assoupli (un test dédié vérifie les vrais plafonds). */
export function api() {
  return supertest(createApp({ rateLimitMultiplier: 1000 }));
}
