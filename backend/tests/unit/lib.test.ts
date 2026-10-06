import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { computeServiceFee, percentOf } from '../../src/lib/money.js';
import { BIC_PATTERN, isValidIban, maskIban } from '../../src/lib/iban.js';
import { aad, decryptString, encryptString, safeEqual, transferReference, type Keyring } from '../../src/lib/crypto.js';

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
  const ring = (id = 'k1', key = randomBytes(32)): Keyring => ({ current: { id, key }, byId: new Map([[id, key]]) });
  const IBAN = 'FR7630006000011234567890189';
  const ctx = 'org:11111111-1111-4111-8111-111111111111:bank_iban';

  /** Modifie un octet du segment décodé n° `index` (0 = version) du chiffré. */
  function flipByte(payload: string, index: number): string {
    const parts = payload.split('.');
    const bytes = Buffer.from(parts[index]!, 'base64url');
    bytes[0] = bytes[0]! ^ 0x01;
    parts[index] = bytes.toString('base64url');
    return parts.join('.');
  }

  it('chiffrement AES-GCM réversible, format v1.<kid>.<iv>.<tag>.<ct>', () => {
    const k = ring();
    const enc = encryptString(IBAN, k, ctx);
    expect(enc).not.toContain('FR76');
    expect(enc.split('.')).toHaveLength(5);
    expect(enc.startsWith('v1.k1.')).toBe(true);
    expect(decryptString(enc, k, ctx)).toBe(IBAN);
  });

  it('falsification d’un octet du chiffré, de l’IV ou du tag ⇒ échec', () => {
    const k = ring();
    const enc = encryptString(IBAN, k, ctx);
    for (const index of [2, 3, 4]) expect(() => decryptString(flipByte(enc, index), k, ctx)).toThrow();
    expect(() => decryptString(enc, ring('k1'), ctx)).toThrow();
  });

  it('tag tronqué ou IV de mauvaise taille ⇒ refusé avant déchiffrement', () => {
    const k = ring();
    const parts = encryptString(IBAN, k, ctx).split('.');
    const truncatedTag = [...parts];
    truncatedTag[3] = Buffer.from(parts[3]!, 'base64url').subarray(0, 4).toString('base64url');
    expect(() => decryptString(truncatedTag.join('.'), k, ctx)).toThrow(/tag/);
    const shortIv = [...parts];
    shortIv[2] = Buffer.from(parts[2]!, 'base64url').subarray(0, 8).toString('base64url');
    expect(() => decryptString(shortIv.join('.'), k, ctx)).toThrow(/IV/);
  });

  it('AAD : un chiffré recopié vers un autre contexte (autre org, commande) ne se déchiffre pas', () => {
    const k = ring();
    const enc = encryptString(IBAN, k, aad.orgBankIban('11111111-1111-4111-8111-111111111111'));
    expect(() => decryptString(enc, k, aad.orgBankIban('22222222-2222-4222-8222-222222222222'))).toThrow();
    expect(() => decryptString(enc, k, aad.orderTransferIban('11111111-1111-4111-8111-111111111111'))).toThrow();
  });

  it('rotation : une ancienne clé reste lisible, kid inconnu refusé', () => {
    const old = ring('k1');
    const enc = encryptString(IBAN, old, ctx);
    const newKey = randomBytes(32);
    const rotated: Keyring = { current: { id: 'k2', key: newKey }, byId: new Map([['k1', old.current.key], ['k2', newKey]]) };
    expect(decryptString(enc, rotated, ctx)).toBe(IBAN);
    expect(encryptString(IBAN, rotated, ctx).startsWith('v1.k2.')).toBe(true);
    expect(() => decryptString(enc, ring('k9'), ctx)).toThrow(/inconnue/);
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
