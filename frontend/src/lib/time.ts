/**
 * Utilitaire UNIQUE d'affichage / saisie des dates. Basé exclusivement sur `Intl.DateTimeFormat`
 * (données de fuseaux du navigateur, changements d'heure inclus). Aucune arithmétique manuelle
 * d'heure d'été : les décalages sont toujours lus pour l'instant précis concerné.
 *
 * Exigence client : l'heure est affichée dans le fuseau de l'événement, avec son nom et son décalage,
 * puis — si différente — l'heure locale de l'utilisateur.
 *   « sam. 14 nov. 2026, 20:00 — heure de Paris (UTC+1) »
 *   « soit 14:00 chez vous, New York (UTC−5) »
 */

import { lookup } from './lookup';

const LOCALE = 'fr-FR';
const MINUS = '−'; // signe moins typographique

/** Noms français des villes de fuseaux courants (les autres sont dérivés de l'identifiant IANA). */
const CITY_FR: Record<string, string> = {
  London: 'Londres',
  Brussels: 'Bruxelles',
  Lisbon: 'Lisbonne',
  Vienna: 'Vienne',
  Warsaw: 'Varsovie',
  Prague: 'Prague',
  Rome: 'Rome',
  Athens: 'Athènes',
  Moscow: 'Moscou',
  Copenhagen: 'Copenhague',
  Montreal: 'Montréal',
  Mexico_City: 'Mexico',
  Sao_Paulo: 'São Paulo',
  Algiers: 'Alger',
  Tunis: 'Tunis',
  Reunion: 'La Réunion',
  Martinique: 'Martinique',
  Guadeloupe: 'Guadeloupe',
  Noumea: 'Nouméa',
  Tahiti: 'Tahiti',
  Singapore: 'Singapour',
  Beirut: 'Beyrouth',
};

