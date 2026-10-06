// Icon.tsx — icônes SVG locales via le sprite /icons.svg (public/icons.svg).
// Compatible CSP : aucun style en ligne, aucun chargement externe.
// Les icônes héritent de la couleur du texte (stroke="currentColor").
// Décoratives par défaut (aria-hidden). Pour une icône porteuse de sens SANS
// texte visible, passer `label` : elle devient role="img" avec un titre.

export type IconName = "menu" | "close" | "chevron-left" | "chevron-right" | "chevron-down" | "arrow-right" | "ticket" | "search" | "calendar" | "calendar-x" | "clock" | "map-pin" | "globe" | "share" | "copy" | "check" | "check-circle" | "x-octagon" | "alert-triangle" | "info" | "wifi-off" | "sun" | "moon" | "qr" | "card" | "bank" | "refund" | "retry" | "download" | "minus" | "plus" | "tag" | "mail" | "users" | "dashboard" | "list" | "file-text" | "settings" | "flashlight" | "keyboard" | "hourglass";

type Props = {
  name: IconName;
  size?: "sm" | "md" | "lg";
  label?: string;
  className?: string;
};

export function Icon({ name, size = "md", label, className }: Props) {
  const classes = ["icon", size !== "md" ? `icon--${size}` : "", className ?? ""]
    .filter(Boolean)
    .join(" ");
  return (
    <svg
      className={classes}
      aria-hidden={label ? undefined : true}
      role={label ? "img" : undefined}
      aria-label={label}
      focusable="false"
    >
      <use href={`/icons.svg#i-${name}`} />
    </svg>
  );
}
