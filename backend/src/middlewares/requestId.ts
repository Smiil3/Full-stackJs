import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

const INCOMING_ID = /^[A-Za-z0-9._-]{8,64}$/;

/** Identifiant de requête : réutilise un X-Request-Id entrant sain, sinon en génère un. */
export function genRequestId(req: IncomingMessage, res: ServerResponse): string {
  const incoming = req.headers['x-request-id'];
  const id = typeof incoming === 'string' && INCOMING_ID.test(incoming) ? incoming : randomUUID();
  res.setHeader('X-Request-Id', id);
  return id;
}
