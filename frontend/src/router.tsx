import { createBrowserRouter, type RouteObject } from 'react-router';
import { RequireAuth, RequireOrgRole, RequirePlatformAdmin, RequireScannerAccess } from './auth/guards';
import { Outlet as ScannerOutlet } from 'react-router';
import { ValidIds } from './auth/ValidIds';
import { Layout } from './components/Layout';
import { RouteError } from './components/RouteError';
import { NotFoundPage } from './pages/NotFoundPage';
import { AccountPage } from './pages/account/AccountPage';
import { ForgotPasswordPage } from './pages/account/ForgotPasswordPage';
import { LoginPage } from './pages/account/LoginPage';
import { RegisterPage } from './pages/account/RegisterPage';
import { ResetPasswordPage } from './pages/account/ResetPasswordPage';
import { VerifyEmailPage } from './pages/account/VerifyEmailPage';
import { OrderPage } from './pages/orders/OrderPage';
import { OrdersPage } from './pages/orders/OrdersPage';
import { EventPage } from './pages/public/EventPage';
import { EventsPage } from './pages/public/EventsPage';
import { TicketsPage } from './pages/tickets/TicketsPage';
import { AdminOrgsPage } from './pages/admin/AdminOrgsPage';
import { AuditPage } from './pages/org/AuditPage';
import { DashboardPage } from './pages/org/DashboardPage';
import { EventAdminPage } from './pages/org/EventAdminPage';
import { EventCreatePage } from './pages/org/EventCreatePage';
import { MembersPage } from './pages/org/MembersPage';
import { OrdersAdminPage } from './pages/org/OrdersAdminPage';
import { OrgEventsPage } from './pages/org/OrgEventsPage';
import { OrgHomePage } from './pages/org/OrgHomePage';
import { OrgLayout } from './pages/org/OrgLayout';
import { RefundsPage } from './pages/org/RefundsPage';
import { SettingsPage } from './pages/org/SettingsPage';

/** Page de paiement simulée : uniquement serveur de dev en mode mock (branche éliminée du build). */
const mockRoutes: RouteObject[] =
  import.meta.env.DEV && import.meta.env.MODE === 'mock'
    ? [{ path: 'mock-psp/:orderId', lazy: async () => ({ Component: (await import('./mocks/MockPspPage')).MockPspPage }) }]
    : [];

export const routes: RouteObject[] = [
  {
    path: '/',
    element: <Layout />,
    errorElement: <RouteError />,
    children: [
      { index: true, element: <EventsPage /> },
      { path: 'events/:eventId', element: <ValidIds><EventPage /></ValidIds> },
      { path: 'login', element: <LoginPage /> },
      { path: 'register', element: <RegisterPage /> },
      { path: 'verify-email', element: <VerifyEmailPage /> },
      { path: 'forgot-password', element: <ForgotPasswordPage /> },
      { path: 'reset-password', element: <ResetPasswordPage /> },
      { path: 'account', element: <RequireAuth><AccountPage /></RequireAuth> },
      { path: 'me/orders', element: <RequireAuth><OrdersPage /></RequireAuth> },
      { path: 'orders/:orderId', element: <ValidIds><RequireAuth><OrderPage /></RequireAuth></ValidIds> },
      { path: 'me/tickets', element: <RequireAuth allowOffline><TicketsPage /></RequireAuth> },
      // Back-office : gardes = confort d'affichage, l'API vérifie le rôle à chaque requête.
      { path: 'org', element: <RequireAuth><OrgHomePage /></RequireAuth> },
      {
        path: 'org/:orgId',
        element: (
          <ValidIds>
            <RequireAuth>
              <RequireOrgRole min="MANAGER">
                <OrgLayout />
              </RequireOrgRole>
            </RequireAuth>
          </ValidIds>
        ),
        children: [
          { index: true, element: <OrgEventsPage /> },
          { path: 'events/new', element: <EventCreatePage /> },
          { path: 'events/:eventId', element: <ValidIds><EventAdminPage /></ValidIds> },
          { path: 'events/:eventId/dashboard', element: <ValidIds><DashboardPage /></ValidIds> },
          { path: 'events/:eventId/orders', element: <ValidIds><OrdersAdminPage /></ValidIds> },
          { path: 'settings', element: <SettingsPage /> },
          { path: 'refunds', element: <RefundsPage /> },
          { path: 'members', element: <MembersPage /> },
          { path: 'audit', element: <RequireOrgRole min="OWNER"><AuditPage /></RequireOrgRole> },
        ],
      },
      // Contrôle d'accès (PWA hors-ligne) : chargé à la demande (lecteur QR volumineux), précaché par le service worker.
      {
        path: 'scan',
        element: <RequireAuth allowOffline><ScannerOutlet /></RequireAuth>,
        children: [
          { index: true, lazy: async () => ({ Component: (await import('./scanner/ui/ScannerHomePage')).ScannerHomePage }) },
          {
            path: ':orgId/:eventId',
            lazy: async () => {
              const { ScannerPage } = await import('./scanner/ui/ScannerPage');
              return {
                Component: () => (
                  <ValidIds>
                    <RequireScannerAccess>
                      <ScannerPage />
                    </RequireScannerAccess>
                  </ValidIds>
                ),
              };
            },
          },
        ],
      },
      { path: 'admin', element: <RequireAuth><RequirePlatformAdmin><AdminOrgsPage /></RequirePlatformAdmin></RequireAuth> },
      ...mockRoutes,
      { path: '*', element: <NotFoundPage /> },
    ],
  },
];

export function createAppRouter() {
  return createBrowserRouter(routes);
}
