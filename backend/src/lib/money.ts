/**
 * Calculs monétaires en entiers uniquement (centimes), arithmétique BigInt pour éviter toute
 * imprécision flottante. Arrondi « au demi supérieur » (round half up) sur des montants positifs.
 */
function roundHalfUpDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator * 2n + denominator) / (denominator * 2n);
}

/** serviceFeeCents = fixe + round_half_up(subtotal × bp / 10000) ; pas de frais sur une commande gratuite. */
export function computeServiceFee(subtotalCents: number, fixedCents: number, basisPoints: number): number {
  if (subtotalCents <= 0) return 0;
  const variable = roundHalfUpDiv(BigInt(subtotalCents) * BigInt(basisPoints), 10_000n);
  return Number(BigInt(fixedCents) + variable);
}

/** Part remboursée d'un montant selon un pourcentage entier 0–100. */
export function percentOf(amountCents: number, percent: number): number {
  return Number(roundHalfUpDiv(BigInt(amountCents) * BigInt(percent), 100n));
}
