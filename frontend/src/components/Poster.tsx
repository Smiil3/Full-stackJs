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

export function Poster({ id, iso, timeZone, hero, title, eyebrow }: { id: string; iso: string; timeZone: string; hero?: boolean; title?: string; eyebrow?: string }) {
  const { month, day } = dateParts(iso, timeZone);
  if (hero && title) {
    // Grande affiche : bandeau (collectif · date), titre, horizon et dernier mot reflété.
    const last = title.trim().split(/\s+/).pop() ?? title;
    return (
      <div className={`poster poster--hero poster--tone-${posterTone(id)}`} aria-hidden="true">
        {eyebrow ? <span className="poster__month">{eyebrow.toUpperCase()}</span> : null}
        <span className="poster__title">{title}</span>
        <span className="poster__horizon" />
        <span className="poster__reflect">{last}</span>
      </div>
    );
  }
  return (
    <div className={`poster poster--tone-${posterTone(id)}`} aria-hidden="true">
      <span className="poster__month">{month}</span>
      <span className="poster__day">{day}</span>
      <span className="poster__horizon" />
      <span className="poster__reflect">{day}</span>
    </div>
  );
}
