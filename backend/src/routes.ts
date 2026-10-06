import { Router } from 'express';
import type { Limiters } from './middlewares/rateLimit.js';

/** Routeur principal `/api/v1` : chaque module y monte ses routes. */
export function buildApiRouter(_limiters: Limiters): Router {
  const router = Router();
  return router;
}

/** Routes recevant un corps brut (webhook PSP). */
export function buildWebhookRouter(): Router {
  const router = Router();
  return router;
}
