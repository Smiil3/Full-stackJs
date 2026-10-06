/**
 * Lecture d'une table de libellés avec une clé venant de l'extérieur (URL, réponse serveur).
 * `TABLE[cle]` renverrait des propriétés héritées pour « constructor », « __proto__ », « toString »…
 * On n'accepte que les clés PROPRES de la table.
 */
export function lookup<V>(table: Readonly<Record<string, V>>, key: unknown): V | undefined {
  return typeof key === 'string' && Object.hasOwn(table, key) ? table[key] : undefined;
}
