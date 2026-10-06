/**
 * Vérification locale d'un QR de billet : `NG1.<eventId>.<publicId>.<signature>` (contrat §5).
 * Signature Ed25519 sur les octets UTF-8 de `NG1.<eventId>.<publicId>`, vérifiée avec la clé publique
 * du snapshot. WebCrypto (Ed25519) en priorité, repli sur @noble/ed25519 si le navigateur ne le gère pas.
 */
import * as ed from '@noble/ed25519';
import type { PublicKeyJwk } from '../api/types';
import { base64urlToBytes } from '../lib/base64url';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/; // forme canonique minuscule
const PUBLIC_ID = /^[A-Za-z0-9_-]{22}$/;
const SIGNATURE = /^[A-Za-z0-9_-]{86}$/;

export type ParsedQr = { eventId: string; publicId: string; signed: string; signature: Uint8Array };

/** Analyse stricte ; null si le format n'est pas exactement celui du contrat. */
export function parseQr(payload: string): ParsedQr | null {
  if (payload.length > 256) return null;
  const parts = payload.split('.');
  if (parts.length !== 4) return null;
  const [prefix, eventId, publicId, sig] = parts as [string, string, string, string];
  if (prefix !== 'NG1' || !UUID.test(eventId) || !PUBLIC_ID.test(publicId) || !SIGNATURE.test(sig)) return null;
  if (base64urlToBytes(publicId)?.length !== 16) return null;
  const signature = base64urlToBytes(sig);
  if (signature?.length !== 64) return null;
  return { eventId, publicId, signed: `NG1.${eventId}.${publicId}`, signature };
}

type Verifier = (message: Uint8Array, signature: Uint8Array) => Promise<boolean>;
const verifierCache = new Map<string, Promise<Verifier>>();

/** Forcer le repli logiciel (tests). */
export const verifyOptions = { forceFallback: false };

async function buildVerifier(jwk: PublicKeyJwk): Promise<Verifier> {
  // Donnée venant du réseau / d'IndexedDB : on revérifie la forme malgré le typage.
  const k = jwk as { kty: unknown; crv: unknown; x: unknown };
  const raw = typeof k.x === 'string' ? base64urlToBytes(k.x) : null;
  if (k.kty !== 'OKP' || k.crv !== 'Ed25519' || raw?.length !== 32) throw new Error('Clé publique invalide');
  if (!verifyOptions.forceFallback && typeof crypto !== 'undefined' && 'subtle' in crypto) {
    try {
      const key = await crypto.subtle.importKey('jwk', { kty: 'OKP', crv: 'Ed25519', x: jwk.x }, { name: 'Ed25519' }, false, ['verify']);
      return (message, signature) => crypto.subtle.verify({ name: 'Ed25519' }, key, signature as BufferSource, message as BufferSource);
    } catch {
      // Navigateur sans Ed25519 dans WebCrypto : repli logiciel ci-dessous.
    }
  }
  return (message, signature) => ed.verifyAsync(signature, message, raw).catch(() => false);
}

export async function verifySignature(parsed: ParsedQr, jwk: PublicKeyJwk): Promise<boolean> {
  const cacheKey = `${verifyOptions.forceFallback ? 'sw' : 'wc'}:${jwk.x}`;
  let verifier = verifierCache.get(cacheKey);
  if (!verifier) {
    verifier = buildVerifier(jwk);
    verifierCache.set(cacheKey, verifier);
  }
  try {
    return await (await verifier)(new TextEncoder().encode(parsed.signed), parsed.signature);
  } catch {
    return false;
  }
}
