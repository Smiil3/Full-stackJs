import { QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { RouterProvider } from 'react-router';
import { createQueryClient } from './api/queryClient';
import { AuthProvider } from './auth/AuthProvider';
import { createAppRouter } from './router';
import { AppErrorBoundary } from './components/AppErrorBoundary';
// Purge des données du scanner à chaque fin de session, même si l'écran de scan n'a pas été ouvert.
import './scanner/cleanup';

export function App() {
  const [queryClient] = useState(createQueryClient);
  const [router] = useState(createAppRouter);
  return (
    <AppErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <RouterProvider router={router} />
        </AuthProvider>
      </QueryClientProvider>
    </AppErrorBoundary>
  );
}
