/** Normalise un IBAN saisi (espaces retirés, majuscules). */
export function normalizeIban(raw: string): string {
  return raw.replace(/\s+/g, '').toUpperCase();
}

/** Validation ISO 13616 : format + clé de contrôle mod 97. */
export function isValidIban(raw: string): boolean {
  const iban = normalizeIban(raw);
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const code = ch.charCodeAt(0);
    const digits = code >= 65 ? String(code - 55) : ch;
    for (const d of digits) remainder = (remainder * 10 + Number(d)) % 97;
  }
  return remainder === 1;
}

/** Forme masquée affichée au back-office : « FR76 •••• •••• 1234 ». */
export function maskIban(raw: string): string {
  const iban = normalizeIban(raw);
  return `${iban.slice(0, 4)} •••• •••• ${iban.slice(-4)}`;
}

export const BIC_PATTERN = /^(?:[A-Z]{6}[A-Z0-9]{2}|[A-Z]{6}[A-Z0-9]{5})$/;
