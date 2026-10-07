/**
 * Écart maximal entre deux lectures du MÊME code pour le considérer « toujours dans le champ ».
 * La caméra relit un code présent toutes les ~150 ms : au-delà d'1 s sans lecture, il a été retiré.
 */
export const CONTINUOUS_READ_GAP_MS = 1000;

/**
 * Anti-doublon de la caméra (audits M4 et n° 2 B'2). Le MÊME code est ignoré tant qu'il reste dans
 * le champ (lectures espacées de moins de CONTINUOUS_READ_GAP_MS), y compris pendant l'affichage du
 * résultat et après sa fermeture : un billet laissé devant la caméra ne produit pas de faux
 * « Déjà utilisé ». Un code RE-PRÉSENTÉ (sorti du champ puis montré de nouveau, ex. capture partagée
 * entre deux porteurs) est scanné normalement : le serveur répond « déjà utilisé », jamais un silence.
 * Un autre code passe dès qu'aucun résultat n'est affiché.
 */
export class SameCodeFilter {
  private text: string | null = null;
  private lastSeenAt = Number.NEGATIVE_INFINITY;

  /** Lecture caméra. `paused` : un résultat est affiché. Renvoie true si le code doit être traité. */
  seen(text: string, now: number, paused: boolean): boolean {
    if (text === this.text) {
      const stillInView = now - this.lastSeenAt < CONTINUOUS_READ_GAP_MS;
      this.lastSeenAt = now;
      return !paused && !stillInView;
    }
    return !paused;
  }

  /** Le code a été pris en compte (lecture effectivement traitée). */
  accepted(text: string, now: number): void {
    this.text = text;
    this.lastSeenAt = now;
  }
}
