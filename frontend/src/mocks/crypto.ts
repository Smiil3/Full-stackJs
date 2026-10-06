/**
 * Signature des billets du faux serveur (mock uniquement). La clé privée est générée aléatoirement
 * au démarrage du mock : elle n'existe qu'en mémoire et ne correspond à aucune clé réelle.
 */
import * as ed from '@noble/ed25519';
import { bytesToBase64url } from '../lib/base64url';
import type { PublicKeyJwk } from '../api/types';

let keys: Promise<{ secretKey: Uint8Array; publicKey: Uint8Array }> | null = null;

function getKeys() {
  keys ??= ed.keygenAsync().then(({ secretKey, publicKey }) => ({ secretKey, publicKey }));
  return keys;
}

export async function mockPublicKeyJwk(): Promise<PublicKeyJwk> {
  const { publicKey } = await getKeys();
  return { kty: 'OKP', crv: 'Ed25519', x: bytesToBase64url(publicKey) };
}

export function randomPublicId(): string {
  return bytesToBase64url(crypto.getRandomValues(new Uint8Array(16)));
}

/** `NG1.<eventId>.<publicId>.<signature>` — signature sur les octets UTF-8 de `NG1.<eventId>.<publicId>`. */
export async function signQr(eventId: string, publicId: string): Promise<string> {
  const { secretKey } = await getKeys();
  const message = `NG1.${eventId}.${publicId}`;
  const sig = await ed.signAsync(new TextEncoder().encode(message), secretKey);
  return `${message}.${bytesToBase64url(sig)}`;
}
