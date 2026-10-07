/** Délai d'attente par défaut quand le serveur n'envoie pas de `Retry-After`. */
export const DEFAULT_RETRY_AFTER_S = 5;

/** Instant (local) à partir duquel réessayer, d'après le `Retry-After` d'une erreur. */
export function retryAtFrom(retryAfter: number | undefined): number {
  return Date.now() + (retryAfter ?? DEFAULT_RETRY_AFTER_S) * 1000;
}
