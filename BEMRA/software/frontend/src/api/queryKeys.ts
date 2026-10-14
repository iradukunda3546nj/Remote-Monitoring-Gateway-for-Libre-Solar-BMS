/** Every device-specific key starts with ['device', id]: one device's cache can never serve another. */
export const qk = {
  ready: ['system', 'ready'] as const,
  devices: ['devices'] as const,
  device: (id: string) => ['device', id, 'detail'] as const,
  status: (id: string) => ['device', id, 'status'] as const,
  latest: (id: string) => ['device', id, 'latest'] as const,
  trend: (id: string, spec: unknown) => ['device', id, 'trend', spec] as const,
};
