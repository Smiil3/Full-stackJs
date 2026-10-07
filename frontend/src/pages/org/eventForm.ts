/** Conversion formulaire d'événement ⇄ corps d'API (dates saisies dans le fuseau de l'événement). */
import type { EventAdmin, EventCreateBody, EventOverrides, EventPatchBody, OrgSettings } from '../../api/types';
import { isValidTimeZone, utcToZonedInput, zonedInputToUtc } from '../../lib/time';
import { initialRulesState, rulesToOverrides, type RuleKey, type RulesState } from './salesRules';

export type EventFormState = {
  title: string;
  description: string;
  isOnline: boolean;
  venue: string;
  address: string;
  timezone: string;
  startsAt: string;
  endsAt: string;
  salesStartAt: string;
  salesEndAt: string;
  rules: RulesState;
};

export const DATE_FIELDS = ['startsAt', 'endsAt', 'salesStartAt', 'salesEndAt'] as const;
export type DateField = (typeof DATE_FIELDS)[number];

export function initialEventForm(event: EventAdmin | null, settings: OrgSettings | undefined): EventFormState {
  const tz = event?.timezone ?? settings?.defaultTimezone ?? 'Europe/Paris';
  const date = (iso: string | undefined) => (iso ? utcToZonedInput(iso, tz) : '');
  return {
    title: event?.title ?? '',
    description: event?.description ?? '',
    isOnline: event?.isOnline ?? false,
    venue: event?.venue ?? '',
    address: event?.address ?? '',
    timezone: tz,
    startsAt: date(event?.startsAt),
    endsAt: date(event?.endsAt),
    salesStartAt: date(event?.salesStartAt),
    salesEndAt: date(event?.salesEndAt),
    rules: initialRulesState(event?.overrides ?? null, settings),
  };
}

export type FormErrors = Partial<Record<keyof Omit<EventFormState, 'rules'>, string>> & { rules?: Partial<Record<RuleKey, string>> };

/** Valide côté UX (le serveur fait foi) et construit le corps. Notes = heures sautées / ambiguës. */
export function buildEventBody(
  f: EventFormState,
  settings: OrgSettings | undefined,
): { body: EventCreateBody | null; errors: FormErrors; notes: Partial<Record<DateField, string>> } {
  const errors: FormErrors = {};
  const notes: Partial<Record<DateField, string>> = {};
  const title = f.title.trim();
  if (title.length < 1 || title.length > 150) errors.title = 'Titre requis (150 caractères max).';
  if (f.description.length > 5000) errors.description = '5000 caractères maximum.';
  if (!isValidTimeZone(f.timezone)) errors.timezone = 'Fuseau horaire inconnu.';
  const iso: Partial<Record<DateField, string>> = {};
  for (const k of DATE_FIELDS) {
    if (!f[k]) {
      errors[k] = 'Date et heure requises.';
      continue;
    }
    const r = zonedInputToUtc(f[k], f.timezone);
    if (!r.ok) {
      errors[k] = 'Date invalide.';
      continue;
    }
    iso[k] = r.iso;
    if (r.note === 'skipped') notes[k] = 'Cette heure n’existe pas ce jour-là (passage à l’heure d’été) : elle sera décalée après le changement.';
    if (r.note === 'ambiguous') notes[k] = 'Cette heure existe deux fois ce jour-là (passage à l’heure d’hiver) : la première occurrence sera retenue.';
  }
  if (iso.startsAt && iso.endsAt && iso.endsAt <= iso.startsAt) errors.endsAt = 'La fin doit être après le début.';
  if (iso.salesStartAt && iso.salesEndAt && iso.salesEndAt <= iso.salesStartAt) errors.salesEndAt = 'La fin des ventes doit être après leur ouverture.';
  if (iso.salesEndAt && iso.endsAt && iso.salesEndAt > iso.endsAt) errors.salesEndAt = 'Les ventes doivent se terminer avant la fin de l’événement.';
  const { overrides, errors: ruleErrors } = rulesToOverrides(f.rules, settings);
  if (Object.keys(ruleErrors).length) errors.rules = ruleErrors;
  if (Object.keys(errors).length) return { body: null, errors, notes };
  return {
    body: {
      title,
      description: f.description.trim() || null,
      isOnline: f.isOnline,
      venue: f.venue.trim() || null,
      address: f.address.trim() || null,
      timezone: f.timezone,
      startsAt: iso.startsAt ?? '',
      endsAt: iso.endsAt ?? '',
      salesStartAt: iso.salesStartAt ?? '',
      salesEndAt: iso.salesEndAt ?? '',
      overrides,
    },
    errors,
    notes,
  };
}