export function isValidTimeZone(tz: string): boolean {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat(LOCALE, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Liste des fuseaux IANA supportés par le navigateur (pour les sélecteurs du back-office). */
/**
 * Fuseau utilisable par Intl : un identifiant inconnu (donnée corrompue, navigateur ancien) ne doit pas
 * faire planter l'écran. On retombe sur UTC, affiché explicitement comme tel par describeEventTime.
 */
function zone(tz: string): string {
  return isValidTimeZone(tz) ? tz : 'UTC';
}

export function listTimeZones(): string[] {
  const intl = Intl as typeof Intl & { supportedValuesOf?: ((key: 'timeZone') => string[]) | undefined };
  const zones = typeof intl.supportedValuesOf === 'function' ? intl.supportedValuesOf('timeZone') : [];
  return zones.length > 0 ? zones : ['Europe/Paris', 'UTC'];
}

export function userTimeZone(): string {
  return zone(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
}

/** Ville lisible d'un fuseau IANA : "America/New_York" → "New York". */
export function timeZoneCity(tz: string): string {
  if (tz === 'UTC' || tz === 'Etc/UTC') return 'UTC';
  const last = tz.split('/').pop() ?? tz;
  return lookup(CITY_FR, last) ?? last.replace(/_/g, ' ');
}

/** « heure de Paris », « heure d'Amsterdam », « heure UTC ». */
export function timeZoneLabel(tz: string): string {
  const city = timeZoneCity(tz);
  if (city === 'UTC') return 'heure UTC';
  return /^[aeiouyhâéèêîôûAEIOUYHÂÉÈÊÎÔÛ]/.test(city) ? `heure d’${city}` : `heure de ${city}`;
}

type WallClock = { year: number; month: number; day: number; hour: number; minute: number; second: number };

function wallClock(epochMs: number, tz: string): WallClock {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone(tz),
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(epochMs));
  const get = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((p) => p.type === type)?.value ?? NaN);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute'), second: get('second') };
}

/** Décalage (minutes, est positif) du fuseau `tz` à l'instant `epochMs`. */
export function offsetMinutes(epochMs: number, tz: string): number {
  const w = wallClock(epochMs, tz);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  const truncated = Math.floor(epochMs / 1000) * 1000;
  return Math.round((asUtc - truncated) / 60_000);
}

/** « UTC+1 », « UTC−5 », « UTC+5:30 », « UTC ». */
export function formatOffset(minutes: number): string {
  if (minutes === 0) return 'UTC';
  const sign = minutes > 0 ? '+' : MINUS;
  const abs = Math.abs(minutes);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `UTC${sign}${h}${m ? `:${String(m).padStart(2, '0')}` : ''}`;
}

function toEpoch(iso: string | Date | number): number {
  if (typeof iso === 'number') return iso;
  const ms = iso instanceof Date ? iso.getTime() : Date.parse(iso);
  if (Number.isNaN(ms)) throw new RangeError(`Date invalide : ${String(iso)}`);
  return ms;
}

function part(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  return parts.find((p) => p.type === type)?.value ?? '';
}

/** « sam. 14 nov. 2026, 20:00 » dans le fuseau donné. */
export function formatDateTime(iso: string | Date | number, tz: string, opts: { withYear?: boolean } = {}): string {
  tz = zone(tz);
  const parts = new Intl.DateTimeFormat(LOCALE, {
    timeZone: tz,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: opts.withYear === false ? undefined : 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(toEpoch(iso)));
  const date = [part(parts, 'weekday'), part(parts, 'day'), part(parts, 'month'), opts.withYear === false ? '' : part(parts, 'year')]
    .filter(Boolean)
    .join(' ');
  return `${date}, ${part(parts, 'hour')}:${part(parts, 'minute')}`;
}

/** « sam. 14 nov. 2026 » dans le fuseau donné. */
export function formatDate(iso: string | Date | number, tz: string): string {
  tz = zone(tz);
  const parts = new Intl.DateTimeFormat(LOCALE, { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).formatToParts(
    new Date(toEpoch(iso)),
  );
  return [part(parts, 'weekday'), part(parts, 'day'), part(parts, 'month'), part(parts, 'year')].filter(Boolean).join(' ');
}

/** « 21:04 » dans le fuseau donné. */
export function formatTime(iso: string | Date | number, tz: string): string {
  tz = zone(tz);
  const parts = new Intl.DateTimeFormat(LOCALE, { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(
    new Date(toEpoch(iso)),
  );
  return `${part(parts, 'hour')}:${part(parts, 'minute')}`;
}

function sameCalendarDay(epochMs: number, tzA: string, tzB: string): boolean {
  const a = wallClock(epochMs, tzA);
  const b = wallClock(epochMs, tzB);
  return a.year === b.year && a.month === b.month && a.day === b.day;
}

export type EventTimeDisplay = {
  /** « sam. 14 nov. 2026, 20:00 — heure de Paris (UTC+1) » */
  event: string;
  /** « soit 14:00 chez vous, New York (UTC−5) », ou null si même heure locale. */
  local: string | null;
};

/**
 * Affichage complet d'un horaire d'événement.
 * `viewerTz` est injectable (tests) ; par défaut le fuseau du navigateur.
 */
export function describeEventTime(iso: string | Date, eventTz: string, viewerTz: string = userTimeZone()): EventTimeDisplay {
  const ms = toEpoch(iso);
  const evZone = zone(eventTz);
  const viewer = zone(viewerTz);
  const eventOffset = offsetMinutes(ms, evZone);
  const label = evZone === eventTz ? timeZoneLabel(evZone) : 'heure UTC — fuseau de l’événement non reconnu';
  const event = `${formatDateTime(ms, evZone)} — ${label} (${formatOffset(eventOffset)})`;

  const viewerOffset = offsetMinutes(ms, viewer);
  if (viewerOffset === eventOffset) return { event, local: null };

  const when = sameCalendarDay(ms, evZone, viewer) ? formatTime(ms, viewer) : formatDateTime(ms, viewer, { withYear: false });
  const local = `soit ${when} chez vous, ${timeZoneCity(viewer)} (${formatOffset(viewerOffset)})`;
  return { event, local };
}

// ---------------------------------------------------------------------------
// Saisie (back-office) : <input type="datetime-local"> exprimé dans le fuseau de l'événement
// ---------------------------------------------------------------------------

const LOCAL_INPUT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

/** ISO UTC → valeur "YYYY-MM-DDTHH:mm" pour un champ datetime-local, dans le fuseau `tz`. */
export function utcToZonedInput(iso: string, tz: string): string {
  tz = zone(tz);
  const w = wallClock(toEpoch(iso), tz);
  const p2 = (n: number) => String(n).padStart(2, '0');
  return `${String(w.year).padStart(4, '0')}-${p2(w.month)}-${p2(w.day)}T${p2(w.hour)}:${p2(w.minute)}`;
}

export type ZonedConversion =
  | { ok: true; iso: string; note: null | 'skipped' | 'ambiguous' }
  | { ok: false; reason: 'format' | 'timezone' };

/**
 * Heure murale saisie dans le fuseau `tz` → ISO UTC.
 * - heure inexistante (passage à l'heure d'été, ex. 02:30 le dernier dim. de mars à Paris) :
 *   décalée vers l'heure valide suivante, `note: 'skipped'` (l'UI doit prévenir l'organisateur) ;
 * - heure ambiguë (passage à l'heure d'hiver, 02:30 existe deux fois) : 1ʳᵉ occurrence, `note: 'ambiguous'`.
 */
export function zonedInputToUtc(value: string, tz: string): ZonedConversion {
  const m = LOCAL_INPUT_RE.exec(value);
  if (!m) return { ok: false, reason: 'format' };
  if (!isValidTimeZone(tz)) return { ok: false, reason: 'timezone' };
  const [y, mo, d, h, mi] = m.slice(1).map(Number) as [number, number, number, number, number];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return { ok: false, reason: 'format' };
  const wallAsUtc = Date.UTC(y, mo - 1, d, h, mi);
  if (new Date(wallAsUtc).getUTCDate() !== d) return { ok: false, reason: 'format' }; // 31 février…

  // Candidats : l'heure murale interprétée avec les décalages en vigueur ~1 jour avant et après.
  const offsets = new Set([offsetMinutes(wallAsUtc - 86_400_000, tz), offsetMinutes(wallAsUtc + 86_400_000, tz), offsetMinutes(wallAsUtc, tz)]);
  const matches: number[] = [];
  for (const off of offsets) {
    const candidate = wallAsUtc - off * 60_000;
    const w = wallClock(candidate, tz);
    if (w.year === y && w.month === mo && w.day === d && w.hour === h && w.minute === mi) matches.push(candidate);
  }
  const unique = [...new Set(matches)].sort((a, b) => a - b);
  if (unique.length >= 1) {
    return { ok: true, iso: new Date(unique[0] as number).toISOString(), note: unique.length > 1 ? 'ambiguous' : null };
  }
  // Heure sautée : on applique le décalage d'AVANT la transition, ce qui tombe juste après le saut.
  const before = offsetMinutes(wallAsUtc - 86_400_000, tz);
  return { ok: true, iso: new Date(wallAsUtc - before * 60_000).toISOString(), note: 'skipped' };
}

// ---------------------------------------------------------------------------
// Durées (comptes à rebours)
// ---------------------------------------------------------------------------

/** « 1 h 05 min », « 14 min 05 s », « 42 s », « 0 s ». */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(total / 86_400);
  const h = Math.floor((total % 86_400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (d > 0) return `${d} j ${h} h`;
  if (h > 0) return `${h} h ${String(m).padStart(2, '0')} min`;
  if (m > 0) return `${m} min ${String(s).padStart(2, '0')} s`;
  return `${s} s`;
}

/** « il y a 3 s », « il y a 2 min ». */
export function formatAgo(fromMs: number, nowMs: number = Date.now()): string {
  const s = Math.max(0, Math.round((nowMs - fromMs) / 1000));
  if (s < 60) return `il y a ${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `il y a ${m} min`;
  return `il y a ${Math.floor(m / 60)} h`;
}
