/** Everything the page shows for one device, derived only from that device's API responses. */
import type { DeviceDetail, DeviceStatus, LatestTelemetry } from '../api/types';
import { cellStats, flowState, idleThresholdA, powerW, type CellStats, type FlowState } from '../domain/battery';
import { classifyLiveness, type Liveness } from '../domain/freshness';
import { ageSeconds } from '../domain/format';
import { BMS_STATES } from '../domain/thingset';

export interface Snapshot {
  socPct: number | null;
  packV: number | null;
  currentA: number | null;
  powerW: number | null;
  tempMaxC: number | null;
  tempSource: string | null;
  cellVoltages: (number | null)[];
  stats: CellStats;
  flow: FlowState;
  stateCode: string | null;
  stateDescription: string | null;
  liveness: Liveness;
  ageS: number | null;
  observedAt: string | null;
  activeFaults: string[];
  errorFlags: number | null;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function deriveSnapshot(
  detail: DeviceDetail | undefined,
  status: DeviceStatus | undefined,
  latest: LatestTelemetry | null | undefined,
  now: number,
): Snapshot {
  const m = latest?.measurements ?? {};
  const packV = num(m.rPackVoltage_V?.value);
  const currentA = num(m.rPackCurrent_A?.value);

  // Highest available temperature and which sensor reported it
  const temps: [string, number | null][] = [
    ...(Array.isArray(m.rCellTemps_degC?.value) ? (m.rCellTemps_degC!.value as unknown[]) : []).map(
      (t, i) => [`thermistor ${i + 1}`, num(t)] as [string, number | null],
    ),
    ['BMS IC', num(m.rICTemp_degC?.value)],
    ['MOSFET', num(m.rMOSFETTemp_degC?.value)],
    ['shunt', num(m.rShuntTemp_degC?.value)],
  ];
  const hottest = temps.filter((t): t is [string, number] => t[1] !== null).sort((a, b) => b[1] - a[1])[0];

  const cellVoltages = Array.isArray(m.rCellVoltages_V?.value) ? (m.rCellVoltages_V!.value as (number | null)[]) : [];
  const observedAt = status?.data_freshness.observed_at ?? latest?.timestamps.observed_at ?? null;
  const ageS = ageSeconds(observedAt, now);
  const stateValue = status?.bms_state?.value ?? latest?.bms_state?.value;

  return {
    socPct: num(m.rSOC_pct?.value),
    packV,
    currentA,
    powerW: powerW(packV, currentA),
    tempMaxC: hottest?.[1] ?? null,
    tempSource: hottest?.[0] ?? null,
    cellVoltages,
    stats: cellStats(cellVoltages),
    flow: flowState(currentA, idleThresholdA(detail?.latest_metadata).value),
    stateCode: stateValue === undefined ? null : (BMS_STATES[stateValue]?.code ?? `UNKNOWN ${stateValue}`),
    stateDescription: stateValue === undefined ? null : (BMS_STATES[stateValue]?.description ?? null),
    liveness: classifyLiveness(ageS, status?.data_freshness.stale_after_s ?? 300),
    ageS,
    observedAt,
    activeFaults: status?.error_flags?.active ?? latest?.error_flags?.active ?? [],
    errorFlags: status?.error_flags?.value ?? latest?.error_flags?.value ?? null,
  };
}

export interface GatewayLink {
  state: 'online' | 'offline' | 'silent' | 'unknown';
  /** Seconds since anything was last heard from this gateway/device. */
  heardAgeS: number | null;
}

/**
 * A gateway counts as online only if its last status is not "offline" (the
 * broker publishes the retained Last Will on an unexpected disconnect) AND
 * something was heard from it within the backend's stale limit. A retained
 * "online" with no recent traffic is reported as silent, never as online.
 */
export function gatewayLink(status: DeviceStatus | undefined, now: number): GatewayLink {
  if (!status) return { state: 'unknown', heardAgeS: null };
  const heard = [status.data_freshness.observed_at, status.gateway?.ingested_at]
    .filter((t): t is string => !!t)
    .map((t) => Date.parse(t));
  const heardAgeS = heard.length ? Math.max(0, (now - Math.max(...heard)) / 1000) : null;
  const dataAt = status.data_freshness.observed_at ? Date.parse(status.data_freshness.observed_at) : 0;
  // Offline only if the Last Will is newer than the latest data from the device.
  if (status.gateway?.state === 'offline' && Date.parse(status.gateway.ingested_at) >= dataAt) {
    return { state: 'offline', heardAgeS };
  }
  const recent = heardAgeS !== null && heardAgeS <= status.data_freshness.stale_after_s;
  return { state: recent ? 'online' : 'silent', heardAgeS };
}
