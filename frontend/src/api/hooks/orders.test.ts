import { describe, expect, it } from 'vitest';
import { runSessionCleanups } from '../../auth/sessionCleanup';
import { ApiError } from '../errors';
import type { Order } from '../types';
import { ATTEMPT_KEY_TTL_MS, createOrderWithKey, forgetIdempotencyKey, idempotencyKeyFor, orderFingerprint } from './orders';

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

  it('M5 : TTL — au-delà de 30 min, nouvelle clé', () => {
    const fp = orderFingerprint(body([{ ticketTypeId: 'ttl', quantity: 1 }]));
    const k = idempotencyKeyFor('u1', fp, 0);
    expect(idempotencyKeyFor('u1', fp, ATTEMPT_KEY_TTL_MS - 1)).toBe(k);
    expect(idempotencyKeyFor('u1', fp, ATTEMPT_KEY_TTL_MS)).not.toBe(k);
  });

  it('M5 : erreur transitoire ⇒ même clé au rejeu ; erreur non transitoire ⇒ clé oubliée', async () => {
    const b = body([{ ticketTypeId: 'err', quantity: 1 }]);
    const sent: string[] = [];
    const failWith = (e: ApiError) => (key: string) => {
      sent.push(key);
      return Promise.reject(e);
    };
    await expect(createOrderWithKey('u1', b, failWith(new ApiError({ status: 0, code: 'NETWORK_ERROR', message: '' })))).rejects.toThrow();
    await expect(createOrderWithKey('u1', b, failWith(new ApiError({ status: 503, code: 'INTERNAL_ERROR', message: '' })))).rejects.toThrow();
    expect(sent[1]).toBe(sent[0]); // réponse peut-être perdue : on retrouvera la même commande
    await expect(createOrderWithKey('u1', b, failWith(new ApiError({ status: 409, code: 'SOLD_OUT', message: '' })))).rejects.toThrow();
    expect(sent[2]).toBe(sent[0]);
    await expect(createOrderWithKey('u1', b, failWith(new ApiError({ status: 409, code: 'SOLD_OUT', message: '' })))).rejects.toThrow();
    expect(sent[3]).not.toBe(sent[0]); // refus définitif : la tentative suivante est une NOUVELLE commande
  });

  it('M5 : commande rendue EXPIRED ou CANCELLED ⇒ un seul nouvel envoi avec une clé neuve', async () => {
    for (const status of ['EXPIRED', 'CANCELLED'] as const) {
      const b = body([{ ticketTypeId: `old-${status}`, quantity: 1 }]);
      const sent: string[] = [];
      const order = await createOrderWithKey('u1', b, (key) => {
        sent.push(key);
        return Promise.resolve({ id: key, status: sent.length === 1 ? status : 'PENDING_PAYMENT' } as Order);
      });
      expect(sent).toHaveLength(2);
      expect(sent[1]).not.toBe(sent[0]);
      expect(order.status).toBe('PENDING_PAYMENT');
    }
  });
});
