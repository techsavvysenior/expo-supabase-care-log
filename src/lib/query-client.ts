import { QueryClient } from '@tanstack/react-query';

import { toAppError } from '@/core/errors';

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        // Retry only failures that can clear up on their own.
        retry: (failureCount, error) => toAppError(error).retryable && failureCount < 2,
      },
      // Writes go through the offline queue, which has its own retry rules.
      mutations: { retry: false },
    },
  });
}
