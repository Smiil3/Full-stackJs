/**
 * Montants : entiers en centimes partout. Les saisies en euros / pourcentages sont converties
 * par analyse de CHAÎNE (jamais `parseFloat(x) * 100`, qui donne 19.99 * 100 = 1998.9999…).
 */

const EUR = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' });

/** 1500 → « 15,00 € ». */
export function formatCents(cents: number): string {
  if (!Number.isSafeInteger(cents)) return '—';
  return EUR.format(cents / 100); // affichage seulement : division exacte au centime pour des entiers sûrs
}

type Parsed = { ok: true; value: number } | { ok: false };

/**
 * Analyse « 12 », « 12,5 », « 12.50 », « 1 234,56 » en entier mis à l'échelle de `decimals` chiffres.
 * Strict : séparateur de milliers = espace (normale, insécable ou fine) par groupes de 3 exactement,
 * un seul séparateur décimal suivi d'au moins un chiffre. « 1 5 », « 5, », « 1.234,5 » sont refusés.
 */
function parseScaledDecimal(raw: string, decimals: number, max: number): Parsed {
  const s = raw.trim().replace(/[\u00a0\u202f]/g, ' ');
  const re = new RegExp(`^(\\d{1,3}(?: \\d{3})+|\\d{1,9})(?:[.,](\\d{1,${decimals}}))?$`);
  const m = re.exec(s);
  if (!m) return { ok: false };
  const intPart = Number((m[1] ?? '').replace(/ /g, ''));
  const frac = (m[2] ?? '').padEnd(decimals, '0');
  const value = intPart * 10 ** decimals + (frac ? Number(frac) : 0);
  if (!Number.isSafeInteger(value) || value > max) return { ok: false };
  return { ok: true, value };
}

/** « 19,99 » → 1999. Refuse plus de 2 décimales, les négatifs et les valeurs > max. */
export function eurosToCents(raw: string, maxCents: number = 1_000_000): Parsed {
  return parseScaledDecimal(raw, 2, maxCents);
}

/** 1999 → « 19,99 » (valeur de champ de saisie, sans symbole). */
export function centsToEurosInput(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)},${String(abs % 100).padStart(2, '0')}`;
}

/** Pourcentage saisi (2 décimales max) → points de base : « 2,5 » → 250. */
export function percentToBasisPoints(raw: string, maxBasisPoints: number = 1500): Parsed {
  return parseScaledDecimal(raw, 2, maxBasisPoints);
}

/** 250 → « 2,5 ». */
export function basisPointsToPercentInput(bp: number): string {
  const intPart = Math.floor(bp / 100);
  const frac = String(bp % 100).padStart(2, '0').replace(/0+$/, '');
  return frac ? `${intPart},${frac}` : String(intPart);
}

/** 250 → « 2,5 % ». */
export function formatBasisPoints(bp: number): string {
  return `${basisPointsToPercentInput(bp)} %`;
}

/**
 * ESTIMATION des frais de service affichée avant validation (formule du contrat §7.3, entiers seulement).
 * Le montant définitif est TOUJOURS celui renvoyé par l'API dans la commande.
 */
export function estimateServiceFeeCents(subtotalCents: number, fixedCents: number, basisPoints: number): number {
  const numerator = subtotalCents * basisPoints;
  const variable = Math.floor((numerator + 5000) / 10000); // round half up, valeurs positives
  return fixedCents + variable;
}
