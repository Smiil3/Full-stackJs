import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** Jeton aléatoire cryptographique encodé en base64url (32 octets = 256 bits par défaut). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Comparaison à temps constant de deux chaînes (longueurs différentes ⇒ false sans fuite de timing sur le contenu). */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb) && a.length === b.length;
}

const GCM_IV_BYTES = 12;

/** Chiffrement AES-256-GCM : sortie `v1.<iv>.<tag>.<ciphertext>` en base64url. */
export function encryptString(plain: string, key: Buffer): string {
  const iv = randomBytes(GCM_IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.');
}

export function decryptString(payload: string, key: Buffer): string {
  const [version, iv, tag, ciphertext] = payload.split('.');
  if (version !== 'v1' || !iv || !tag || ciphertext === undefined) throw new Error('Format chiffré inconnu');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8');
}

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
