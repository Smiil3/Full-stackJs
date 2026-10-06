import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { getEnv } from '../config/env.js';

const PREFIX = 'NG1';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PUBLIC_ID_RE = /^[A-Za-z0-9_-]{22}$/;
const SIGNATURE_RE = /^[A-Za-z0-9_-]{86}$/;

interface Keys {
  privateKey: KeyObject;
  publicKey: KeyObject;
}

let keys: Keys | null = null;

/** Clés Ed25519 lues une fois (fichiers hors dépôt, générés par `npm run keys:generate`). */
function getKeys(): Keys {
  if (!keys) {
    const env = getEnv();
    // Chemins fournis par l'opérateur (variables d'environnement validées), jamais par un client HTTP.
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- chemin de configuration
    const privateKey = createPrivateKey(readFileSync(env.ticketSigningPrivateKeyFile));
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- chemin de configuration
    const publicKey = createPublicKey(readFileSync(env.ticketSigningPublicKeyFile));
    if (privateKey.asymmetricKeyType !== 'ed25519' || publicKey.asymmetricKeyType !== 'ed25519') {
      throw new Error('Les clés de signature des billets doivent être Ed25519');
    }
    keys = { privateKey, publicKey };
  }
  return keys;
}

/** Réservé aux tests : relire les clés (changement de fichiers). */
export function resetTicketKeys(): void {
  keys = null;
}

/**
 * Charge utile du QR : `NG1.<eventId>.<publicId>.<signature>` ; la signature Ed25519 porte sur les octets
 * UTF-8 de `NG1.<eventId>.<publicId>`. Aucune donnée personnelle.
 */
export function qrPayloadFor(eventId: string, publicId: string): string {
  const signed = `${PREFIX}.${eventId}.${publicId}`;
  const signature = sign(null, Buffer.from(signed, 'utf8'), getKeys().privateKey).toString('base64url');
  return `${signed}.${signature}`;
}

export type QrCheck = { ok: true; eventId: string; publicId: string } | { ok: false };

/** Vérification stricte : 4 parties, préfixe, formats, puis signature. */
export function verifyQrPayload(payload: string): QrCheck {
  if (payload.length > 256) return { ok: false };
  const parts = payload.split('.');
  if (parts.length !== 4) return { ok: false };
  const [prefix, eventId, publicId, signature] = parts;
  if (prefix !== PREFIX || !eventId || !UUID_RE.test(eventId) || !publicId || !PUBLIC_ID_RE.test(publicId) || !signature || !SIGNATURE_RE.test(signature)) {
    return { ok: false };
  }
  const valid = verify(null, Buffer.from(`${PREFIX}.${eventId}.${publicId}`, 'utf8'), getKeys().publicKey, Buffer.from(signature, 'base64url'));
  return valid ? { ok: true, eventId, publicId } : { ok: false };
}

/** Clé publique au format JWK (vérification hors-ligne par la PWA de contrôle). */
export function publicKeyJwk(): { kty: 'OKP'; crv: 'Ed25519'; x: string } {
  const jwk = getKeys().publicKey.export({ format: 'jwk' });
  if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.x !== 'string') throw new Error('Clé publique inattendue');
  return { kty: 'OKP', crv: 'Ed25519', x: jwk.x };
}

/** Initiales du porteur affichées au contrôle (« Jean Dupont » ⇒ « J.D. »), sans autre donnée personnelle. */
export function holderInitials(displayName: string): string {
  const initials = displayName
    .normalize('NFC')
    .split(/[\s-]+/)
    .map((word) => word.codePointAt(0))
    .filter((cp): cp is number => cp !== undefined)
    .slice(0, 3)
    .map((cp) => `${String.fromCodePoint(cp).toUpperCase()}.`)
    .join('');
  return initials === '' ? '?' : initials;
}
