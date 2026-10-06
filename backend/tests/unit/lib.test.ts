import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { computeServiceFee, percentOf } from '../../src/lib/money.js';
import { BIC_PATTERN, isValidIban, maskIban } from '../../src/lib/iban.js';
import { decryptString, encryptString, safeEqual, transferReference } from '../../src/lib/crypto.js';

describe('frais de service (entiers, round half up)', () => {
  it('fee = fixe + round_half_up(subtotal × bp / 10000)', () => {
    expect(computeServiceFee(10_000, 0, 250)).toBe(250); // 2,5 % de 100 €
    expect(computeServiceFee(1_000, 50, 250)).toBe(75); // 25 + 50
    expect(computeServiceFee(1_020, 0, 250)).toBe(26); // 25,5 → 26 (demi supérieur)
    expect(computeServiceFee(1_019, 0, 250)).toBe(25); // 25,475 → 25
    expect(computeServiceFee(1, 0, 1500)).toBe(0); // 0,15 → 0
    expect(computeServiceFee(4, 0, 1250)).toBe(1); // 0,5 → 1
    expect(computeServiceFee(5_000, 100, 0)).toBe(100);
  });
  it('commande gratuite ⇒ aucun frais', () => {
    expect(computeServiceFee(0, 100, 1500)).toBe(0);
  });
  it('gros montants sans perte de précision', () => {
    expect(computeServiceFee(20_000_000, 1000, 1500)).toBe(3_001_000);
  });
  it('pourcentage de remboursement arrondi au demi supérieur', () => {
    expect(percentOf(2500, 50)).toBe(1250);
    expect(percentOf(1001, 50)).toBe(501);
    expect(percentOf(999, 0)).toBe(0);
    expect(percentOf(999, 100)).toBe(999);
  });
});

describe('IBAN / BIC', () => {
  it('valide la clé mod 97', () => {
    expect(isValidIban('FR76 3000 6000 0112 3456 7890 189')).toBe(true);
    expect(isValidIban('fr7630006000011234567890189')).toBe(true);
    expect(isValidIban('FR76 3000 6000 0112 3456 7890 188')).toBe(false);
    expect(isValidIban('DE89370400440532013000')).toBe(true);
    expect(isValidIban('XX00')).toBe(false);
    expect(isValidIban('<script>')).toBe(false);
  });
  it('masque l’IBAN', () => {
    expect(maskIban('FR7630006000011234567890189')).toBe('FR76 •••• •••• 0189');
  });
  it('BIC 8 ou 11 caractères', () => {
    expect(BIC_PATTERN.test('AGRIFRPP')).toBe(true);
    expect(BIC_PATTERN.test('AGRIFRPP882')).toBe(true);
    expect(BIC_PATTERN.test('AGRIFRP')).toBe(false);
    expect(BIC_PATTERN.test('AGRIFRPP88')).toBe(false);
  });
});

describe('crypto', () => {
  it('chiffrement AES-GCM réversible et authentifié', () => {
    const key = randomBytes(32);
    const enc = encryptString('FR7630006000011234567890189', key);
    expect(enc).not.toContain('FR76');
    expect(decryptString(enc, key)).toBe('FR7630006000011234567890189');
    const tampered = enc.slice(0, -2) + (enc.endsWith('A') ? 'BB' : 'AA');
    expect(() => decryptString(tampered, key)).toThrow();
    expect(() => decryptString(enc, randomBytes(32))).toThrow();
  });
  it('comparaison à temps constant', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
  it('référence de virement unique et lisible', () => {
    const refs = new Set(Array.from({ length: 1000 }, () => transferReference()));
    expect(refs.size).toBe(1000);
    for (const r of refs) expect(r).toMatch(/^NG-[A-HJ-NP-Z2-9]{10}$/);
  });
});
