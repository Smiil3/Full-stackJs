import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useMatch, useNavigate } from 'react-router';
import { ownerHash, pendingCount, scannerStorageAvailable } from '../scanner/db';
import { ScannerBackgroundSync } from '../scanner/ui/BackgroundSync';
import { ConfirmDialog } from './ConfirmDialog';
import { useAuth } from '../auth/AuthContext';
import { roleAtLeast } from '../auth/roles';
import { useOnline } from '../lib/hooks/useOnline';
import { useTheme } from '../lib/useTheme';
import { BrandMark } from './BrandMark';
import { Icon } from './Icon';
import styles from './Layout.module.css';
import { PwaUpdatePrompt } from './PwaUpdatePrompt';
import { WaitlistOfferBanner } from './WaitlistOfferBanner';

/** Contexte partagé par l'en-tête public et la coque du back-office (déconnexion protégée, thème). */
export type LayoutOutletContext = { onLogout: () => Promise<void>; theme: 'dark' | 'light'; toggleTheme: () => void };

export function Layout() {
  const { status, user, logout, notice } = useAuth();
  const online = useOnline();
  const navigate = useNavigate();
  const location = useLocation();
  const { theme, toggle: toggleTheme, canToggle } = useTheme(location.pathname);
  // Back-office d'un collectif : la coque (menu latéral + contenu) est rendue par OrgLayout.
  const backOffice = useMatch('/org/:orgId/*') !== null;
  const canManage = user?.memberships.some((m) => roleAtLeast(m.role, 'MANAGER')) ?? false;
  // Hors-ligne au démarrage (session non restaurée) : le scanner reste accessible sur les listes préparées.
  const canScan = (user?.memberships.length ?? 0) > 0 || status === 'offline';

  const [menuOpen, setMenuOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const closeMenu = (restoreFocus: boolean) => {
    setMenuOpen(false);
    if (restoreFocus) menuButton.current?.focus();
  };
  // Changement de page : menu refermé (le focus va au contenu de la nouvelle page).
  const [shownFor, setShownFor] = useState(location.key);
  if (shownFor !== location.key) {
    setShownFor(location.key);
    setMenuOpen(false);
  }
  useEffect(() => {
    if (!menuOpen) return;
    menuRef.current?.querySelector<HTMLElement>('a, button')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMenuOpen(false);
        menuButton.current?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  const [pendingAtLogout, setPendingAtLogout] = useState<{ count: number; step: 1 | 2 } | null>(null);
  const doLogout = async () => {
    setPendingAtLogout(null);
    await logout();
    await navigate('/', { replace: true });
  };
  /** Passages hors-ligne non transmis : on ne se déconnecte pas sans avertissement (la file est conservée). */
  const onLogout = async () => {
    setMenuOpen(false);
    const count = user && scannerStorageAvailable() ? await ownerHash(user.id).then((h) => pendingCount(undefined, h)).catch(() => 0) : 0;
    if (count > 0) setPendingAtLogout({ count, step: 1 });
    else await doLogout();
  };
  const outletContext: LayoutOutletContext = { onLogout, theme, toggleTheme };

  const banners = (
    <div className={styles.banners}>
      {!online || status === 'offline' ? (
        <p className="offline-banner" role="status">
          <Icon name="wifi-off" />
          <span>Pas de réseau. Vos billets restent disponibles ; les autres informations peuvent ne pas être à jour.</span>
        </p>
      ) : null}
      {notice === 'logout-pending' ? (
        <p className="offline-banner" role="status">
          <Icon name="info" />
          <span>Vous êtes déconnecté·e sur cet appareil. La déconnexion sera terminée côté serveur dès le retour du réseau.</span>
        </p>
      ) : null}
      {notice === 'csrf' ? (
        <p className="offline-banner" role="status">
          <Icon name="info" />
          <span>Votre session n’a pas pu être restaurée (contrôle de sécurité). Merci de vous reconnecter.</span>
        </p>
      ) : null}
    </div>
  );

  const dialogs = (
    <>
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
      {/* En dev, le scope « / » est occupé par le worker MSW (mode mock) : pas de service worker applicatif. */}
      {import.meta.env.PROD ? <PwaUpdatePrompt /> : null}
    </>
  );

  if (backOffice) {
    return (
      <div className={styles.shell}>
        <a className="skip-link" href="#contenu">
          Aller au contenu
        </a>
        {banners}
        <Outlet context={outletContext} />
        {dialogs}
      </div>
    );
  }

  return (
    <div className={styles.shell}>
      <a className="skip-link" href="#contenu">
        Aller au contenu
      </a>
      <header className={styles.header}>
        <Link to="/" className={styles.brand}>
          <BrandMark />
          <span className={styles.brandName}>
            Les Nuits
            <br />
            de la Garonne
          </span>
        </Link>
        <div className={styles.actions}>
          <NavLink to="/me/tickets" className={styles.ticketsLink}>
            <Icon name="ticket" />
            <span className={styles.ticketsLabel}>Mes billets</span>
          </NavLink>
          <button
            ref={menuButton}
            type="button"
            className={styles.iconButton}
            aria-expanded={menuOpen}
            aria-controls="menu-site"
            aria-label={menuOpen ? 'Fermer le menu' : 'Ouvrir le menu'}
            onClick={() => {
              if (menuOpen) closeMenu(true);
              else setMenuOpen(true);
            }}
          >
            <Icon name={menuOpen ? 'close' : 'menu'} size="lg" />
          </button>
        </div>
      </header>
      {menuOpen ? (
        <div
          className={styles.menuBackdrop}
          aria-hidden="true"
          onClick={() => {
            closeMenu(true);
          }}
        />
      ) : null}
      <div id="menu-site" ref={menuRef} className={styles.menu} hidden={!menuOpen}>
        <nav aria-label="Navigation principale">
          <ul className={styles.menuList}>
            <li>
              <NavLink to="/" end className={styles.menuLink}>
                Événements <Icon name="chevron-right" />
              </NavLink>
            </li>
            <li>
              <NavLink to="/me/tickets" className={styles.menuLink}>
                Mes billets <Icon name="chevron-right" />
              </NavLink>
            </li>
            {user ? (
              <>
                <li>
                  <NavLink to="/me/orders" className={styles.menuLink}>
                    Commandes <Icon name="chevron-right" />
                  </NavLink>
                </li>
                <li>
                  <NavLink to="/account" className={styles.menuLink}>
                    Mon compte <Icon name="chevron-right" />
                  </NavLink>
                </li>
              </>
            ) : null}
            {canScan ? (
              <li>
                <NavLink to="/scan" className={styles.menuLink}>
                  Contrôle des entrées <Icon name="qr" />
                </NavLink>
              </li>
            ) : null}
            {canManage ? (
              <li>
                <NavLink to="/org" className={styles.menuLink}>
                  Espace organisateurs <Icon name="dashboard" />
                </NavLink>
              </li>
            ) : null}
            {user?.isPlatformAdmin ? (
              <li>
                <NavLink to="/admin" className={styles.menuLink}>
                  Administration <Icon name="settings" />
                </NavLink>
              </li>
            ) : null}
            {canToggle ? (
              <li>
                <button type="button" className={styles.menuLink} onClick={toggleTheme}>
                  {theme === 'dark' ? 'Mode clair' : 'Mode sombre'} <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
                </button>
              </li>
            ) : null}
            {user ? (
              <li>
                <button type="button" className={styles.menuLink} onClick={() => void onLogout()}>
                  Se déconnecter <Icon name="arrow-right" />
                </button>
              </li>
            ) : status !== 'loading' ? (
              <li>
                <NavLink to="/login" className={styles.menuLink}>
                  Se connecter <Icon name="arrow-right" />
                </NavLink>
              </li>
            ) : null}
          </ul>
        </nav>
      </div>
      {banners}
      <WaitlistOfferBanner />
      <main id="contenu" className={styles.main} tabIndex={-1}>
        <Outlet context={outletContext} />
      </main>
      {dialogs}
      <footer className={styles.footer}>
        <div className={styles.footerInner}>
          <ul className={styles.footerReassure}>
            <li>
              <Icon name="card" /> Carte bancaire ou virement
            </li>
            <li>
              <Icon name="wifi-off" /> Billets consultables même sans réseau
            </li>
          </ul>
          <div className={styles.footerLinks}>
            <Link to="/org">Espace organisateurs</Link>
          </div>
          <p className={styles.footerMeta}>Les Nuits de la Garonne · Bordeaux</p>
        </div>
      </footer>
    </div>
  );
}
