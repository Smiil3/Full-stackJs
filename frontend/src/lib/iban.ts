/**
 * Contrôles UX des coordonnées bancaires (le serveur fait foi : il refuse aussi les IBAN hors SEPA).
 */
/** Longueurs IBAN des principaux pays SEPA. */
const LENGTHS: Record<string, number> = {
  FR: 27, MC: 27, BE: 16, LU: 20, DE: 22, ES: 24, IT: 27, PT: 25, NL: 18, CH: 21, AT: 20, IE: 22, GB: 22, PL: 28, SE: 24, DK: 18, FI: 18, NO: 15, GR: 27,
};

export function normalizeIban(raw: string): string {
  return raw.replace(/[\s-]+/g, '').toUpperCase();
}

export function ibanProblem(raw: string): string | undefined {
  const iban = normalizeIban(raw);
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(iban)) return 'Format d’IBAN invalide.';
  const country = iban.slice(0, 2);
  const expected = Object.hasOwn(LENGTHS, country) ? LENGTHS[country] : undefined;
  if (expected !== undefined && iban.length !== expected) return `Un IBAN ${country} compte ${expected} caractères.`;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let rem = 0;
  for (const ch of rearranged) {
    const n = ch >= 'A' ? ch.charCodeAt(0) - 55 : Number(ch);
    rem = Number(`${rem}${n}`) % 97;
  }
  return rem === 1 ? undefined : 'IBAN invalide (clé de contrôle incorrecte) : vérifiez la saisie.';
}

export function bicProblem(raw: string): string | undefined {
  return /^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(raw.trim().toUpperCase()) ? undefined : 'BIC invalide (8 ou 11 caractères).';
}
