/** « Les Nuits de la Garonne » → « les-nuits-de-la-garonne » (ASCII, contrat : ^[a-z0-9-]{2,40}$). */
export function slugify(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}
