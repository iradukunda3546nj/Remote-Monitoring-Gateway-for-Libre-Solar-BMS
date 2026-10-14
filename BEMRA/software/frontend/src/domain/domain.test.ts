import { describe, expect, it } from 'vitest';
import { cellStats, flowState, idleThresholdA, powerW } from './battery';
import { classifyLiveness } from './freshness';
import { mergeRows, trimRows, withGaps } from './series';
import { deriveSnapshot } from '../dashboard/snapshot';
import type { RawTelemetryRow } from '../api/types';
import rawFixture from '../test/fixtures/telemetry-raw.json';
import latestFixture from '../test/fixtures/latest.json';
import statusFixture from '../test/fixtures/status.json';
import detailFixture from '../test/fixtures/device-detail.json';

const raw = rawFixture.data as unknown as RawTelemetryRow[];

describe('battery domain', () => {
  it('cell statistics in mV from measured cells, ignoring invalid ones', () => {
    expect(cellStats([3.342, 3.318, 3.33])).toMatchObject({ min: 3.318, max: 3.342, spreadMv: 24 });
    expect(cellStats([3.3, null, 3.31])).toMatchObject({ valid: 2, spreadMv: 10 });
    expect(cellStats([]).spreadMv).toBeNull();
  });
  it('firmware sign convention (+ = charging) with BMS idle dead-band', () => {
    expect(flowState(2.15, 0.1)).toBe('charging');
    expect(flowState(-2.15, 0.1)).toBe('discharging');
    expect(flowState(0.05, 0.1)).toBe('idle');
    expect(flowState(null, 0.1)).toBe('unknown');
    expect(idleThresholdA({ conf: { sBalIdleCurrent_A: 0.3 } } as never).value).toBe(0.3);
  });
  it('power only when both inputs exist', () => {
    expect(powerW(13.24, -2.15)).toBeCloseTo(-28.466, 3);
    expect(powerW(null, 1)).toBeNull();
  });
  it('liveness classes', () => {
    expect(classifyLiveness(10, 300)).toBe('fresh');
    expect(classifyLiveness(130, 300)).toBe('fresh'); // within one 2-min publish interval
    expect(classifyLiveness(200, 300)).toBe('delayed');
    expect(classifyLiveness(301, 300)).toBe('stale');
    expect(classifyLiveness(null, 300)).toBe('no_data');
  });
});

describe('series', () => {
  it('merges by id without duplicates and keeps identity when nothing is new', () => {
    const a = mergeRows([], raw.slice(0, 3));
    expect(mergeRows(a, raw.slice(1, 3))).toBe(a);
    expect(new Set(mergeRows(a, raw).map((r) => r.id)).size).toBe(raw.length);
  });
  it('trims old rows and breaks lines across outages', () => {
    const rows = mergeRows([], raw);
    const cutoff = Date.parse(rows[2]!.timestamps.observed_at) + 1;
    expect(trimRows(rows, cutoff, 100).every((r) => Date.parse(r.timestamps.observed_at) >= cutoff)).toBe(true);
    expect(
      withGaps([
        [0, 1],
        [5000, 1],
        [10000, 1],
        [600000, 2],
      ]),
    ).toContainEqual([10001, null]);
  });
});

describe('snapshot from real API responses', () => {
  it('derives the displayed values of bms-001', () => {
    const s = deriveSnapshot(
      detailFixture.data as never,
      statusFixture.data as never,
      latestFixture.data as never,
      Date.now(),
    );
    expect(s).toMatchObject({
      socPct: 78.5,
      packV: 13.24,
      currentA: -2.15,
      flow: 'discharging',
      stateCode: 'NORMAL',
      liveness: 'stale',
    });
    expect(s.cellVoltages).toEqual([3.311, 3.302, 3.318, 3.309]);
    expect(s.tempMaxC).toBe(31.4);
    expect(s.tempSource).toBe('BMS IC');
    expect(s.stats.spreadMv).toBe(16);
  });
  it('reports missing measurements as null, not zero', () => {
    const s = deriveSnapshot(undefined, undefined, null, Date.now());
    expect(s).toMatchObject({ socPct: null, packV: null, powerW: null, liveness: 'no_data', cellVoltages: [] });
  });
});

import { gatewayLink } from '../dashboard/snapshot';

describe('gateway online check', () => {
  const now = Date.parse('2026-10-09T20:00:00Z');
  const st = (gwState: 'online' | 'offline', gwAt: string, dataAt: string | null) =>
    ({
      data_freshness: { observed_at: dataAt, stale_after_s: 300 },
      gateway: { state: gwState, ingested_at: gwAt },
    }) as never;
  it('online only with recent traffic', () => {
    expect(gatewayLink(st('online', '2026-10-09T08:00:00Z', '2026-10-09T19:59:50Z'), now).state).toBe('online');
  });
  it('a retained "online" with no recent traffic is silent, not online', () => {
    expect(gatewayLink(st('online', '2026-10-09T08:00:00Z', '2026-10-09T19:52:00Z'), now).state).toBe('silent');
  });
  it('Last Will marks offline unless newer data arrived', () => {
    expect(gatewayLink(st('offline', '2026-10-09T19:59:00Z', '2026-10-09T19:58:00Z'), now).state).toBe('offline');
    expect(gatewayLink(st('offline', '2026-10-09T19:50:00Z', '2026-10-09T19:59:55Z'), now).state).toBe('online');
  });
});
