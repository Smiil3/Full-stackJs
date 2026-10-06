/** Encodage base64url SANS padding (RFC 4648 §5), strict au décodage. */

const ALPHABET_RE = /^[A-Za-z0-9_-]*$/;

export function bytesToBase64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Retourne null si la chaîne n'est pas du base64url canonique sans padding. */
export function base64urlToBytes(value: string): Uint8Array | null {
  if (!ALPHABET_RE.test(value) || value.length % 4 === 1) return null;
  const b64 = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
  let bin: string;
  try {
    bin = atob(b64);
  } catch {
    return null;
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  // Refuse les encodages non canoniques (bits de bourrage non nuls) : une seule chaîne par valeur.
  return bytesToBase64url(out) === value ? out : null;
}
