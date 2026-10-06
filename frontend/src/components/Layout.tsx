import { useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router';
import { ownerHash, pendingCount, scannerStorageAvailable } from '../scanner/db';
import { ScannerBackgroundSync } from '../scanner/ui/BackgroundSync';
import { ConfirmDialog } from './ConfirmDialog';
import { useAuth } from '../auth/AuthContext';
import { roleAtLeast } from '../auth/roles';
import { useOnline } from '../lib/hooks/useOnline';
import styles from './Layout.module.css';
import { PwaUpdatePrompt } from './PwaUpdatePrompt';
import { WaitlistOfferBanner } from './WaitlistOfferBanner';

export function Layout() {
  const { status, user, logout, notice } = useAuth();
  const online = useOnline();
  const navigate = useNavigate();
  const canManage = user?.memberships.some((m) => roleAtLeast(m.role, 'MANAGER')) ?? false;
  // Hors-ligne au démarrage (session non restaurée) : le scanner reste accessible sur les listes préparées.
  const canScan = (user?.memberships.length ?? 0) > 0 || status === 'offline';
  const navClass = ({ isActive }: { isActive: boolean }) => (isActive ? `${styles.link} ${styles.active}` : styles.link);

  const [pendingAtLogout, setPendingAtLogout] = useState<{ count: number; step: 1 | 2 } | null>(null);

  const doLogout = async () => {
    setPendingAtLogout(null);
    await logout();
    await navigate('/', { replace: true });
  };

  /** Passages hors-ligne non transmis : on ne se déconnecte pas sans avertissement (la file est conservée). */
  const onLogout = async () => {
    const count = user && scannerStorageAvailable() ? await ownerHash(user.id).then((h) => pendingCount(undefined, h)).catch(() => 0) : 0;
    if (count > 0) setPendingAtLogout({ count, step: 1 });
    else await doLogout();
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
          {!user && canScan ? (
            <NavLink to="/scan" className={navClass}>
              Scanner
            </NavLink>
          ) : null}
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
      {notice === 'logout-pending' ? (
        <p className={styles.offline} role="status">
          Vous êtes déconnecté·e sur cet appareil. La déconnexion sera terminée côté serveur dès le retour du réseau.
        </p>
      ) : null}
      {notice === 'csrf' ? (
        <p className={styles.offline} role="status">
          Votre session n’a pas pu être restaurée (contrôle de sécurité). Merci de vous reconnecter.
        </p>
      ) : null}
      <WaitlistOfferBanner />
      {/* En dev, le scope « / » est occupé par le worker MSW (mode mock) : pas de service worker applicatif. */}
      {import.meta.env.PROD ? <PwaUpdatePrompt /> : null}
      <main id="contenu" className={styles.main} tabIndex={-1}>
        <Outlet />
      </main>
      <ConfirmDialog
        open={pendingAtLogout?.step === 1}
        title="Passages non transmis"
        confirmLabel="Déconnecter quand même"
        cancelLabel="Rester connecté"
        danger
        onCancel={() => setPendingAtLogout(null)}
        onConfirm={() => setPendingAtLogout((p) => (p ? { ...p, step: 2 } : p))}
      >
        <p>
          <strong>{pendingAtLogout?.count} passage(s) non transmis</strong> : reconnectez-vous au réseau d’abord pour les synchroniser.
        </p>
      </ConfirmDialog>
      <ConfirmDialog
        open={pendingAtLogout?.step === 2}
        title="Confirmer la déconnexion ?"
        confirmLabel="Me déconnecter"
        danger
        onCancel={() => setPendingAtLogout(null)}
        onConfirm={() => void doLogout()}
      >
        <p>Les passages restent enregistrés sur cet appareil et seront transmis à votre prochaine connexion ici.</p>
      </ConfirmDialog>
      <ScannerBackgroundSync />
      <footer className={styles.footer}>Billetterie des Nuits de la Garonne</footer>
    </div>
  );
}
