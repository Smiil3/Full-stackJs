import { useCallback, useLayoutEffect, useState } from 'react';
import { readThemePreference, writeThemePreference, type ThemePreference } from './themePreference';

/**
 * Thème de la page (HANDOFF § 3) : préférence explicite du visiteur, sinon défaut de la zone —
 * Jour pour le paiement et le back-office, Nuit ailleurs. Le scanner reste toujours sombre.
 */
export function zoneTheme(pathname: string): { theme: ThemePreference; forced: boolean } {
  if (/^\/scan(\/|$)/.test(pathname)) return { theme: 'dark', forced: true };
  const sober = /^\/(org|admin|orders|mock-psp)(\/|$)/.test(pathname);
  return { theme: sober ? 'light' : 'dark', forced: false };
}

export function useTheme(pathname: string) {
  const [preference, setPreference] = useState<ThemePreference | null>(readThemePreference);
  const zone = zoneTheme(pathname);
  const theme = zone.forced ? zone.theme : (preference ?? zone.theme);
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  const toggle = useCallback(() => {
    const next: ThemePreference = theme === 'dark' ? 'light' : 'dark';
    writeThemePreference(next);
    setPreference(next);
  }, [theme]);
  return { theme, toggle, canToggle: !zone.forced };
}
