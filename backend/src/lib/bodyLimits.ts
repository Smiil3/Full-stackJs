/** Route de synchronisation hors-ligne (corps plus volumineux, lu après authentification). Limites : config/http.ts. */
export const SYNC_ROUTE = /^\/api\/v1\/orgs\/[^/]+\/events\/[^/]+\/checkin\/sync$/;

const FORBIDDEN_JSON_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Refuse dès le parsing toute clé JSON pouvant servir à une pollution de prototype (⇒ 400). */
export function jsonReviver(key: string, value: unknown): unknown {
  if (FORBIDDEN_JSON_KEYS.has(key)) throw new SyntaxError('Clé JSON interdite');
  return value;
}
