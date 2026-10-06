/**
 * Normalisation UNIQUE des adresses email, utilisée partout (inscription, connexion, ajout de membre,
 * création de collectif…) : suppression des espaces, forme Unicode NFC, minuscules.
 */
export function normalizeEmail(email: string): string {
  return email.trim().normalize('NFC').toLowerCase();
}
