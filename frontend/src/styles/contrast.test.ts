// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/** Contraste WCAG 2.2 entre deux couleurs #RRGGBB. */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string): number {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (l1 + 0.05) / (l2 + 0.05);
}

const tokens = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8').toUpperCase();
const report = readFileSync(new URL('../../../docs/design-kit/design/contrast-report.md', import.meta.url), 'utf8');
const pairs = [...report.matchAll(/^OK\s+[\d.]+:1 \(min ([\d.]+)\) (#[0-9A-Fa-f]{6}) sur (#[0-9A-Fa-f]{6})\s+(.+)$/gm)].map((m) => ({
  min: Number(m[1]),
  fg: (m[2] ?? '').toUpperCase(),
  bg: (m[3] ?? '').toUpperCase(),
  label: (m[4] ?? '').trim(),
}));

/** Couples ajoutés par l'intégration (D1), hors rapport du kit. */
const EXTRA: { fg: string; bg: string; min: number; label: string }[] = [
  { fg: '#F4EFE6', bg: '#1C1A2B', min: 4.5, label: 'menu du back-office · texte' },
  { fg: '#B9B2CF', bg: '#1C1A2B', min: 4.5, label: 'menu du back-office · discret' },
  { fg: '#F4EFE6', bg: '#36305A', min: 4.5, label: 'menu du back-office · lien actif' },
  { fg: '#1A1407', bg: '#F3C76B', min: 4.5, label: 'menu du back-office · compteur' },
  { fg: '#F4EFE6', bg: '#1B1830', min: 4.5, label: 'QR plein écran · pastille « sans réseau »' },
  { fg: '#B9B2CF', bg: '#0B0A14', min: 4.5, label: 'QR plein écran · conseil' },
  { fg: '#F4EFE6', bg: '#0B0A14', min: 4.5, label: 'QR plein écran · titre' },
  { fg: '#7A72A8', bg: '#0B0A14', min: 3, label: 'QR plein écran · contour des boutons' },
  { fg: '#1E6B48', bg: '#F7F4EE', min: 4.5, label: 'Jour · « Réservation enregistrée »' },
  { fg: '#8A5A00', bg: '#FFFFFF', min: 4.5, label: 'Jour · texte or (offre, early) sur surface' },
  { fg: '#F3C76B', bg: '#1B1830', min: 4.5, label: 'Nuit · texte or (offre, early) sur surface' },
  { fg: '#FFFFFF', bg: '#1C1A2B', min: 4.5, label: 'scanner · bandeau hors-ligne' },
];

describe('contrastes (design/contrast-report.md, WCAG 2.2)', () => {
  it('le rapport couvre bien les couples attendus', () => {
    expect(pairs.length).toBeGreaterThan(40);
  });

  it.each(pairs)('$label : $fg sur $bg ≥ $min', ({ fg, bg, min }) => {
    expect(contrast(fg, bg)).toBeGreaterThanOrEqual(min);
  });

  it('chaque couleur du rapport existe encore dans tokens.css (rapport à jour)', () => {
    const missing = [...new Set(pairs.flatMap((p) => [p.fg, p.bg]))].filter((c) => !tokens.includes(c) && c !== '#FFFFFF');
    expect(missing).toEqual([]);
  });

  it.each(EXTRA)('ajout D1 — $label : $fg sur $bg ≥ $min', ({ fg, bg, min }) => {
    expect(contrast(fg, bg)).toBeGreaterThanOrEqual(min);
  });
});
