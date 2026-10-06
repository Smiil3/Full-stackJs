/**
 * Icônes SVG locales via le sprite `public/icons.svg` (kit « Miroir d'eau »).
 * Compatible CSP : aucun style en ligne, aucun chargement externe ; couleur héritée (currentColor).
 * Décorative par défaut (aria-hidden). Icône porteuse de sens SANS texte visible : passer `label`.
 */
export type IconName =
  | 'menu' | 'close' | 'chevron-left' | 'chevron-right' | 'chevron-down' | 'arrow-right' | 'ticket' | 'search'
  | 'calendar' | 'calendar-x' | 'clock' | 'map-pin' | 'globe' | 'share' | 'copy' | 'check' | 'check-circle'
  | 'x-octagon' | 'alert-triangle' | 'info' | 'wifi-off' | 'sun' | 'moon' | 'qr' | 'card' | 'bank' | 'refund'
  | 'retry' | 'download' | 'minus' | 'plus' | 'tag' | 'mail' | 'users' | 'dashboard' | 'list' | 'file-text'
  | 'settings' | 'flashlight' | 'keyboard' | 'hourglass';

const SPRITE = `${import.meta.env.BASE_URL}icons.svg`;

export function Icon({ name, size = 'md', label, className }: { name: IconName; size?: 'sm' | 'md' | 'lg'; label?: string; className?: string }) {
  const classes = ['icon', size !== 'md' ? `icon--${size}` : '', className ?? ''].filter(Boolean).join(' ');
  return (
    <svg className={classes} aria-hidden={label ? undefined : true} role={label ? 'img' : undefined} aria-label={label} focusable="false">
      <use href={`${SPRITE}#i-${name}`} />
    </svg>
  );
}
