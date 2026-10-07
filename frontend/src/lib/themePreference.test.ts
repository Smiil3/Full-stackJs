import { afterEach, describe, expect, it, vi } from 'vitest';
import { readThemePreference, writeThemePreference } from './themePreference';

describe('préférence de thème (seule clé localStorage autorisée, D1)', () => {
  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('mémorise « dark » / « light » sous la seule clé ndg-theme', () => {
    expect(readThemePreference()).toBeNull();
    writeThemePreference('light');
    expect(readThemePreference()).toBe('light');
    expect(Object.keys(localStorage)).toEqual(['ndg-theme']);
    writeThemePreference('dark');
    expect(localStorage.getItem('ndg-theme')).toBe('dark');
  });

  it('valeur inattendue ⇒ ignorée', () => {
    localStorage.setItem('ndg-theme', '<script>');
    expect(readThemePreference()).toBeNull();
  });

  it('stockage indisponible ⇒ aucune erreur, thème par défaut', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    expect(readThemePreference()).toBeNull();
    expect(() => {
      writeThemePreference('light');
    }).not.toThrow();
  });
});
