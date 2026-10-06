import { QueryClient } from '@tanstack/react-query';
import { isApiError } from './errors';

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 15_000,
        // On ne réessaie que les pannes transitoires (réseau, 5xx) ; jamais une erreur métier 4xx.
        retry: (count, error) => count < 2 && (!isApiError(error) || error.status === 0 || error.status >= 500),
        refetchOnWindowFocus: true,
      },
      mutations: { retry: false },
    },
  });
}
