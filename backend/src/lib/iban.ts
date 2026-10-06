import { DECIMAL_BASE, IBAN_CHECK_PREFIX_LENGTH, IBAN_COUNTRY_LENGTH, IBAN_LETTER_CODE_MIN, IBAN_LETTER_OFFSET, IBAN_MASK_VISIBLE, IBAN_MODULUS, SEPA_IBAN_LENGTHS } from '../config/banking.js';

/** Normalise un IBAN saisi (espaces retirés, majuscules). */
export function normalizeIban(raw: string): string {
  return raw.replace(/\s+/g, '').toUpperCase();
}

/** Validation ISO 13616 : pays SEPA connu, longueur du pays, format, clé de contrôle mod 97. */
export function isValidIban(raw: string): boolean {
  const iban = normalizeIban(raw);
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  const expectedLength = SEPA_IBAN_LENGTHS[iban.slice(0, IBAN_COUNTRY_LENGTH)];
  if (expectedLength === undefined || iban.length !== expectedLength) return false;
  const rearranged = iban.slice(IBAN_CHECK_PREFIX_LENGTH) + iban.slice(0, IBAN_CHECK_PREFIX_LENGTH);
  let remainder = 0;
  for (const ch of rearranged) {
    const code = ch.charCodeAt(0);
    const digits = code >= IBAN_LETTER_CODE_MIN ? String(code - IBAN_LETTER_OFFSET) : ch;
    for (const d of digits) remainder = (remainder * DECIMAL_BASE + Number(d)) % IBAN_MODULUS;
  }
  return remainder === 1;
}

/** Forme masquée affichée au back-office : « FR76 •••• •••• 1234 ». */
export function maskIban(raw: string): string {
  const iban = normalizeIban(raw);
  return `${iban.slice(0, IBAN_MASK_VISIBLE)} •••• •••• ${iban.slice(-IBAN_MASK_VISIBLE)}`;
}

export const BIC_PATTERN = /^(?:[A-Z]{6}[A-Z0-9]{2}|[A-Z]{6}[A-Z0-9]{5})$/;
