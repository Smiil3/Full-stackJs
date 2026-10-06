import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** Jeton aléatoire cryptographique encodé en base64url (32 octets = 256 bits par défaut). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Comparaison à temps constant de deux chaînes (via leurs empreintes de taille fixe : pas de fuite sur la longueur). */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;
const KID_RE = /^[a-z0-9]{1,16}$/;

export interface Keyring {
  /** Clé utilisée pour chiffrer. */
  current: { id: string; key: Buffer };
  /** Toutes les clés acceptées en déchiffrement (courante + anciennes, pour la rotation). */
  byId: ReadonlyMap<string, Buffer>;
}

/**
 * Chiffrement AES-256-GCM authentifié, lié à son contexte par AAD
 * (ex. `org:<orgId>:bank_iban`) : un chiffré recopié sur une autre ligne ne se déchiffre pas.
 * Format : `v1.<kid>.<iv>.<tag>.<ciphertext>` (base64url) — le kid permet la rotation de clé.
 */
export function encryptString(plain: string, keyring: Keyring, aad: string): string {
  const iv = randomBytes(GCM_IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', keyring.current.key, iv, { authTagLength: GCM_TAG_BYTES });
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', keyring.current.id, iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.');
}

export function decryptString(payload: string, keyring: Keyring, aad: string): string {
  const parts = payload.split('.');
  const [version, kid, ivB64, tagB64, ctB64] = parts;
  if (parts.length !== 5 || version !== 'v1' || !kid || !KID_RE.test(kid) || !ivB64 || !tagB64 || ctB64 === undefined) {
    throw new Error('Format chiffré inconnu');
  }
  const key = keyring.byId.get(kid);
  if (!key) throw new Error('Clé de chiffrement inconnue');
  const iv = Buffer.from(ivB64, 'base64url');
  const tag = Buffer.from(tagB64, 'base64url');
  if (iv.length !== GCM_IV_BYTES || tag.length !== GCM_TAG_BYTES) throw new Error('IV ou tag invalide');
  const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: GCM_TAG_BYTES });
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64url')), decipher.final()]).toString('utf8');
}

/** Contextes AAD des champs chiffrés. */
export const aad = {
  orgBankIban: (orgId: string) => `org:${orgId}:bank_iban`,
  orderTransferIban: (orderId: string) => `order:${orderId}:transfer_iban`,
  outboxPayload: (outboxId: string) => `outbox:${outboxId}`,
};

const TRANSFER_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Référence de virement lisible (sans caractères ambigus), tirée par rejet pour éviter le biais modulo. */
export function transferReference(length = 10): string {
  let out = '';
  while (out.length < length) {
    for (const byte of randomBytes(length * 2)) {
      if (byte < 256 - (256 % TRANSFER_ALPHABET.length)) {
        out += TRANSFER_ALPHABET.charAt(byte % TRANSFER_ALPHABET.length);
        if (out.length === length) break;
      }
    }
  }
  return `NG-${out}`;
}
