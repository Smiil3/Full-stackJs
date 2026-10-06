/** Chargement : squelettes à la forme du contenu (cartes ou tableau), annoncé aux lecteurs d'écran. */
export function PageLoader({ label = 'Chargement…', shape = 'cards' }: { label?: string; shape?: 'cards' | 'table' | 'text' }) {
  return (
    <div className="loader" role="status" aria-live="polite">
      <span className="visually-hidden">{label}</span>
      {shape === 'cards'
        ? [0, 1, 2].map((i) => (
            <div key={i} className="card event-card" aria-hidden="true">
              <span className="skeleton skeleton--poster" />
              <span className="stack stack--sm">
                <span className="skeleton skeleton--title" />
                <span className="skeleton skeleton--text" />
                <span className="skeleton skeleton--text" />
              </span>
            </div>
          ))
        : shape === 'table'
          ? (
            <div className="stack stack--sm" aria-hidden="true">
              <div className="kpis">
                {[0, 1, 2].map((i) => (
                  <span key={i} className="kpi">
                    <span className="skeleton skeleton--text" />
                    <span className="skeleton skeleton--title" />
                  </span>
                ))}
              </div>
              {[0, 1, 2, 3].map((i) => (
                <span key={i} className="skeleton skeleton--text" />
              ))}
            </div>
          )
          : (
            <div className="stack stack--sm" aria-hidden="true">
              <span className="skeleton skeleton--title" />
              <span className="skeleton skeleton--text" />
              <span className="skeleton skeleton--text" />
            </div>
          )}
    </div>
  );
}
