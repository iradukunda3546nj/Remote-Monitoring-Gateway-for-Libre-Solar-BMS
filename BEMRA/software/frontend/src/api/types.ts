/**
 * Types for the BEMRA backend REST API v1.
 * Derived from software/backend (services/device-service.js, repositories/*)
 * and verified against live responses captured in src/test/fixtures.
 * Measurement keys are Libre Solar ThingSet object names (unit in the suffix).
 */

export type Iso = string;

/** Scalar ThingSet Meas objects that have typed columns (selectable as `fields`). */
export type ScalarField =
  | 'rPackVoltage_V'
  | 'rStackVoltage_V'
  | 'rPackCurrent_A'
  | 'rICTemp_degC'
  | 'rMOSFETTemp_degC'
  | 'rShuntTemp_degC'
  | 'rSOC_pct'
  | 'rErrorFlags'
  | 'rBmsState'
  | 'rCellAvgVoltage_V'
  | 'rCellMinVoltage_V'
  | 'rCellMaxVoltage_V'
  | 'rBalancingStatus';

/** Fields the backend can aggregate (bitmaps/enums are excluded server-side). */
export type AggregatableField = Exclude<ScalarField, 'rErrorFlags' | 'rBmsState' | 'rBalancingStatus'>;

/** ThingSet object as stored (complete; may contain fields beyond the catalogue). */
export interface ThingSetObject {
  rPackVoltage_V?: number | null;
  rStackVoltage_V?: number | null;
  rPackCurrent_A?: number | null;
  rCellTemps_degC?: (number | null)[];
  rICTemp_degC?: number | null;
  rMOSFETTemp_degC?: number | null;
  rShuntTemp_degC?: number | null;
  rSOC_pct?: number | null;
  rErrorFlags?: number;
  rBmsState?: number;
  rCellVoltages_V?: (number | null)[];
  rCellAvgVoltage_V?: number | null;
  rCellMinVoltage_V?: number | null;
  rCellMaxVoltage_V?: number | null;
  rBalancingStatus?: number;
  [extra: string]: unknown;
}

export interface Site {
  site_id: string;
  name: string;
  country_code: string | null;
  region: string | null;
  district: string | null;
  installation_description: string | null;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  created_at?: Iso;
  updated_at?: Iso;
  device_count?: number;
}

export interface Device {
  device_id: string;
  bms_model: string;
  manufacturer: string | null;
  device_type: string | null;
  hardware_version: string | null;
  firmware_version: string | null;
  cell_count: number | null;
  thermistor_count: number | null;
  chemistry: 'LFP' | 'NMC' | 'LTO' | null;
  nominal_capacity_ah: number | null;
  status: 'active' | 'inactive' | 'decommissioned';
  last_schema_version: string | null;
  last_seen_at: Iso | null;
  created_at: Iso;
  updated_at: Iso;
  site_id: string | null;
  site_name: string | null;
  gateway_id: string | null;
  gateway_firmware_version: string | null;
}

export interface AssignmentHistoryEntry {
  kind: 'site' | 'gateway';
  target_id: string;
  valid_from: Iso;
  valid_to: Iso | null;
  note: string | null;
}

export interface DeviceMetadataSnapshot {
  device_info: Record<string, string>;
  conf: Record<string, number | number[]>;
  layout: { cell_count?: number; thermistor_count?: number; chemistry?: string };
  gateway_info: { model?: string; firmware_version?: string };
  boot_id: string;
  sequence: number;
  published_at: Iso | null;
  ingested_at: Iso;
}

export interface DeviceDetail extends Device {
  site: Omit<Site, 'device_count' | 'created_at' | 'updated_at'> | null;
  assignment_history: AssignmentHistoryEntry[];
  latest_metadata: DeviceMetadataSnapshot | null;
}

export interface Freshness {
  observed_at: Iso | null;
  observed_at_source: 'bms' | 'gateway' | 'publish' | 'backend' | null;
  age_s: number | null;
  stale: boolean;
  stale_after_s: number;
}

export interface BmsStateInfo {
  value: number;
  code: 'OFF' | 'CHG' | 'DIS' | 'NORMAL' | 'SHUTDOWN' | 'UNKNOWN';
  description: string;
}

export interface ErrorFlagsInfo {
  value: number;
  active: string[];
  unknown_bits: number[];
}

