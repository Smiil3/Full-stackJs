/**
 * Clé publique Ed25519 des billets ÉPINGLÉE au build (audit B14) : `VITE_TICKET_PUBLIC_KEY_JWK`, un JWK
 * `{"kty":"OKP","crv":"Ed25519","x":"…"}` (x = 32 octets en base64url). En mode secours, la liste
 * téléchargée est refusée si sa clé diffère, et les signatures sont vérifiées avec la clé épinglée
 * (une clé modifiée dans IndexedDB n'est jamais utilisée). Obligatoire en production ; en
 * développement (API simulée, clé aléatoire), absente ⇒ clé de la liste utilisée.
 * Obtention : `npm run ticket-key` (lit backend/keys/ticket-signing-public.pem).
 */
import type { PublicKeyJwk } from '../api/types';

const B64URL_32 = /^[A-Za-z0-9_-]{43}$/;

/** Analyse et valide le JWK ; `null` si absent ; exception explicite si mal formé. */
export function parseTicketKey(raw: string | undefined): PublicKeyJwk | null {
  if (raw === undefined || raw.trim() === '') return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    throw new Error('VITE_TICKET_PUBLIC_KEY_JWK : JSON invalide (attendu {"kty":"OKP","crv":"Ed25519","x":"…"}).');
  }
  const o = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>;
  const keys = Object.keys(o).sort().join(',');
  if (o.kty !== 'OKP' || o.crv !== 'Ed25519' || typeof o.x !== 'string' || !B64URL_32.test(o.x) || keys !== 'crv,kty,x') {
    throw new Error('VITE_TICKET_PUBLIC_KEY_JWK : clé Ed25519 attendue (kty OKP, crv Ed25519, x de 32 octets en base64url, aucun autre champ).');
  }
  return { kty: 'OKP', crv: 'Ed25519', x: o.x };
}

/** Démarrage : clé valide si présente, OBLIGATOIRE en production. */
export function assertTicketKeyConfig(env: { raw: string | undefined; isProd: boolean }): void {
  const key = parseTicketKey(env.raw);
  if (env.isProd && !key) throw new Error('VITE_TICKET_PUBLIC_KEY_JWK manquante : clé publique des billets obligatoire en production.');
}

let pinned: PublicKeyJwk | null = null;
try {
  pinned = parseTicketKey(import.meta.env.VITE_TICKET_PUBLIC_KEY_JWK);
} catch {
  pinned = null; // mal formée : le démarrage échoue de toute façon (assertTicketKeyConfig)
}

export function pinnedTicketKey(): PublicKeyJwk | null {
  return pinned;
}

export const sameKey = (a: PublicKeyJwk, b: PublicKeyJwk) => a.x === b.x; // kty / crv fixés par le type (OKP, Ed25519)

/** Clé de vérification à utiliser pour une liste : la clé épinglée si elle existe (refus si différente). */
export function trustedKeyFor(listKey: PublicKeyJwk): PublicKeyJwk {
  const p = pinned;
  if (!p) return listKey;
  if (!sameKey(p, listKey)) throw new UntrustedKeyError();
  return p;
}

export class UntrustedKeyError extends Error {
  constructor() {
    super('Clé de signature des billets inattendue');
  }
}

/** Réservé aux tests. */
export function __setPinnedTicketKey(key: PublicKeyJwk | null): void {
  pinned = key;
}
