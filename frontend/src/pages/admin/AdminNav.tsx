import { NavLink } from 'react-router';

/** Sous-navigation de l'administration de la plateforme. */
export function AdminNav() {
  return (
    <nav aria-label="Administration" className="subnav">
      <NavLink to="/admin" end>
        Collectifs
      </NavLink>
      <NavLink to="/admin/anomalies">Anomalies</NavLink>
    </nav>
  );
}
