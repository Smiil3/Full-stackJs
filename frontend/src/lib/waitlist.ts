/** Position dans la file : « 4ᵉ » (1 ⇒ « en tête de la liste »). */
export function positionLabel(position: number): string {
  return position <= 1 ? 'en tête de la liste' : `${position}ᵉ`;
}
