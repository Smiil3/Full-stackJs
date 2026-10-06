import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { getEnv } from '../config/env.js';
import { KEY_FILE_FORBIDDEN_MODE_BITS } from '../config/crypto.js';
import { HOLDER_INITIALS_MAX, QR_PARTS, QR_PAYLOAD_MAX_LENGTH } from '../config/checkin.js';

const PREFIX = 'NG1';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PUBLIC_ID_RE = /^[A-Za-z0-9_-]{22}$/;
const SIGNATURE_RE = /^[A-Za-z0-9_-]{86}$/;

interface Keys {
  privateKey: KeyObject;
  publicKey: KeyObject;
}

let keys: Keys | null = null;

export class TicketKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TicketKeyError';
  }
}

/**
 * Charge et contrôle la paire Ed25519 (appelé au démarrage : refus de démarrer si elle est invalide).
 * - la clé publique est DÉRIVÉE de la clé privée ; si le fichier public existe, il doit correspondre ;
 * - en production, la clé privée ne doit être lisible ni par le groupe ni par les autres (mode 0600 / 0400 ;
 *   secret monté par l'orchestrateur avec defaultMode 0400).
 */
export function loadTicketKeys(): Keys {
  const env = getEnv();
  // Chemins fournis par l'opérateur (variables d'environnement validées), jamais par un client HTTP.
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- chemin de configuration
  const mode = statSync(env.ticketSigningPrivateKeyFile).mode;
  if (env.nodeEnv === 'production' && (mode & KEY_FILE_FORBIDDEN_MODE_BITS) !== 0) {
    throw new TicketKeyError('La clé privée de signature des billets est lisible par d’autres utilisateurs (attendu : 0600 ou 0400).');
  }
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- chemin de configuration
  const privateKey = createPrivateKey(readFileSync(env.ticketSigningPrivateKeyFile));
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new TicketKeyError('La clé de signature des billets doit être Ed25519.');
  const publicKey = createPublicKey(privateKey);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- chemin de configuration
  if (existsSync(env.ticketSigningPublicKeyFile)) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- chemin de configuration
    const declared = createPublicKey(readFileSync(env.ticketSigningPublicKeyFile));
    const same = declared.export({ format: 'der', type: 'spki' }).equals(publicKey.export({ format: 'der', type: 'spki' }));
    if (!same) throw new TicketKeyError('Les clés publique et privée de signature des billets ne forment pas une paire.');
  }
  keys = { privateKey, publicKey };
  return keys;
}

function getKeys(): Keys {
  return keys ?? loadTicketKeys();
}

/** Réservé aux tests : relire les clés (changement de fichiers). */
export function resetTicketKeys(): void {
  keys = null;
}

/** base64url canonique : refuse les encodages équivalents (bits de remplissage non nuls du dernier caractère). */
function isCanonicalBase64url(value: string): boolean {
  return Buffer.from(value, 'base64url').toString('base64url') === value;
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

export type QrCheck = { ok: true; eventId: string; publicId: string } | { ok: false; reason: 'format' | 'signature' };

/** Vérification stricte : 4 parties, préfixe, formats (base64url canonique), puis signature. */
export function verifyQrPayload(payload: string): QrCheck {
  if (payload.length > QR_PAYLOAD_MAX_LENGTH) return { ok: false, reason: 'format' };
  const parts = payload.split('.');
  if (parts.length !== QR_PARTS) return { ok: false, reason: 'format' };
  const [prefix, eventId, publicId, signature] = parts;
  if (
    prefix !== PREFIX || !eventId || !UUID_RE.test(eventId)
    || !publicId || !PUBLIC_ID_RE.test(publicId) || !isCanonicalBase64url(publicId)
    || !signature || !SIGNATURE_RE.test(signature) || !isCanonicalBase64url(signature)
  ) {
    return { ok: false, reason: 'format' };
  }
  const valid = verify(null, Buffer.from(`${PREFIX}.${eventId}.${publicId}`, 'utf8'), getKeys().publicKey, Buffer.from(signature, 'base64url'));
  return valid ? { ok: true, eventId, publicId } : { ok: false, reason: 'signature' };
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
    .slice(0, HOLDER_INITIALS_MAX)
    .map((cp) => `${String.fromCodePoint(cp).toUpperCase()}.`)
    .join('');
  return initials === '' ? '?' : initials;
}
