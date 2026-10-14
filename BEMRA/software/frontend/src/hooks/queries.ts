import { useQuery } from '@tanstack/react-query';
import { api } from '../api/endpoints';
import { ApiError } from '../api/client';
import { qk } from '../api/queryKeys';
import { config } from '../config';

/** "No telemetry yet" (404) is a normal state, represented as null. */
async function nullOn404<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch (err) {
    if (err instanceof ApiError && err.isNotFound) return null;
    throw err;
  }
}

export const useReady = () =>
  useQuery({ queryKey: qk.ready, queryFn: ({ signal }) => api.ready(signal), refetchInterval: 15_000, retry: 0 });

export const useDevices = () =>
  useQuery({ queryKey: qk.devices, queryFn: ({ signal }) => api.devices(signal), refetchInterval: 30_000 });

export const useDevice = (id: string | undefined) =>
  useQuery({
    queryKey: qk.device(id ?? ''),
    queryFn: ({ signal }) => api.device(id!, signal),
    enabled: !!id,
    staleTime: 30_000,
  });

export const useStatus = (id: string | undefined) =>
  useQuery({
    queryKey: qk.status(id ?? ''),
    queryFn: ({ signal }) => api.status(id!, signal),
    enabled: !!id,
    refetchInterval: config.livePollMs,
  });

export const useLatest = (id: string | undefined) =>
  useQuery({
    queryKey: qk.latest(id ?? ''),
    queryFn: ({ signal }) => nullOn404(api.latest(id!, signal)),
    enabled: !!id,
    refetchInterval: config.livePollMs,
  });
