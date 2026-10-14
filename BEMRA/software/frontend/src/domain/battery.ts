/**
 * Battery-level derivations computed from actual measurements only.
 * Current sign convention (verified, include/drivers/bms_ic.h):
 * "Module/pack current, charging direction has positive sign".
 */
import { config } from '../config';
import type { DeviceMetadataSnapshot } from '../api/types';

export type FlowState = 'charging' | 'discharging' | 'idle' | 'unknown';

/**
 * Dead-band for classifying idle: the BMS's own sBalIdleCurrent_A (the
 * current below which the firmware treats the pack as idle) when available.
 */
export function idleThresholdA(meta: DeviceMetadataSnapshot | null | undefined): {
  value: number;
  source: 'bms' | 'default';
} {
  const v = meta?.conf?.sBalIdleCurrent_A;
  if (typeof v === 'number' && v > 0) return { value: v, source: 'bms' };
  return { value: config.defaultIdleCurrentA, source: 'default' };
}

export function flowState(currentA: number | null | undefined, idleA: number): FlowState {
  if (currentA === null || currentA === undefined || !Number.isFinite(currentA)) return 'unknown';
  if (currentA > idleA) return 'charging';
  if (currentA < -idleA) return 'discharging';
  return 'idle';
}

/** Derived power P = V × I (W); positive while charging. Null when either input is missing. */
export function powerW(voltageV: number | null | undefined, currentA: number | null | undefined): number | null {
  if (voltageV === null || voltageV === undefined || currentA === null || currentA === undefined) return null;
  return voltageV * currentA;
}

export interface CellStats {
  count: number;
  valid: number;
  min: number | null;
  max: number | null;
  avg: number | null;
  minIndex: number | null;
  maxIndex: number | null;
  /** max − min in millivolts, rounded to 0.1 mV (firmware resolution is 1 mV). */
  spreadMv: number | null;
}

/** Statistics over valid (non-null) cell voltages. Cell index is 1-based. */
export function cellStats(voltages: (number | null)[] | null | undefined): CellStats {
  const list = voltages ?? [];
  const valid = list
    .map((v, i) => ({ v, i: i + 1 }))
    .filter((x): x is { v: number; i: number } => typeof x.v === 'number');
  if (valid.length === 0) {
    return {
      count: list.length,
      valid: 0,
      min: null,
      max: null,
      avg: null,
      minIndex: null,
      maxIndex: null,
      spreadMv: null,
    };
  }
  let min = valid[0]!;
  let max = valid[0]!;
  let sum = 0;
  for (const c of valid) {
    if (c.v < min.v) min = c;
    if (c.v > max.v) max = c;
    sum += c.v;
  }
  return {
    count: list.length,
    valid: valid.length,
    min: min.v,
    max: max.v,
    avg: sum / valid.length,
    minIndex: min.i,
    maxIndex: max.i,
    spreadMv: Math.round((max.v - min.v) * 10000) / 10,
  };
}

/** Protection limits from the BMS Conf snapshot, if the gateway published them. */
export function cellLimits(meta: DeviceMetadataSnapshot | null | undefined): { uv: number | null; ov: number | null } {
  const c = meta?.conf ?? {};
  const uv = typeof c.sCellUndervoltage_V === 'number' ? c.sCellUndervoltage_V : null;
  const ov = typeof c.sCellOvervoltage_V === 'number' ? c.sCellOvervoltage_V : null;
  return { uv, ov };
}
