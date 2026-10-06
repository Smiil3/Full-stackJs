/** Plafond métier d'un montant unitaire saisi (100 000 €). */
export const MAX_AMOUNT_CENTS = 10_000_000;
/** Prix maximal d'un type de place (10 000 €, contrat §7.2). */
export const TICKET_PRICE_MAX_CENTS = 1_000_000;
/** Centimes dans un euro (affichage). */
export const CENTS_PER_EURO = 100;
/** Pourcentage maximal (remboursement, part de frais) : 100 %. */
export const PERCENT_MAX = 100;
/** Échelle d'un pourcentage en arithmétique BigInt. */
export const PERCENT_SCALE = 100n;
/** Échelle des points de base (1 pb = 0,01 %). */
export const BASIS_POINTS_SCALE = 10_000n;
/** Arrondi au demi supérieur en entiers : numérateur et dénominateur doublés, (2n + d) / 2d. */
export const HALF_UP_DOUBLING = 2n;
/** Quantité maximale d'une ligne dans un calcul (garde-fou interne, au-delà de toute borne d'entrée). */
export const LINE_QUANTITY_MAX = 1000;
