/** Même code ignoré pendant ce délai après sa dernière lecture ET après la fermeture du résultat. */
export const SAME_CODE_QUIET_MS = 3000;

/**
 * Anti-doublon de la caméra (audit M4) : un billet laissé devant la caméra ne doit pas être relu et
 * afficher un faux « Déjà utilisé ». Le MÊME code est ignoré :
 * - tant qu'il est encore lu en continu (chaque lecture, même pendant l'affichage du résultat, repousse
 *   l'échéance) ;
 * - et pendant au moins SAME_CODE_QUIET_MS après la fermeture du résultat (pas après la 1re lecture).
 * Un code différent passe immédiatement.
 */
export class SameCodeFilter {
  private text: string | null = null;
  private lastSeenAt = Number.NEGATIVE_INFINITY;
  private closedAt = Number.NEGATIVE_INFINITY;

  /** Lecture caméra. `paused` : un résultat est affiché. Renvoie true si le code doit être traité. */
  seen(text: string, now: number, paused: boolean): boolean {
    if (text === this.text) {
      const quiet = now - Math.max(this.lastSeenAt, this.closedAt) < SAME_CODE_QUIET_MS;
      this.lastSeenAt = now; // toujours dans le champ
      if (paused || quiet) return false;
      return true;
    }
    return !paused;
  }

  /** Le code a été pris en compte (lecture effectivement traitée). */
  accepted(text: string, now: number): void {
    this.text = text;
    this.lastSeenAt = now;
  }

  /** Le résultat vient d'être fermé : le délai de calme repart de maintenant. */
  closed(now: number): void {
    this.closedAt = now;
  }
}
