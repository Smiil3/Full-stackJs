import type { ReactNode } from 'react';
import { Navigate, useLocation, useParams } from 'react-router';
import type { OrgRole } from '../api/types';
import { Forbidden } from '../components/Forbidden';
import { PageLoader } from '../components/PageLoader';
import { useAuth } from './AuthContext';
import { hasOrgRole } from './roles';
import { loginPathWithNext } from './safeRedirect';

/**
 * Gardes de routes : CONFORT UX uniquement. La sécurité est assurée par l'API (404/403),
 * ces composants évitent seulement d'afficher un écran inutilisable.
 */
export function RequireAuth({ children, allowOffline = false }: { children: ReactNode; allowOffline?: boolean }) {
  const { status } = useAuth();
  const location = useLocation();
  if (status === 'loading') return <PageLoader />;
  if (status === 'offline' && allowOffline) return children;
  if (status !== 'authenticated') return <Navigate to={loginPathWithNext(location.pathname + location.search)} replace />;
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
