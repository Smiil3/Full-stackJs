import { describe, expect, it } from 'vitest';
import { apiRequest } from './client';
import { ApiError, errorMessage, fieldErrors } from './errors';
import { ERROR_CODES } from './types';

describe('messages d’erreur', () => {
  it('chaque code du contrat a un message français non technique', () => {
    for (const code of ERROR_CODES) {
      const msg = errorMessage(new ApiError({ status: 400, code, message: 'raw server message' }));
      expect(msg).not.toContain('raw server message');
      expect(msg.length).toBeGreaterThan(10);
    }
  });

  it('LIMIT_EXCEEDED exploite details.max et details.alreadyOwned', () => {
    const e = new ApiError({ status: 422, code: 'LIMIT_EXCEEDED', message: '', details: { max: 6, alreadyOwned: 4 } });
    expect(errorMessage(e)).toBe('Vous ne pouvez pas dépasser 6 places. Vous en avez déjà 4.');
  });

  it('erreur inconnue (non ApiError) ⇒ message générique', () => {
    expect(errorMessage(new TypeError('boom'))).toBe(errorMessage(new ApiError({ status: 500, code: 'INTERNAL_ERROR', message: '' })));
  });

  it('F6-B3 : fieldErrors indexe par chemin avec des libellés FR connus, jamais le texte du serveur', () => {
    const fields = [
      { path: 'email', message: '"email" must be a valid email <img src=x>' },
      { path: 'bank.iban', message: 'raw' },
      { path: 'items.0.quantity', message: 'raw' },
      { path: 'overrides.maxPerUser', message: 'raw' },
      { path: 'champInconnu', message: 'texte serveur arbitraire' },
      { path: '__proto__', message: 'raw' },
    ];
    const e = new ApiError({ status: 400, code: 'VALIDATION_ERROR', message: '', details: { fields } });
    const out = fieldErrors(e);
    expect(out.email).toBe('Adresse email invalide.');
    expect(out['bank.iban']).toBe('IBAN invalide.');
    expect(out['items.0.quantity']).toBe('Quantité invalide.');
    expect(out['overrides.maxPerUser']).toMatch(/maximum de places par commande/);
    expect(out.champInconnu).toBe('Valeur invalide : vérifiez ce champ.');
    for (const m of Object.values(out)) expect(m).not.toMatch(/raw|must be|<img|serveur arbitraire/);
    expect(fieldErrors(new Error('x'))).toEqual({});
  });

  it('413 / 415 du contrat v1.3 sont décodés', async () => {
    const big = 'x'.repeat(11_000);
    await expect(apiRequest('/auth/login', { method: 'POST', auth: false, body: { email: big, password: big } })).rejects.toMatchObject({ status: 413, code: 'PAYLOAD_TOO_LARGE' });
  });
});
