import type { ReactNode } from 'react';
import { useParams } from 'react-router';
import { NotFoundPage } from '../pages/NotFoundPage';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Tout paramètre de route `…Id` doit être un UUID : sinon page 404 immédiate, sans requête vers l'API.
 */
export function ValidIds({ children }: { children: ReactNode }) {
  const params = useParams();
  const invalid = Object.entries(params).some(([k, v]) => k.endsWith('Id') && (typeof v !== 'string' || !UUID.test(v)));
  return invalid ? <NotFoundPage /> : children;
}
