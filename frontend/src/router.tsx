import { createBrowserRouter, type RouteObject } from 'react-router';
import { RequireAuth } from './auth/guards';
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
      { path: 'events/:eventId', element: <EventPage /> },
      { path: 'login', element: <LoginPage /> },
      { path: 'register', element: <RegisterPage /> },
      { path: 'verify-email', element: <VerifyEmailPage /> },
      { path: 'forgot-password', element: <ForgotPasswordPage /> },
      { path: 'reset-password', element: <ResetPasswordPage /> },
      { path: 'account', element: <RequireAuth><AccountPage /></RequireAuth> },
      { path: 'me/orders', element: <RequireAuth><OrdersPage /></RequireAuth> },
      { path: 'orders/:orderId', element: <RequireAuth><OrderPage /></RequireAuth> },
      { path: 'me/tickets', element: <RequireAuth allowOffline><TicketsPage /></RequireAuth> },
      ...mockRoutes,
      { path: '*', element: <NotFoundPage /> },
    ],
  },
];

export function createAppRouter() {
  return createBrowserRouter(routes);
}
