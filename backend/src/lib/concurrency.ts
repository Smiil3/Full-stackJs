/**
 * Applique `fn` à chaque élément avec au plus `limit` appels simultanés, dans l'ordre de prise en charge ;
 * `shouldStop` est consulté avant chaque nouvel élément (budget de temps) : les éléments non lancés sont renvoyés.
 */
export async function mapLimit<T>(
  items: readonly T[], limit: number, fn: (item: T) => Promise<void>, shouldStop: () => boolean = () => false,
): Promise<{ notStarted: T[] }> {
  let next = 0;
  const notStarted: T[] = [];
  const lane = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      const item = items[index];
      if (item === undefined) return;
      if (shouldStop()) {
        notStarted.push(item);
        continue;
      }
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return { notStarted };
}
