import { describe, expect, it } from 'vitest';
import { describeEventTime } from './time';
import { lookup } from './lookup';

describe('lookup (revue F2.1 — M6)', () => {
  const table = { verified: 'ok' };
  it.each(['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf'])('« %s » ⇒ undefined', (k) => {
    expect(lookup(table, k)).toBeUndefined();
  });
  it('clé propre ⇒ valeur ; non-chaîne ⇒ undefined', () => {
    expect(lookup(table, 'verified')).toBe('ok');
    expect(lookup(table, null)).toBeUndefined();
    expect(lookup(table, 42)).toBeUndefined();
  });
  it('fuseau « Etc/constructor » : pas de fonction affichée comme nom de ville', () => {
    expect(describeEventTime('2026-11-14T19:00:00Z', 'Europe/Paris', 'Europe/Paris').event).toContain('Paris');
  });
});
