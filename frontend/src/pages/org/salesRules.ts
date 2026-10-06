/**
 * Paramètres de vente configurables (plan § Paramètres configurables) : définitions, conversion
 * saisie ⇄ valeur API (sans flottant), et calcul de la valeur effective (événement ?? collectif).
 */
import type { EventOverrides, OrgSettings } from '../../api/types';
import { basisPointsToPercentInput, centsToEurosInput, eurosToCents, formatBasisPoints, formatCents, percentToBasisPoints } from '../../lib/money';

export type RuleKey = keyof EventOverrides;
type Kind = 'int' | 'bool' | 'euros' | 'basisPoints';
export type RuleDef = { key: RuleKey; label: string; kind: Kind; min: number; max: number; unit?: string; hint?: string };

export const RULE_DEFS: readonly RuleDef[] = [
  { key: 'cardHoldMinutes', label: 'Délai de paiement par carte', kind: 'int', min: 5, max: 60, unit: 'min' },
  { key: 'transferEnabled', label: 'Paiement par virement', kind: 'bool', min: 0, max: 1 },
  { key: 'transferHoldHours', label: 'Délai pour effectuer un virement', kind: 'int', min: 1, max: 240, unit: 'h' },
  { key: 'selfCancellationEnabled', label: 'Annulation par l’acheteur', kind: 'bool', min: 0, max: 1 },
  { key: 'cancellationDeadlineHours', label: 'Annulation possible jusqu’à … avant le début', kind: 'int', min: 0, max: 720, unit: 'h', hint: '0 = jusqu’au début de l’événement' },
  { key: 'refundPercent', label: 'Remboursement du prix des billets', kind: 'int', min: 0, max: 100, unit: '%' },
  { key: 'maxPerOrder', label: 'Places maximum par commande', kind: 'int', min: 1, max: 20 },
  { key: 'maxPerUser', label: 'Places maximum par personne', kind: 'int', min: 1, max: 50, hint: 'Doit être au moins égal au maximum par commande' },
  { key: 'waitlistEnabled', label: 'Liste d’attente', kind: 'bool', min: 0, max: 1 },
  { key: 'waitlistOfferMinutes', label: 'Délai de réponse à une offre de liste d’attente', kind: 'int', min: 15, max: 2880, unit: 'min' },
  { key: 'serviceFeeFixedCents', label: 'Frais de service fixes par commande', kind: 'euros', min: 0, max: 1000, unit: '€' },
  { key: 'serviceFeeBasisPoints', label: 'Frais de service proportionnels', kind: 'basisPoints', min: 0, max: 1500, unit: '%' },
];

export type RuleValue = number | boolean;

export function formatRule(def: RuleDef, value: RuleValue): string {
  if (def.kind === 'bool') return value ? 'activé' : 'désactivé';
  if (typeof value !== 'number') return '—';
  if (def.kind === 'euros') return formatCents(value);
  if (def.kind === 'basisPoints') return formatBasisPoints(value);
  return `${value}${def.unit ? ` ${def.unit}` : ''}`;
}

export function toInput(def: RuleDef, value: RuleValue): string {
  if (def.kind === 'bool') return value ? 'true' : 'false';
  if (typeof value !== 'number') return '';
  if (def.kind === 'euros') return centsToEurosInput(value);
  if (def.kind === 'basisPoints') return basisPointsToPercentInput(value);
  return String(value);
}

/** Analyse une saisie ; renvoie la valeur API ou un message d'erreur. */
export function parseRule(def: RuleDef, text: string): { ok: true; value: RuleValue } | { ok: false; error: string } {
  const bounds = `entre ${formatRule(def, def.min)} et ${formatRule(def, def.max)}`;
  if (def.kind === 'bool') return text === 'true' || text === 'false' ? { ok: true, value: text === 'true' } : { ok: false, error: 'Choix requis' };
  if (def.kind === 'euros') {
    const r = eurosToCents(text, def.max);
    return r.ok && r.value >= def.min ? { ok: true, value: r.value } : { ok: false, error: `Montant ${bounds}` };
  }
  if (def.kind === 'basisPoints') {
    const r = percentToBasisPoints(text, def.max);
    return r.ok && r.value >= def.min ? { ok: true, value: r.value } : { ok: false, error: `Pourcentage ${bounds} (2 décimales max)` };
  }
  if (!/^\d{1,6}$/.test(text.trim())) return { ok: false, error: `Nombre entier ${bounds}` };
  const n = Number(text.trim());
  return n >= def.min && n <= def.max ? { ok: true, value: n } : { ok: false, error: `Nombre entier ${bounds}` };
}

/** Valeur du collectif pour une règle (OrgSettings porte les mêmes clés). */
export function orgValue(settings: OrgSettings, key: RuleKey): RuleValue {
  return settings[key];
}

// ---------------------------------------------------------------------------
// État de formulaire « hérite / personnalisé »
// ---------------------------------------------------------------------------
export type RuleField = { mode: 'inherit' | 'custom'; text: string };
export type RulesState = Record<RuleKey, RuleField>;

export function initialRulesState(overrides: EventOverrides | null, settings: OrgSettings | undefined): RulesState {
  const out = {} as RulesState;
  for (const def of RULE_DEFS) {
    const own = overrides?.[def.key] ?? null;
    const fallback = settings ? orgValue(settings, def.key) : def.kind === 'bool' ? true : def.min;
    out[def.key] = own === null ? { mode: 'inherit', text: toInput(def, fallback) } : { mode: 'custom', text: toInput(def, own) };
  }
  return out;
}

/** Convertit l'état en `overrides` (null = hérite) ; erreurs indexées par clé. */
export function rulesToOverrides(state: RulesState, settings: OrgSettings | undefined): { overrides: EventOverrides; errors: Partial<Record<RuleKey, string>> } {
  const overrides = {} as Record<RuleKey, RuleValue | null>;
  const errors: Partial<Record<RuleKey, string>> = {};
  for (const def of RULE_DEFS) {
    const f = state[def.key];
    if (f.mode === 'inherit') {
      overrides[def.key] = null;
      continue;
    }
    const r = parseRule(def, f.text);
    if (r.ok) overrides[def.key] = r.value;
    else {
      overrides[def.key] = null;
      errors[def.key] = r.error;
    }
  }
  if (settings && !errors.maxPerOrder && !errors.maxPerUser) {
    const perOrder = (overrides.maxPerOrder as number | null) ?? settings.maxPerOrder;
    const perUser = (overrides.maxPerUser as number | null) ?? settings.maxPerUser;
    if (perUser < perOrder) errors.maxPerUser = `Doit être au moins égal au maximum par commande (${perOrder})`;
  }
  return { overrides: overrides as EventOverrides, errors };
}
