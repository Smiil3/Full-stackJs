import Joi from 'joi';
import { MAX_AMOUNT_CENTS } from '../config/money.js';
import { FIELD_LIMITS } from '../config/fields.js';
import { PAGE_MAX, PAGE_SIZE_DEFAULT, PAGE_SIZE_MAX } from '../config/http.js';

/**
 * Chaîne de base de TOUTES les entrées texte : aucun caractère de contrôle Unicode (NUL, échappements
 * terminal, bidi…), sauf \n et \t pour les textes multilignes explicitement autorisés.
 */
// Caractères de contrôle C0/C1 + marques bidirectionnelles et BOM (usurpation visuelle, injection terminal).
// eslint-disable-next-line no-control-regex -- détection volontaire des caractères de contrôle
const CONTROL = /^[^\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]*$/u;
// Variante multiligne : autorise uniquement \t (U+0009) et \n (U+000A).
// eslint-disable-next-line no-control-regex -- idem, \t et \n exclus de la plage
const CONTROL_MULTILINE = /^[^\u0000-\u0008\u000B-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]*$/u;

/**
 * Par défaut, les espaces de début / fin sont retirés AVANT les règles de longueur suivantes
 * (un titre « ␣␣␣ » est vide ⇒ refusé). `trim: false` pour les secrets (mots de passe).
 */
export function text(options: { multiline?: boolean; trim?: boolean } = {}): Joi.StringSchema {
  const base = Joi.string()
    .pattern(options.multiline ? CONTROL_MULTILINE : CONTROL, 'texte sans caractère de contrôle')
    .messages({ 'string.pattern.name': '{{#label}} contient des caractères interdits', 'string.blank': '{{#label}} ne peut pas être vide' });
  if (options.trim === false) return base;
  return base.custom((value: string, helpers) => {
    const trimmed = value.trim();
    return trimmed === '' ? helpers.error('string.blank') : trimmed;
  });
}

/** UUID canonique (v4 pour nos identifiants, mais on accepte toute version RFC 4122 en entrée). */
export const uuid = Joi.string().guid({ version: ['uuidv4', 'uuidv7'] }).lowercase();
export const uuidStrict = Joi.string().guid({ version: ['uuidv4', 'uuidv7'] });

/** Date ISO 8601 avec fuseau explicite (Z ou ±hh:mm) : jamais d'heure locale ambiguë. */
export const isoDateInput = Joi.string()
  .max(FIELD_LIMITS.isoDateInput)
  .pattern(/^\d{4}-\d{2}-\d{2}T[\d:.]{5,12}(?:Z|[+-]\d{2}:\d{2})$/)
  .isoDate()
  .messages({ 'string.pattern.base': '{{#label}} doit être une date ISO 8601 avec fuseau (ex. 2026-11-14T19:00:00.000Z)' });

/** Date ISO 8601 UTC telle qu'émise par l'API (toISOString). */
export const isoDateOutput = Joi.string().pattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

export const nullable = <T extends Joi.Schema>(schema: T): T => schema.allow(null) as T;

/** Email : ASCII imprimable uniquement (même normalisation côté JS et SQL), 254 caractères max. */
export const email = text()
  .max(FIELD_LIMITS.email)
  .pattern(/^[\x21-\x7E]+$/, 'ascii')
  .email({ tlds: { allow: false } })
  .messages({ 'string.pattern.name': '{{#label}} doit être une adresse email ASCII' });

export const pageQuery = {
  page: Joi.number().integer().min(1).max(PAGE_MAX).default(1),
  pageSize: Joi.number().integer().min(1).max(PAGE_SIZE_MAX).default(PAGE_SIZE_DEFAULT),
};

export interface PageQuery {
  page: number;
  pageSize: number;
}

export function pageOf(item: Joi.Schema): Joi.ObjectSchema {
  return Joi.object({
    items: Joi.array().items(item),
    page: Joi.number().integer(),
    pageSize: Joi.number().integer(),
    total: Joi.number().integer(),
  });
}

export function itemsOf(item: Joi.Schema): Joi.ObjectSchema {
  return Joi.object({ items: Joi.array().items(item) });
}

/** Montant en centimes : entier positif borné au plafond métier (100 000 €). */
export const cents = Joi.number().integer().min(0).max(MAX_AMOUNT_CENTS);
export const roleSchema = Joi.string().valid('OWNER', 'MANAGER', 'SCANNER');

export function iso(date: Date): string;
export function iso(date: Date | null): string | null;
export function iso(date: Date | null): string | null {
  return date === null ? null : date.toISOString();
}

/** Valide un fuseau IANA connu du moteur (Intl). */
const TIMEZONES = new Set<string>([...Intl.supportedValuesOf('timeZone'), 'UTC']);
export const timezone = Joi.string()
  .max(FIELD_LIMITS.timezone)
  .custom((value: string, helpers) => (TIMEZONES.has(value) ? value : helpers.error('any.invalid')))
  .messages({ 'any.invalid': '{{#label}} doit être un fuseau horaire IANA valide' });
