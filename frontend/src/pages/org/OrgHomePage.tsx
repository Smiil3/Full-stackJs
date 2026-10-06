import { Link, Navigate } from 'react-router';
import { apiPath } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { ROLE_LABELS, roleAtLeast } from '../../auth/roles';
import { lookup } from '../../lib/lookup';

/** Sélecteur de collectif (back-office) : direct si une seule adhésion de gestion. */
export function OrgHomePage() {
  const { user } = useAuth();
  const managed = (user?.memberships ?? []).filter((m) => roleAtLeast(m.role, 'MANAGER'));
  const only = managed.length === 1 ? managed[0] : undefined;
  if (only) return <Navigate to={apiPath`/org/${only.orgId}`} replace />;
  return (
    <section className="page">
      <h1>Choisir un collectif</h1>
      {managed.length === 0 ? <p>Vous ne gérez aucun collectif.</p> : null}
      <ul className="list-reset stack">
        {managed.map((m) => (
          <li key={m.orgId} className="card row row--between">
            <Link to={apiPath`/org/${m.orgId}`}>{m.orgName}</Link>
            <span className="muted">{lookup(ROLE_LABELS, m.role)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
