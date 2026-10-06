/**
 * Garde-fou : la suite de tests vide les tables (TRUNCATE … CASCADE). Elle ne doit JAMAIS viser
 * la base de développement : le nom de la base doit finir par `_test` et différer de DATABASE_URL.
 */
export function assertTestDatabaseUrl(testUrl: string | undefined, devUrl: string | undefined): string {
  if (!testUrl) throw new Error('TEST_DATABASE_URL manquant (voir .env.example)');
  let dbName: string;
  try {
    dbName = decodeURIComponent(new URL(testUrl).pathname.replace(/^\//, ''));
  } catch {
    throw new Error('TEST_DATABASE_URL invalide');
  }
  if (!dbName.endsWith('_test')) throw new Error(`La base de test doit finir par _test (reçu : ${dbName || '(vide)'})`);
  if (devUrl && testUrl === devUrl) throw new Error('TEST_DATABASE_URL doit différer de DATABASE_URL');
  return testUrl;
}
