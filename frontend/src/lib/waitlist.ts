/** Position dans la file : « 4ᵉ » (1 ⇒ « en tête de la liste »). */
export function positionLabel(position: number): string {
  return position <= 1 ? 'en tête de la liste' : `${position}ᵉ`;
}

/** Seuil anti-gel : au-delà, le compte sort de la liste d'attente de l'événement (contrat v1.18 §6). */
export const MAX_UNHONORED_OFFERS = 2;

/** Compteur d'offres non honorées sur l'événement, ou null s'il n'y en a aucune. */
export function unhonoredOffersNotice(unhonored: number): string | null {
  if (unhonored <= 0) return null;
  if (unhonored >= MAX_UNHONORED_OFFERS) {
    return `${MAX_UNHONORED_OFFERS} offres non honorées sur ${MAX_UNHONORED_OFFERS} : vous êtes sorti·e de la liste d’attente de cet événement et ne pouvez plus vous y réinscrire.`;
  }
  return `${unhonored} offre non honorée sur ${MAX_UNHONORED_OFFERS} : à la prochaine, vous sortez de la liste d’attente de cet événement.`;
}
