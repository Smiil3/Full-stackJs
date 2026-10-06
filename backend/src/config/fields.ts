/** Longueurs et bornes des champs d'entrée (contrat §1 / §7), validées par Joi. */
export const FIELD_LIMITS = {
  /** Titre d'événement (contrat §7.2 : 1–150). */
  eventTitle: 150,
  /** Description d'événement (≤ 5000). */
  eventDescription: 5000,
  /** Lieu. */
  venue: 150,
  /** Adresse (multiligne). */
  address: 300,
  /** Motif (report, annulation, remboursement manuel) : 1–500. */
  reason: 500,
  /** Nom de type de place, nom affiché. */
  name: 80,
  /** Description d'un type de place. */
  ticketTypeDescription: 1000,
  /** Capacité d'un type de place (1–100 000). */
  capacityMax: 100_000,
  /** Ordre d'affichage d'un type de place (0–1000). */
  sortOrderMax: 1000,
  /** Nom d'un collectif (2–80). */
  orgNameMin: 2,
  orgNameMax: 80,
  /** Adresse email (RFC 5321 : 254 caractères). */
  email: 254,
  /** Date ISO 8601 saisie (avec fuseau et millisecondes). */
  isoDateInput: 40,
  /** Identifiant de fuseau IANA. */
  timezone: 64,
  /** Recherche par email dans le back-office (contrat §7.3 : ≤ 100). */
  searchQuery: 100,
  /** IBAN saisi (34 caractères ISO 13616 + espaces de groupement). */
  ibanInput: 42,
  /** Bénéficiaire d'un virement (norme SEPA : 70 caractères). */
  beneficiary: 70,
  /** Lignes distinctes (types de places) dans une commande. */
  orderLines: 10,
  /** Places par ligne de commande ou par demande de liste d'attente (= borne haute de maxPerOrder). */
  quantityPerLine: 20,
} as const;
