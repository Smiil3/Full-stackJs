/**
 * IBAN (ISO 13616 / ISO 7064 MOD 97-10) et virements.
 * Longueur officielle de l'IBAN par pays (registre SWIFT) pour la zone SEPA ; un pays absent est refusé.
 */
export const SEPA_IBAN_LENGTHS: Readonly<Record<string, number>> = {
  AD: 24, AT: 20, BE: 16, BG: 22, CH: 21, CY: 28, CZ: 24, DE: 22, DK: 18, EE: 20, ES: 24, FI: 18,
  FR: 27, GB: 22, GI: 23, GR: 27, HR: 21, HU: 28, IE: 22, IS: 26, IT: 27, LI: 21, LT: 20, LU: 20,
  LV: 21, MC: 27, MT: 31, NL: 18, NO: 15, PL: 28, PT: 25, RO: 24, SE: 24, SI: 19, SK: 24, SM: 27, VA: 22,
};
/** Code pays en tête d'IBAN (2 lettres). */
export const IBAN_COUNTRY_LENGTH = 2;
/** Pays + clé de contrôle, déplacés en fin de chaîne avant le calcul MOD 97. */
export const IBAN_CHECK_PREFIX_LENGTH = 4;
/** Lettres converties en nombres : A = 10 … Z = 35 (code de « A » = 65, d'où un décalage de 55). */
export const IBAN_LETTER_CODE_MIN = 65;
export const IBAN_LETTER_OFFSET = 55;
/** Base décimale du calcul du reste. */
export const DECIMAL_BASE = 10;
/** Module ISO 7064 MOD 97-10 : un IBAN valide a un reste de 1. */
export const IBAN_MODULUS = 97;
/** Caractères visibles en tête et en fin d'IBAN masqué (« FR76 •••• •••• 0189 »). */
export const IBAN_MASK_VISIBLE = 4;

/** Référence de virement : longueur et tirages en cas de collision. */
export const TRANSFER_REFERENCE_LENGTH = 10;
export const TRANSFER_REFERENCE_ATTEMPTS = 3;
