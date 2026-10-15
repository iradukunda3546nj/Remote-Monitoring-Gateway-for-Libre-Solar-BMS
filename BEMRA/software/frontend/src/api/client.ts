import type { ApiErrorBody } from './types';

const RAW_BASE = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000/api/v1';

/** API base URL without trailing slash, e.g. http://localhost:3000/api/v1 */
export const API_BASE_URL = RAW_BASE.replace(/\/+$/, '');

/** Origin of the backend (health/readiness endpoints live outside /api/v1). */
export const API_ORIGIN = new URL(API_BASE_URL, window.location.href).origin;

export type ApiErrorKind = 'network' | 'http' | 'parse' | 'aborted';

/** Error carrying enough context to show the operator a meaningful message. */
export class ApiError extends Error {
  constructor(
    readonly kind: ApiErrorKind,
    message: string,
    readonly status?: number,
    readonly code?: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  get isNotFound(): boolean {
    return this.status === 404;
  }
}

type Query = Record<string, string | number | undefined | null>;

export function buildUrl(path: string, query?: Query, base = API_BASE_URL): string {
  const url = new URL(base + path, window.location.href);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

/**
 * GET JSON with typed errors. The AbortSignal comes from TanStack Query, so
 * switching device or unmounting cancels in-flight requests.
 */
export async function getJson<T>(path: string, query?: Query, signal?: AbortSignal, base?: string): Promise<T> {
  let res: Response;
  try {
    const apiKey = import.meta.env.VITE_API_KEY;
    res = await fetch(buildUrl(path, query, base), {
      headers: { Accept: 'application/json', ...(apiKey ? { 'X-API-Key': apiKey } : {}) },
      signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw new ApiError('aborted', 'Request cancelled');
    throw new ApiError('network', `Backend unreachable at ${API_ORIGIN}`);
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new ApiError('parse', `Invalid JSON from ${path} (HTTP ${res.status})`, res.status);
  }
  if (!res.ok) {
    const e = (body as ApiErrorBody)?.error;
    throw new ApiError('http', e?.message ?? `HTTP ${res.status}`, res.status, e?.code, e?.details);
  }
  return body as T;
}
