import { describe, expect, it } from 'vitest';
import { bicProblem, ibanProblem, normalizeIban } from './iban';

describe('IBAN / BIC (contrôles UX)', () => {
  it('IBAN valides (espaces, minuscules tolérés)', () => {
    expect(ibanProblem('FR76 3000 6000 0112 3456 7890 189')).toBeUndefined();
    expect(ibanProblem('fr7630006000011234567890189')).toBeUndefined();
    expect(ibanProblem('DE89 3704 0044 0532 0130 00')).toBeUndefined();
    expect(normalizeIban('fr76 3000-6000')).toBe('FR7630006000');
  });
  it.each([
    ['FR7630006000011234567890188', /clé de contrôle/],
    ['FR763000600001123456789018', /27 caractères/],
    ['1234', /Format/],
    ['FR76<script>', /Format/],
  ])('refuse %s', (iban, msg) => {
    expect(ibanProblem(iban)).toMatch(msg);
  });
  it('BIC', () => {
    expect(bicProblem('AGRIFRPP')).toBeUndefined();
    expect(bicProblem('agrifrppxxx')).toBeUndefined();
    expect(bicProblem('AGRI')).toBeDefined();
  });
});
