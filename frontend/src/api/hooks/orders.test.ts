import { describe, expect, it } from 'vitest';
import { runSessionCleanups } from '../../auth/sessionCleanup';
import { forgetIdempotencyKey, idempotencyKeyFor, orderFingerprint } from './orders';

const body = (items: { ticketTypeId: string; quantity: number }[]) => ({ eventId: 'e', paymentMethod: 'CARD' as const, items });

describe('clés d’idempotence (revue F2.1 — B5)', () => {
  it('même utilisateur + même panier (ordre indifférent) ⇒ même clé ; autre utilisateur ou panier ⇒ autre clé', () => {
    const a = orderFingerprint(body([{ ticketTypeId: 'x', quantity: 1 }, { ticketTypeId: 'y', quantity: 2 }]));
    const b = orderFingerprint(body([{ ticketTypeId: 'y', quantity: 2 }, { ticketTypeId: 'x', quantity: 1 }]));
    expect(a).toBe(b);
    const k = idempotencyKeyFor('u1', a);
    expect(idempotencyKeyFor('u1', b)).toBe(k);
    expect(idempotencyKeyFor('u2', a)).not.toBe(k);
    expect(idempotencyKeyFor('u1', orderFingerprint(body([{ ticketTypeId: 'x', quantity: 2 }])))).not.toBe(k);
    forgetIdempotencyKey('u1', a);
    expect(idempotencyKeyFor('u1', a)).not.toBe(k);
  });

  it('panier avec un type de place en double ⇒ refusé', () => {
    expect(() => orderFingerprint(body([{ ticketTypeId: 'x', quantity: 1 }, { ticketTypeId: 'x', quantity: 1 }]))).toThrow('type de place en double');
  });

  it('fin de session ⇒ clés oubliées', async () => {
    const fp = orderFingerprint(body([{ ticketTypeId: 'x', quantity: 1 }]));
    const k = idempotencyKeyFor('u1', fp);
    await runSessionCleanups();
    expect(idempotencyKeyFor('u1', fp)).not.toBe(k);
  });
});
