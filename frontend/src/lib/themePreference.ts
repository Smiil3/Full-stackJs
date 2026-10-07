/**
 * Préférence de thème du visiteur (« Mode clair / sombre »), clé `ndg-theme`.
 *
 * SEULE exception à l'interdiction de localStorage (arbitrage PO, jalon D1) : valeur non sensible,
 * 'dark' ou 'light' uniquement, validée à la lecture ; aucune autre clé, aucune autre donnée.
 * Stockage indisponible (navigation privée, quota, refus) ⇒ silencieux : thème par défaut de la zone.
 */
export type ThemePreference = 'dark' | 'light';
const KEY = 'ndg-theme';

/* eslint-disable no-restricted-globals -- exception unique et justifiée : préférence d'affichage non sensible (D1) */
export function readThemePreference(): ThemePreference | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'dark' || v === 'light' ? v : null;
  } catch {
    return null;
  }
}

export function writeThemePreference(value: ThemePreference): void {
  try {
    localStorage.setItem(KEY, value);
  } catch {
    // préférence non mémorisée : rien de grave
  }
}

/** Réservé aux tests : oublie la préférence. */
export function __clearThemePreference(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // rien à effacer
  }
}
/* eslint-enable no-restricted-globals */
