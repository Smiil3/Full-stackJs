const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
export const MIN_SEED_PASSWORD_LENGTH = 16;

/**
 * Le seed crée des comptes administrateurs au mot de passe connu de l'opérateur :
 * interdit en production et sur toute base qui n'est pas locale.
 */
export function assertSeedAllowed(input: { nodeEnv: string; databaseUrl: string; seedPassword: string }): void {
  if (input.nodeEnv === 'production') throw new Error('Le seed est interdit en production.');
  let host: string;
  try {
    host = new URL(input.databaseUrl).hostname;
  } catch {
    throw new Error('DATABASE_URL invalide.');
  }
  if (!LOCAL_HOSTS.has(host)) throw new Error(`Le seed ne s'exécute que sur une base locale (hôte reçu : ${host}).`);
  if (input.seedPassword !== '' && input.seedPassword.length < MIN_SEED_PASSWORD_LENGTH) {
    throw new Error(`SEED_PASSWORD doit faire au moins ${MIN_SEED_PASSWORD_LENGTH} caractères (ou rester vide pour un mot de passe aléatoire).`);
  }
}
