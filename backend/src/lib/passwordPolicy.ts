import { COMMON_PASSWORDS } from './data/commonPasswords.js';
import { PASSWORD_MAX_BYTES, PASSWORD_MAX_CODE_POINTS, PASSWORD_MIN_CODE_POINTS } from '../config/password.js';

const COMMON = new Set(COMMON_PASSWORDS);

/** Forme canonique d'un mot de passe (NFC) : appliquée AVANT tout hash et toute vérification. */
export function normalizePassword(password: string): string {
  return password.normalize('NFC');
}

export type PasswordProblem = 'too_short' | 'too_long' | 'too_many_bytes' | 'common';

/** Politique : 12–128 points de code, ≤ 256 octets UTF-8, absent de la liste des mots de passe courants. */
export function checkPasswordPolicy(raw: string): PasswordProblem | null {
  const password = normalizePassword(raw);
  // Points de code (et non unités UTF-16) : une paire de substitution compte pour un caractère.
  const codePoints = password.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '_').length;
  if (codePoints < PASSWORD_MIN_CODE_POINTS) return 'too_short';
  if (codePoints > PASSWORD_MAX_CODE_POINTS) return 'too_long';
  if (Buffer.byteLength(password, 'utf8') > PASSWORD_MAX_BYTES) return 'too_many_bytes';
  if (COMMON.has(password.toLowerCase())) return 'common';
  return null;
}
