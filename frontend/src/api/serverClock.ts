/**
 * Horloge alignée sur le serveur. Les échéances métier (réservation, offre de liste d'attente,
 * annulation) sont décidées par le serveur : l'horloge du téléphone peut être fausse de plusieurs
 * minutes. On estime le décalage à partir de l'en-tête HTTP `Date` des réponses de l'API
 * (précision : la seconde) avec une médiane glissante, robuste aux valeurs aberrantes.
 */
const WINDOW = 7;
const samples: number[] = [];
let offsetMs = 0;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

/** Enregistre l'en-tête `Date` d'une réponse reçue à `receivedAt` (horloge locale). */
export function recordServerDate(header: string | null, receivedAt: number = Date.now()): void {
  if (!header) return;
  const serverMs = Date.parse(header);
  if (Number.isNaN(serverMs)) return;
  // `Date` est tronqué à la seconde : +500 ms recentre l'estimation.
  samples.push(serverMs + 500 - receivedAt);
  if (samples.length > WINDOW) samples.shift();
  offsetMs = Math.round(median(samples));
}

/** Instant présent selon le serveur (ms epoch). */
export function serverNow(): number {
  return Date.now() + offsetMs;
}

export function serverOffsetMs(): number {
  return offsetMs;
}

/** Réservé aux tests. */
export function __resetServerClock(): void {
  samples.length = 0;
  offsetMs = 0;
}
