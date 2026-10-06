import { isRouteErrorResponse, useRouteError } from 'react-router';
import { NotFoundPage } from '../pages/NotFoundPage';
import { GenericError } from './AppErrorBoundary';

/** errorElement du routeur : erreurs de rendu / de chargement de route, sans détail technique. */
export function RouteError() {
  const error = useRouteError();
  if (isRouteErrorResponse(error) && error.status === 404) return <NotFoundPage />;
  console.error('Erreur de route', error);
  return <GenericError />;
}
