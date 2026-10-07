import { afterEach, describe, expect, it } from 'vitest';
import { assertTicketKeyConfig, parseTicketKey, trustedKeyFor, UntrustedKeyError, __setPinnedTicketKey } from './pinnedKey';

const PINNED = { kty: 'OKP', crv: 'Ed25519', x: 'AhigxYmL0SJe6AbpQgVy6DOurnhSVLQv0CXQFgslXDE' } as const;
const OTHER = { kty: 'OKP', crv: 'Ed25519', x: 'BBBBxYmL0SJe6AbpQgVy6DOurnhSVLQv0CXQFgslXDE' } as const;

describe('clé publique des billets épinglée (audit B14)', () => {
  afterEach(() => {
    __setPinnedTicketKey(null);
  });

  it('format validé : JWK OKP / Ed25519, x de 32 octets, aucun autre champ (jamais une clé privée)', () => {
    expect(parseTicketKey(JSON.stringify(PINNED))).toEqual(PINNED);
    expect(parseTicketKey(undefined)).toBeNull();
    for (const bad of ['{', '{"kty":"OKP","crv":"Ed25519","x":"court"}', JSON.stringify({ ...PINNED, d: 'clé privée' }), JSON.stringify({ ...PINNED, crv: 'X25519' })]) {
      expect(() => parseTicketKey(bad), bad).toThrow(/VITE_TICKET_PUBLIC_KEY_JWK/);
    }
  });

  it('obligatoire en production, facultative en développement', () => {
    expect(() => assertTicketKeyConfig({ raw: undefined, isProd: true })).toThrow(/obligatoire en production/);
    expect(() => assertTicketKeyConfig({ raw: undefined, isProd: false })).not.toThrow();
    expect(() => assertTicketKeyConfig({ raw: JSON.stringify(PINNED), isProd: true })).not.toThrow();
  });

  it('liste dont la clé diffère ⇒ refusée ; même clé ⇒ la clé ÉPINGLÉE est utilisée', () => {
    __setPinnedTicketKey(PINNED);
    expect(() => trustedKeyFor(OTHER)).toThrow(UntrustedKeyError);
    expect(trustedKeyFor({ ...PINNED })).toEqual(PINNED);
  });

  it('sans clé épinglée (développement) ⇒ clé de la liste', () => {
    expect(trustedKeyFor(OTHER)).toEqual(OTHER);
  });
});
