/**
 * Calculs monétaires en entiers uniquement (centimes), arithmétique BigInt pour éviter toute
 * imprécision flottante. Les entrées hors bornes (négatives, non entières, trop grandes) sont
 * des bugs : elles lèvent une erreur interne explicite plutôt que de produire un montant faux.
 */

/** Plafond métier d'un montant unitaire saisi (100 000 €). */
export const MAX_AMOUNT_CENTS = 10_000_000;
export const MAX_SERVICE_FEE_FIXED_CENTS = 1000;
export const MAX_SERVICE_FEE_BASIS_POINTS = 1500;

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

function assertCents(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new MoneyError(`${label} invalide : entier positif attendu`);
}

function assertRange(value: number, min: number, max: number, label: string): void {
  if (!Number.isInteger(value) || value < min || value > max) throw new MoneyError(`${label} hors bornes [${min}, ${max}]`);
}

/** Division entière arrondie au demi supérieur, pour numérateur ≥ 0 et dénominateur > 0 uniquement. */
function roundHalfUpDiv(numerator: bigint, denominator: bigint): bigint {
  if (numerator < 0n || denominator <= 0n) throw new MoneyError('Division monétaire sur valeur négative');
  return (numerator * 2n + denominator) / (denominator * 2n);
}

function toSafeNumber(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new MoneyError('Montant hors des entiers sûrs');
  return Number(value);
}

/** serviceFeeCents = fixe + round_half_up(subtotal × bp / 10000) ; pas de frais sur une commande gratuite. */
export function computeServiceFee(subtotalCents: number, fixedCents: number, basisPoints: number): number {
  assertCents(subtotalCents, 'Sous-total');
  assertRange(fixedCents, 0, MAX_SERVICE_FEE_FIXED_CENTS, 'Frais fixes');
  assertRange(basisPoints, 0, MAX_SERVICE_FEE_BASIS_POINTS, 'Frais en points de base');
  if (subtotalCents === 0) return 0;
  const variable = roundHalfUpDiv(BigInt(subtotalCents) * BigInt(basisPoints), 10_000n);
  return toSafeNumber(BigInt(fixedCents) + variable);
}

/** Part d'un montant selon un pourcentage entier 0–100, arrondie au demi supérieur. */
export function percentOf(amountCents: number, percent: number): number {
  assertCents(amountCents, 'Montant');
  assertRange(percent, 0, 100, 'Pourcentage');
  return toSafeNumber(roundHalfUpDiv(BigInt(amountCents) * BigInt(percent), 100n));
}

/** Produit prix unitaire × quantité, contrôlé. */
export function lineTotal(unitPriceCents: number, quantity: number): number {
  assertCents(unitPriceCents, 'Prix unitaire');
  assertRange(quantity, 1, 1000, 'Quantité');
  return toSafeNumber(BigInt(unitPriceCents) * BigInt(quantity));
}

/** Part d'un montant selon un pourcentage entier 0–100, arrondie à l'inférieur (règle de remboursement du contrat). */
export function floorPercentOf(amountCents: number, percent: number): number {
  assertCents(amountCents, 'Montant');
  assertRange(percent, 0, 100, 'Pourcentage');
  return toSafeNumber((BigInt(amountCents) * BigInt(percent)) / 100n);
}

/**
 * Répartit `total` entre des lignes proportionnellement à leurs poids (méthode du plus fort reste) :
 * la somme des parts vaut exactement `total`, chaque part ≤ son poids.
 */
export function allocate(total: number, weights: number[]): number[] {
  assertCents(total, 'Total');
  const sum = weights.reduce((a, b) => a + b, 0);
  if (total > sum) throw new MoneyError('Répartition supérieure à la somme des lignes');
  if (sum === 0) return weights.map(() => 0);
  const raw = weights.map((w) => (BigInt(total) * BigInt(w)));
  const parts = raw.map((r) => Number(r / BigInt(sum)));
  let rest = total - parts.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => ({ i, rem: r % BigInt(sum) })).sort((x, y) => (y.rem > x.rem ? 1 : y.rem < x.rem ? -1 : x.i - y.i));
  for (const { i } of order) {
    if (rest === 0) break;
    parts[i] = (parts[i] ?? 0) + 1;
    rest -= 1;
  }
  return parts;
}
