/** Normalise un IBAN saisi (espaces retirés, majuscules). */
export function normalizeIban(raw: string): string {
  return raw.replace(/\s+/g, '').toUpperCase();
}

/**
 * Longueur officielle de l'IBAN par pays (registre ISO 13616 / SWIFT) pour la zone SEPA.
 * Un pays absent de la table est refusé : on ne peut pas recevoir de virement SEPA ailleurs.
 */
export const SEPA_IBAN_LENGTHS: Readonly<Record<string, number>> = {
  AD: 24, AT: 20, BE: 16, BG: 22, CH: 21, CY: 28, CZ: 24, DE: 22, DK: 18, EE: 20, ES: 24, FI: 18,
  FR: 27, GB: 22, GI: 23, GR: 27, HR: 21, HU: 28, IE: 22, IS: 26, IT: 27, LI: 21, LT: 20, LU: 20,
  LV: 21, MC: 27, MT: 31, NL: 18, NO: 15, PL: 28, PT: 25, RO: 24, SE: 24, SI: 19, SK: 24, SM: 27, VA: 22,
};

/** Validation ISO 13616 : pays SEPA connu, longueur du pays, format, clé de contrôle mod 97. */
export function isValidIban(raw: string): boolean {
  const iban = normalizeIban(raw);
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  const expectedLength = SEPA_IBAN_LENGTHS[iban.slice(0, 2)];
  if (expectedLength === undefined || iban.length !== expectedLength) return false;
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
