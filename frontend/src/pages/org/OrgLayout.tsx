import { Fragment } from 'react';
import { Link, NavLink, Outlet, useNavigate, useOutletContext, useParams } from 'react-router';
import { apiPath } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { membershipFor, ROLE_LABELS, roleAtLeast } from '../../auth/roles';
import { BrandMark } from '../../components/BrandMark';
import { Icon, type IconName } from '../../components/Icon';
import type { LayoutOutletContext } from '../../components/Layout';
import styles from '../../components/Layout.module.css';
import { lookup } from '../../lib/lookup';

/** Gabarit du back-office d'un collectif (garde MANAGER+ appliquée par la route) : menu latéral sombre + contenu. */
export function OrgLayout() {
  const { orgId = '' } = useParams();
  const { user } = useAuth();
  const navigate = useNavigate();
  const { onLogout } = useOutletContext<LayoutOutletContext>();
  const m = membershipFor(user, orgId);
  const owner = m ? roleAtLeast(m.role, 'OWNER') : false;
  const managed = (user?.memberships ?? []).filter((x) => roleAtLeast(x.role, 'MANAGER'));
  const base = apiPath`/org/${orgId}`;
  const links: { to: string; label: string; icon: IconName; end?: boolean }[] = [
    { to: base, label: 'Événements', icon: 'calendar', end: true },
    { to: `${base}/refunds`, label: 'Remboursements', icon: 'refund' },
    { to: `${base}/members`, label: 'Membres', icon: 'users' },
    { to: `${base}/settings`, label: 'Réglages', icon: 'settings' },
    ...(owner ? [{ to: `${base}/audit`, label: 'Journal', icon: 'file-text' as const }] : []),
  ];
  return (
    <div className={`${styles.boShell} bo`}>
      <nav className={styles.boNav} aria-label="Back-office">
        <Link to="/" className={styles.brand}>
          <BrandMark />
          <span className={styles.brandName}>
            Les Nuits
            <br />
            de la Garonne
          </span>
        </Link>
        {managed.length > 1 ? (
          <label className={styles.boSpace}>
            ESPACE
            <select
              value={orgId}
              onChange={(e) => {
                void navigate(apiPath`/org/${e.target.value}`);
              }}
            >
              {managed.map((x) => (
                <option key={x.orgId} value={x.orgId}>
                  {x.orgName}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <p className={styles.boSpace}>
            ESPACE <strong>{m?.orgName ?? '—'}</strong>
          </p>
        )}
        <ul className={styles.boNavList}>
          {links.map((l) => (
            <li key={l.to}>
              <NavLink to={l.to} end={l.end} className={styles.boNavLink}>
                <Icon name={l.icon} /> {l.label}
              </NavLink>
            </li>
          ))}
          <li>
            <NavLink to="/scan" className={styles.boNavLink}>
              <Icon name="qr" /> Contrôle des entrées
            </NavLink>
          </li>
          <li>
            <NavLink to="/" className={styles.boNavLink}>
              <Icon name="chevron-left" /> Retour au site
            </NavLink>
          </li>
        </ul>
        <div className={styles.boUser}>
          <strong>{user?.displayName}</strong>
          {m ? lookup(ROLE_LABELS, m.role) : null}
          <button type="button" className={styles.boLogout} onClick={() => void onLogout()}>
            Se déconnecter
          </button>
        </div>
      </nav>
      <main id="contenu" className={styles.boMain} tabIndex={-1}>
        <div className={styles.boMainInner}>
          {/* Remontage complet à chaque changement de collectif : aucun état de formulaire (IBAN, mot de
              passe, filtres, pagination) ne peut passer d'un collectif à l'autre. */}
          <Fragment key={orgId}>
            <Outlet />
          </Fragment>
        </div>
      </main>
    </div>
  );
}
