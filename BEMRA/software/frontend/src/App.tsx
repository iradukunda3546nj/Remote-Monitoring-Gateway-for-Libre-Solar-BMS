import { useCallback, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiError } from './api/client';
import { Dashboard } from './dashboard/Dashboard';
import { Splash } from './dashboard/Splash';
import { ErrorBoundary } from './components/ui/ErrorBoundary';

export function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        refetchOnWindowFocus: false,
        retry: (count, err) => !(err instanceof ApiError && (err.status === 404 || err.status === 400)) && count < 2,
        staleTime: 2000,
      },
    },
  });
}

const queryClient = createQueryClient();

export function App() {
  const [splash, setSplash] = useState(true);
  const done = useCallback(() => setSplash(false), []);
  return (
    <QueryClientProvider client={queryClient}>
      {/* The dashboard mounts behind the splash so its data is ready when the splash ends. */}
      <ErrorBoundary>
        <Dashboard />
      </ErrorBoundary>
      {splash && <Splash onDone={done} />}
    </QueryClientProvider>
  );
}
