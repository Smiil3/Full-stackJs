/** Limites de taille des corps de requête (contrat 1.12). */
export const JSON_BODY_LIMIT = '10kb';
export const WEBHOOK_BODY_LIMIT = '64kb';
/** Synchronisation hors-ligne : 500 scans × ~230 octets + marge. */
export const SYNC_BODY_LIMIT = '160kb';
export const SYNC_ROUTE = /^\/api\/v1\/orgs\/[^/]+\/events\/[^/]+\/checkin\/sync$/;

const FORBIDDEN_JSON_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Refuse dès le parsing toute clé JSON pouvant servir à une pollution de prototype (⇒ 400). */
export function jsonReviver(key: string, value: unknown): unknown {
  if (FORBIDDEN_JSON_KEYS.has(key)) throw new SyntaxError('Clé JSON interdite');
  return value;
}
