import { NavLink, Outlet, useNavigate } from 'react-router';
import { useAuth } from '../auth/AuthContext';
import { roleAtLeast } from '../auth/roles';
import { useOnline } from '../lib/hooks/useOnline';
import styles from './Layout.module.css';
import { PwaUpdatePrompt } from './PwaUpdatePrompt';

export function Layout() {
  const { status, user, logout } = useAuth();
  const online = useOnline();
  const navigate = useNavigate();
  const canManage = user?.memberships.some((m) => roleAtLeast(m.role, 'MANAGER')) ?? false;
  const canScan = (user?.memberships.length ?? 0) > 0;
  const navClass = ({ isActive }: { isActive: boolean }) => (isActive ? `${styles.link} ${styles.active}` : styles.link);

  const onLogout = async () => {
    await logout();
    await navigate('/', { replace: true });
  };

  return (
    <div className={styles.shell}>
      <a className="skip-link" href="#contenu">
        Aller au contenu
      </a>
      <header className={styles.header}>
        <NavLink to="/" className={styles.brand}>
          Les Nuits de la Garonne
        </NavLink>
        <nav aria-label="Navigation principale" className={styles.nav}>
          <NavLink to="/" end className={navClass}>
            Événements
          </NavLink>
          {user ? (
            <>
              <NavLink to="/me/tickets" className={navClass}>
                Mes billets
              </NavLink>
              <NavLink to="/me/orders" className={navClass}>
                Commandes
              </NavLink>
              {canManage ? (
                <NavLink to="/org" className={navClass}>
                  Organisation
                </NavLink>
              ) : null}
              {canScan ? (
                <NavLink to="/scan" className={navClass}>
                  Scanner
                </NavLink>
              ) : null}
              {user.isPlatformAdmin ? (
                <NavLink to="/admin" className={navClass}>
                  Admin
                </NavLink>
              ) : null}
              <NavLink to="/account" className={navClass}>
                Mon compte
              </NavLink>
              <button type="button" className={styles.linkButton} onClick={() => void onLogout()}>
                Se déconnecter
              </button>
            </>
          ) : status !== 'loading' ? (
            <NavLink to="/login" className={navClass}>
              Se connecter
            </NavLink>
          ) : null}
        </nav>
      </header>
      {!online || status === 'offline' ? (
        <p className={styles.offline} role="status">
          Vous êtes hors-ligne : les informations affichées peuvent ne pas être à jour.
        </p>
      ) : null}
      {/* En dev, le scope « / » est occupé par le worker MSW (mode mock) : pas de service worker applicatif. */}
      {import.meta.env.PROD ? <PwaUpdatePrompt /> : null}
      <main id="contenu" className={styles.main} tabIndex={-1}>
        <Outlet />
      </main>
      <footer className={styles.footer}>Billetterie des Nuits de la Garonne</footer>
    </div>
  );
}
