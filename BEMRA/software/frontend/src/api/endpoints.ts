/** Backend endpoints used by the dashboard (see software/backend/src/routes/v1.js). */
import { API_ORIGIN, getJson } from './client';
import type {
  AggregatePage,
  Device,
  DeviceDetail,
  DeviceStatus,
  Interval,
  LatestTelemetry,
  RawTelemetryPage,
  ReadyResponse,
  AggregatableField,
} from './types';

const enc = encodeURIComponent;
type Data<T> = { data: T };

export const api = {
  ready: (signal?: AbortSignal) => getJson<ReadyResponse>('/ready', undefined, signal, API_ORIGIN),
  devices: (signal?: AbortSignal) => getJson<Data<Device[]>>('/devices', undefined, signal).then((r) => r.data),
  device: (id: string, signal?: AbortSignal) =>
    getJson<Data<DeviceDetail>>(`/devices/${enc(id)}`, undefined, signal).then((r) => r.data),
  status: (id: string, signal?: AbortSignal) =>
    getJson<Data<DeviceStatus>>(`/devices/${enc(id)}/status`, undefined, signal).then((r) => r.data),
  latest: (id: string, signal?: AbortSignal) =>
    getJson<Data<LatestTelemetry>>(`/devices/${enc(id)}/latest`, undefined, signal).then((r) => r.data),

  /** Raw samples including the complete ThingSet object (thermistor arrays). */
  telemetryRaw: (id: string, q: { from: string; to: string; limit?: number }, signal?: AbortSignal) =>
    getJson<RawTelemetryPage>(
      `/devices/${enc(id)}/telemetry`,
      { from: q.from, to: q.to, interval: 'raw', order: 'asc', limit: q.limit, include: 'thingset' },
      signal,
    ),

  telemetryAggregate: (
    id: string,
    q: { from: string; to: string; interval: Exclude<Interval, 'raw'>; fields?: AggregatableField[] },
    signal?: AbortSignal,
  ) =>
    getJson<AggregatePage>(
      `/devices/${enc(id)}/telemetry`,
      { from: q.from, to: q.to, interval: q.interval, fields: q.fields?.join(','), order: 'asc' },
      signal,
    ),
};
