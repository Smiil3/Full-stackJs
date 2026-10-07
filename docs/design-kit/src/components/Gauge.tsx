// Gauge.tsx — jauge de remplissage du back-office (vendu + en attente).
// Compatible CSP : les largeurs sont des ATTRIBUTS SVG (width="60%"),
// pas des styles en ligne. « En attente » est hachuré pour ne pas
// reposer sur la couleur seule. Le texte (pourcentage) reste affiché à côté.

import { useId } from "react";

type Props = {
  capacity: number;
  sold: number;
  pending: number;
};

export function Gauge({ capacity, sold, pending }: Props) {
  // useId peut contenir « : » ou « « » » : on nettoie pour url(#…)
  const id = "hatch-" + useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const pct = (n: number) => (capacity > 0 ? Math.min(100, Math.round((n / capacity) * 100)) : 0);
  const soldPct = pct(sold);
  const pendingPct = Math.min(100 - soldPct, pct(pending));
  const left = Math.max(0, capacity - sold - pending);
  const label =
    left === 0
      ? `Complet : ${soldPct} % vendu, ${pendingPct} % en attente de virement`
      : `${soldPct} % vendu, ${pendingPct} % en attente de virement`;

  return (
    <div className="gauge-row">
      <svg className="gauge" role="img" aria-label={label} viewBox="0 0 100 12" preserveAspectRatio="none">
        <defs>
          <pattern id={id} width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect className="gauge__hatch-b" width="4" height="4" />
            <rect className="gauge__hatch-a" width="2" height="4" />
          </pattern>
        </defs>
        <rect className="gauge__track" width="100" height="12" />
        <rect className="gauge__sold" width={soldPct} height="12" />
        <rect className="gauge__pending" x={soldPct} width={pendingPct} height="12" fill={`url(#${id})`} />
      </svg>
      <span className="tabular" aria-hidden="true">
        {left === 0 ? "Complet" : `${soldPct + pendingPct} %`}
      </span>
    </div>
  );
}
