import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

const CLIENT_ID = /^[A-Za-z0-9._-]{8,64}$/;

/**
 * Identifiant de requête TOUJOURS généré côté serveur : un client ne peut ni l'imposer
 * ni l'utiliser pour polluer / usurper la corrélation des logs.
 */
export function genRequestId(_req: IncomingMessage, res: ServerResponse): string {
  const id = randomUUID();
  res.setHeader('X-Request-Id', id);
  return id;
}

/** X-Request-Id envoyé par le client, conservé seulement s'il respecte un format sûr (journalisé à part). */
export function clientRequestId(req: IncomingMessage): string | null {
  const incoming = req.headers['x-request-id'];
  return typeof incoming === 'string' && CLIENT_ID.test(incoming) ? incoming : null;
}
