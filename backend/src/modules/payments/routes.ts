import { Router } from 'express';
import Joi from 'joi';
import { captureRawBody } from '../../middlewares/rawBody.js';
import { checkResponse } from '../../middlewares/validate.js';
import { handlePspWebhook } from './webhook.js';

const ackResponse = Joi.object({ received: Joi.boolean().valid(true) });

/** Monté sous /api/v1/webhooks, avec corps brut (avant le parseur JSON). */
export function webhooksRouter(): Router {
  const r = Router();
  r.post('/psp', captureRawBody, async (req, res) => {
    const signature = req.headers['psp-signature'];
    const result = await handlePspWebhook(res.locals['rawBody'] as Buffer, typeof signature === 'string' ? signature : undefined);
    res.status(200).json(checkResponse(ackResponse, result));
  });
  return r;
}
