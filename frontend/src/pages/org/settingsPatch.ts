import type { OrgSettings, OrgSettingsPatch } from '../../api/types';

type Editable = Omit<OrgSettings, 'bank'>;
export type SettingsDiff = { patch: OrgSettingsPatch; conflicts: (keyof Editable)[] };

/**
 * Patch des réglages calculé contre l'état INITIAL du formulaire (audit M6) : seuls les champs que
 * l'utilisateur a modifiés sont envoyés. Un de ces champs changé côté serveur entre-temps (par un
 * autre propriétaire) vers une autre valeur ⇒ conflit : on prévient au lieu d'écraser. Un champ
 * changé ailleurs mais pas ici n'est jamais renvoyé.
 */
export function settingsPatch(initial: Editable, current: Editable, desired: Partial<Editable>): SettingsDiff {
  const patch: OrgSettingsPatch = {};
  const conflicts: (keyof Editable)[] = [];
  for (const key of Object.keys(desired) as (keyof Editable)[]) {
    const wanted = desired[key];
    if (wanted === undefined || wanted === initial[key]) continue; // pas touché par l'utilisateur
    if (current[key] !== initial[key] && current[key] !== wanted) conflicts.push(key);
    else Object.assign(patch, { [key]: wanted });
  }
  return { patch, conflicts };
}
