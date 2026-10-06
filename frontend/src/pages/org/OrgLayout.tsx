import { Fragment } from 'react';
import { NavLink, Outlet, useParams } from 'react-router';
import { apiPath } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { membershipFor, roleAtLeast } from '../../auth/roles';

/** Gabarit du back-office d'un collectif (garde MANAGER+ appliquée par la route). */
export function OrgLayout() {
  const { orgId = '' } = useParams();
  const { user } = useAuth();
  const m = membershipFor(user, orgId);
  const owner = m ? roleAtLeast(m.role, 'OWNER') : false;
  const several = (user?.memberships.filter((x) => roleAtLeast(x.role, 'MANAGER')).length ?? 0) > 1;
  const base = apiPath`/org/${orgId}`;
  const cls = ({ isActive }: { isActive: boolean }) => (isActive ? 'subnav__link subnav__link--active' : 'subnav__link');
  return (
    <div className="stack">
      <div className="row row--between">
        <p className="muted m-0">
          Collectif : <strong>{m?.orgName ?? '—'}</strong>
        </p>
        {several ? <NavLink to="/org">Changer de collectif</NavLink> : null}
      </div>
      <nav aria-label="Back-office" className="subnav">
        <NavLink to={base} end className={cls}>
          Événements
        </NavLink>
        <NavLink to={`${base}/settings`} className={cls}>
          Réglages
        </NavLink>
        <NavLink to={`${base}/members`} className={cls}>
          Membres
        </NavLink>
        {owner ? (
          <NavLink to={`${base}/audit`} className={cls}>
            Journal
          </NavLink>
        ) : null}
      </nav>
      {/* Remontage complet à chaque changement de collectif : aucun état de formulaire (IBAN, mot de
          passe, filtres, pagination) ne peut passer d'un collectif à l'autre. */}
      <Fragment key={orgId}>
        <Outlet />
      </Fragment>
    </div>
  );
}
