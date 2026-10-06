/** Caractères qui, en tête de cellule, déclenchent une formule dans un tableur (injection CSV). */
const FORMULA_TRIGGERS = new Set(['=', '+', '-', '@', '\t', '\r']);

/**
 * Cellule CSV sûre :
 * - neutralisation des formules (préfixe `'` si la cellule commence par = + - @ tabulation ou retour chariot) ;
 * - échappement : guillemets doublés, cellule entourée de guillemets si elle contient ; " ou un saut de ligne.
 */
export function csvCell(value: string | number | null): string {
  let text = value === null ? '' : String(value);
  if (text.length > 0 && FORMULA_TRIGGERS.has(text.charAt(0))) text = `'${text}`;
  if (/[;"\r\n]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function csvRow(values: (string | number | null)[]): string {
  return `${values.map(csvCell).join(';')}\r\n`;
}

/** BOM UTF-8 : accents corrects à l'ouverture dans Excel. */
export const UTF8_BOM = '﻿';
