export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;

export function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * MINUTE_MS);
}

export function addHours(date: Date, hours: number): Date {
  return new Date(date.getTime() + hours * HOUR_MS);
}

/** Formate une date dans le fuseau de l'événement (« 14/11/2026 20:00 »), pour les mails et l'export CSV. */
export function formatInTimezone(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat('fr-FR', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

/** Libellé d'heure lisible avec le nom du fuseau (« 14/11/2026 20:00 (heure : Europe/Paris) »). */
export function formatWithZone(date: Date, timezone: string): string {
  return `${formatInTimezone(date, timezone)} (heure : ${timezone})`;
}