export interface GatewayStatus {
  state: 'online' | 'offline';
  boot_id: string | null;
  sequence: number | null;
  published_at: Iso | null;
  ingested_at: Iso;
  link_type: 'wifi' | 'gprs' | 'lte' | 'ethernet' | null;
  rssi_dbm: number | null;
  uptime_s: number | null;
  buffered_messages: number | null;
  firmware_version: string | null;
  retained: boolean;
}

export interface DeviceStatus {
  device_id: string;
  site_id: string | null;
  gateway_id: string | null;
  device_status: Device['status'];
  data_freshness: Freshness;
  gateway: GatewayStatus | null;
  online: boolean;
  bms_state: BmsStateInfo | null;
  error_flags: ErrorFlagsInfo | null;
}

export interface Timestamps {
  measured_at: Iso | null;
  gateway_received_at: Iso | null;
  published_at: Iso | null;
  ingested_at: Iso;
  observed_at: Iso;
  observed_at_source: 'bms' | 'gateway' | 'publish' | 'backend';
  time_flags: ('no_gateway_clock' | 'future_timestamp' | 'late_delivery')[];
}

export interface Source {
  gateway_id: string;
  site_id: string;
  boot_id: string;
  sequence: number;
  delivery: 'live' | 'replay';
  schema_version: string;
}

export interface MeasurementValue {
  value: unknown;
  unit: string | null;
  thingset_id: string | null;
  note?: string;
}

export interface LatestTelemetry {
  device_id: string;
  measurements: Record<string, MeasurementValue>;
  not_reported: string[];
  bms_state: BmsStateInfo | null;
  error_flags: ErrorFlagsInfo | null;
  timestamps: Timestamps;
  source: Source;
  data_freshness: Freshness;
}

export interface CellsResponse {
  device_id: string;
  observed_at: Iso;
  cell_count: number;
  unit: 'V';
  cells: { index: number; voltage_v: number | null }[];
  bms_statistics: {
    rCellMinVoltage_V: number | null;
    rCellMaxVoltage_V: number | null;
    rCellAvgVoltage_V: number | null;
  };
  rBalancingStatus: number | null;
  rCellTemps_degC: (number | null)[] | null;
  data_freshness: Freshness;
}

export interface RawTelemetryRow {
  id: number;
  timestamps: Timestamps;
  source: Source;
  values: Partial<Record<ScalarField, number | null>>;
  thingset?: ThingSetObject;
}

export interface AggregateRow {
  bucket_start: Iso;
  sample_count: number;
  values: Partial<Record<AggregatableField, { min: number | null; avg: number | null; max: number | null }>>;
}

export interface RawTelemetryPage {
  data: RawTelemetryRow[];
  meta: {
    device_id: string;
    from: Iso;
    to: Iso;
    interval: 'raw';
    order: 'asc' | 'desc';
    fields: ScalarField[];
    limit: number;
    units: Record<string, string | null>;
    next_cursor: string | null;
  };
}

export interface AggregatePage {
  data: AggregateRow[];
  meta: {
    device_id: string;
    from: Iso;
    to: Iso;
    interval: Exclude<Interval, 'raw'>;
    order: 'asc' | 'desc';
    fields: AggregatableField[];
    bucket_seconds: number;
    units: Record<string, string | null>;
    empty_buckets: 'omitted';
  };
}

export type Interval = 'raw' | '1m' | '5m' | '15m' | '1h' | '6h' | '1d';

export interface BmsEvent {
  id: number;
  code: string;
  severity: 'critical' | 'warning' | 'info';
  state: 'raised' | 'cleared' | 'instant';
  message: string | null;
  error_flags: number | null;
  bms_state: number | null;
  thingset: ThingSetObject;
  boot_id: string;
  sequence: number;
  measured_at: Iso | null;
  gateway_received_at: Iso | null;
  published_at: Iso | null;
  ingested_at: Iso;
  observed_at: Iso;
  gateway_id: string;
  site_id: string;
}

export interface EventsPage {
  data: BmsEvent[];
  meta: { device_id: string; from: Iso; to: Iso; order: 'asc' | 'desc'; limit: number; next_cursor: string | null };
}

export interface ReadyResponse {
  status: 'ready' | 'not_ready';
  checks: {
    database: { ok: boolean; latency_ms?: number; error?: string };
    migrations?: { ok: boolean; pending: string[] };
  };
}

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}
