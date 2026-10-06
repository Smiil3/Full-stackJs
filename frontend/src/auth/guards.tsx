import type { ReactNode } from 'react';
import { Navigate, useLocation, useParams } from 'react-router';
import type { OrgRole } from '../api/types';
import { Forbidden } from '../components/Forbidden';
import { PageLoader } from '../components/PageLoader';
import { useAuth } from './AuthContext';
import { hasOrgRole } from './roles';
import { loginPathWithNext, safeRedirectPath } from './safeRedirect';

/**
 * Gardes de routes : CONFORT UX uniquement. La sécurité est assurée par l'API (404/403),
 * ces composants évitent seulement d'afficher un écran inutilisable.
 */
export function RequireAuth({ children, allowOffline = false }: { children: ReactNode; allowOffline?: boolean }) {
  const { status, sessionEndRedirect } = useAuth();
  const location = useLocation();
  if (status === 'loading') return <PageLoader />;
  if (status === 'offline' && allowOffline) return children;
  if (status !== 'authenticated') {
    return <Navigate to={sessionEndRedirect ? safeRedirectPath(sessionEndRedirect) : loginPathWithNext(location.pathname + location.search)} replace />;
  }
  return children;
}

export function RequireOrgRole({ min, children }: { min: OrgRole; children: ReactNode }) {
  const { user } = useAuth();
  const { orgId } = useParams();
  if (!hasOrgRole(user, orgId, min)) return <Forbidden />;
  return children;
}

export function RequirePlatformAdmin({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  if (!user?.isPlatformAdmin) return <Forbidden />;
  return children;
}

/**
 * Contrôle d'accès hors-ligne : connecté ⇒ rôle SCANNER+ requis dans le collectif ; démarrage hors-ligne
 * (session non restaurable) ⇒ autorisé, car l'écran n'utilise alors QUE les données déjà préparées
 * sur l'appareil (aucune donnée nouvelle ne peut être obtenue sans session).
 */
export function RequireScannerAccess({ children }: { children: ReactNode }) {
  const { status, user } = useAuth();
  const { orgId } = useParams();
  if (status === 'offline') return children;
  if (!hasOrgRole(user, orgId, 'SCANNER')) return <Forbidden />;
  return children;
}