/**
 * PATCH minimal (audit M'4) : chaque champ est comparé à l'état INITIAL du formulaire, jamais à
 * l'événement relu entre-temps : un champ que l'utilisateur n'a pas touché n'est JAMAIS envoyé (pas
 * d'écrasement d'une modification faite ailleurs, pas de surcharge financière périmée renvoyée par un
 * MANAGER). Dates : envoyées seulement si touchées ET réellement déplacées (à la minute) par rapport à
 * l'événement, ce qui évite un faux « report » dû à un arrondi.
 */
export function diffPatch(event: EventAdmin, initial: EventFormState, current: EventFormState, body: EventCreateBody): EventPatchBody {
  const patch: EventPatchBody = {};
  if (current.title !== initial.title) patch.title = body.title;
  if (current.description !== initial.description) patch.description = body.description ?? null;
  if (current.isOnline !== initial.isOnline) patch.isOnline = body.isOnline;
  if (current.venue !== initial.venue) patch.venue = body.venue ?? null;
  if (current.address !== initial.address) patch.address = body.address ?? null;
  const tzChanged = current.timezone !== initial.timezone;
  if (tzChanged) patch.timezone = body.timezone;
  // Comparaison en INSTANTS à la minute (précision de la saisie), seulement pour les champs touchés :
  // seul un vrai déplacement dans le temps est envoyé.
  const minute = (iso: string) => Math.floor(Date.parse(iso) / 60_000);
  for (const k of DATE_FIELDS) {
    if ((tzChanged || current[k] !== initial[k]) && minute(body[k]) !== minute(event[k])) patch[k] = body[k];
  }
  const overrides: Partial<EventOverrides> = {};
  for (const k of Object.keys(current.rules) as RuleKey[]) {
    const touched = JSON.stringify(current.rules[k]) !== JSON.stringify(initial.rules[k]);
    if (touched && body.overrides) Object.assign(overrides, { [k]: body.overrides[k] });
  }
  if (Object.keys(overrides).length) patch.overrides = overrides;
  return patch;
}

/** Événement avec des ventes (places vendues ou réservées) : un changement de dates est un REPORT. */
export function hasSales(event: EventAdmin | null): boolean {
  return event !== null && event.ticketTypes.some((t) => t.sold + t.held > 0);
}

export function isReschedule(event: EventAdmin | null, patch: EventPatchBody): boolean {
  return hasSales(event) && (patch.startsAt !== undefined || patch.endsAt !== undefined);
}

/**
 * Changement de fuseau : par défaut on CONSERVE L'INSTANT (les heures affichées sont converties, rien
 * ne bouge). « Conserver l'heure locale » déplace l'événement dans le temps : c'est un report.
 */
export function convertDatesToTimezone(f: EventFormState, fromTz: string, toTz: string): Pick<EventFormState, DateField> {
  const out = {} as Pick<EventFormState, DateField>;
  for (const k of DATE_FIELDS) {
    const r = zonedInputToUtc(f[k], fromTz);
    out[k] = r.ok ? utcToZonedInput(r.iso, toTz) : f[k];
  }
  return out;
}
