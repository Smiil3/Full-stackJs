import { describe, expect, it, vi } from 'vitest';
import { apiRequest, login, refreshSession } from '../api/client';
import { mock } from '../mocks/core';
import { DEMO_PASSWORD } from '../mocks/state';
import { getAccessToken } from './tokenStore';

describe('access token : mémoire uniquement', () => {
  it('n’est JAMAIS écrit dans localStorage, sessionStorage, document.cookie ni IndexedDB', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const cookieSetter = vi.fn();
    const cookieDesc = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie');
    Object.defineProperty(document, 'cookie', { configurable: true, get: () => '', set: cookieSetter });
    const idbOpen = vi.fn();
    vi.stubGlobal('indexedDB', { open: idbOpen, deleteDatabase: vi.fn() });

    try {
      await login('acheteur@example.test', DEMO_PASSWORD);
      mock.db.accessTokens.clear();
      await apiRequest('/auth/me'); // 401 ⇒ refresh ⇒ rejeu
      await refreshSession();

      const token = getAccessToken();
      expect(token).toBeTruthy();
      expect(setItem).not.toHaveBeenCalled();
      expect(cookieSetter).not.toHaveBeenCalled();
      // Seule base autorisée pendant l'authentification : le drapeau « déconnexion en attente » (sans secret).
      expect(idbOpen.mock.calls.map((c: unknown[]) => c[0]).filter((name) => name !== 'nuits-session')).toEqual([]);
      for (const store of [localStorage, sessionStorage]) {
        for (let i = 0; i < store.length; i++) {
          const key = store.key(i) ?? '';
          expect(store.getItem(key)).not.toContain(token);
        }
      }
    } finally {
      vi.unstubAllGlobals();
      if (cookieDesc) Object.defineProperty(document, 'cookie', cookieDesc);
      else Reflect.deleteProperty(document, 'cookie');
    }
  });
});
