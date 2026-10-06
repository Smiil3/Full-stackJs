/**
 * Affiche « reflet » (motif de la marque) : mois, jour, horizon et jour reflété. Décorative (aria-hidden) :
 * la date est toujours écrite en clair à côté. Teinte tirée de l'identifiant (classe, jamais de style en ligne).
 */
function posterTone(id: string): number {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) % 9973;
  return (h % 4) + 1;
}

function dateParts(iso: string, timeZone: string): { month: string; day: string } {
  const d = new Date(iso);
  const month = new Intl.DateTimeFormat('fr-FR', { month: 'short', timeZone }).format(d).replace('.', '').toUpperCase();
  const day = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', timeZone }).format(d);
  return { month, day };
}

export function Poster({ id, iso, timeZone, hero, title }: { id: string; iso: string; timeZone: string; hero?: boolean; title?: string }) {
  const { month, day } = dateParts(iso, timeZone);
  return (
    <div className={`poster poster--tone-${posterTone(id)}${hero ? ' poster--hero' : ''}`} aria-hidden="true">
      {hero && title ? <span className="poster__title">{title}</span> : null}
      <span className="poster__month">{month}</span>
      <span className="poster__day">{day}</span>
      <span className="poster__horizon" />
      <span className="poster__reflect">{day}</span>
    </div>
  );
}
