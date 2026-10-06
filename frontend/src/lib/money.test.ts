import { describe, expect, it } from 'vitest';
import { basisPointsToPercentInput, centsToEurosInput, estimateServiceFeeCents, eurosToCents, formatCents, percentToBasisPoints } from './money';

describe('eurosToCents (sans erreur d’arrondi flottant)', () => {
  it.each([
    ['19,99', 1999],
    ['19.99', 1999],
    ['0,29', 29],
    ['0.57', 57],
    ['1.005', null],
    ['12', 1200],
    ['12,5', 1250],
    ['12,', 1200],
    ['1 234,56', 123456],
    ['1 234,56', 123456],
    ['10000', 1000000],
    ['10000,01', null],
    ['-5', null],
    ['abc', null],
    ['', null],
    ['1e3', null],
    ['0x10', null],
  ])('%s → %s', (input, expected) => {
    const r = eurosToCents(input);
    expect(r.ok ? r.value : null).toBe(expected);
  });

  it('cas pièges du flottant : aucun écart sur tous les centimes de 0 à 100 €', () => {
    for (let c = 0; c <= 10000; c++) {
      const r = eurosToCents(centsToEurosInput(c));
      expect(r.ok && r.value).toBe(c);
    }
  });
});

describe('pourcentages ⇄ points de base', () => {
  it.each([
    ['2,5', 250],
    ['2.55', 255],
    ['15', 1500],
    ['0', 0],
    ['15,01', null],
    ['2,555', null],
  ])('%s → %s', (input, expected) => {
    const r = percentToBasisPoints(input);
    expect(r.ok ? r.value : null).toBe(expected);
  });
  it('affichage', () => {
    expect(basisPointsToPercentInput(250)).toBe('2,5');
    expect(basisPointsToPercentInput(1500)).toBe('15');
    expect(basisPointsToPercentInput(5)).toBe('0,05');
  });
});

describe('frais de service (estimation, formule du contrat)', () => {
  it('fixe + arrondi au centime supérieur à partir de 0,5', () => {
    expect(estimateServiceFeeCents(3700, 50, 250)).toBe(50 + 93); // 92,5 → 93
    expect(estimateServiceFeeCents(1000, 0, 0)).toBe(0);
    expect(estimateServiceFeeCents(1, 0, 1500)).toBe(0); // 0,15 → 0
    expect(estimateServiceFeeCents(4, 0, 1250)).toBe(1); // 0,5 → 1
  });
});

describe('formatCents', () => {
  it('format français', () => {
    expect(formatCents(1500).replace(/\s/g, ' ')).toBe('15,00 €');
    expect(formatCents(123456).replace(/\s/g, ' ')).toBe('1 234,56 €');
    expect(formatCents(Number.NaN)).toBe('—');
  });
});
