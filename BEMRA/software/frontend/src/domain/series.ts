/**
 * Time-series utilities for charts. Points are never interpolated: when the
 * gap between two samples is much larger than the typical spacing, a null is
 * inserted so the line breaks across the outage.
 */
import type { RawTelemetryRow } from '../api/types';

export type Point = [number, number | null];

/** Merge new rows into an existing ascending list, de-duplicated by stable row id. */
export function mergeRows(existing: RawTelemetryRow[], incoming: RawTelemetryRow[]): RawTelemetryRow[] {
  if (incoming.length === 0) return existing;
  const byId = new Map<number, RawTelemetryRow>();
  for (const r of existing) byId.set(r.id, r);
  let added = false;
  for (const r of incoming) {
    if (!byId.has(r.id)) {
      byId.set(r.id, r);
      added = true;
    }
  }
  if (!added) return existing; // keep identity: no re-render, no chart animation
  return [...byId.values()].sort(
    (a, b) => Date.parse(a.timestamps.observed_at) - Date.parse(b.timestamps.observed_at) || a.id - b.id,
  );
}

/** Drop rows older than the window start; cap the total to bound memory. */
export function trimRows(rows: RawTelemetryRow[], fromMs: number, maxPoints: number): RawTelemetryRow[] {
  let start = 0;
  while (start < rows.length && Date.parse(rows[start]!.timestamps.observed_at) < fromMs) start++;
  start = Math.max(start, rows.length - maxPoints);
  return start === 0 ? rows : rows.slice(start);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/**
 * Gap threshold: 3 × median sample spacing, at least `minGapMs` (default 30 s,
 * so normal 5 s Wi-Fi jitter never breaks the line; a 60 s GPRS cadence gives 180 s).
 */
export function gapThresholdMs(times: number[], minGapMs = 30_000): number {
  const d: number[] = [];
  for (let i = 1; i < times.length; i++) d.push(times[i]! - times[i - 1]!);
  return Math.max(3 * median(d), minGapMs);
}

/** Build [t, v] points with null breaks across gaps. */
export function withGaps(points: Point[], thresholdMs?: number): Point[] {
  if (points.length < 2) return points;
  const thr = thresholdMs ?? gapThresholdMs(points.map((p) => p[0]));
  const out: Point[] = [points[0]!];
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1]!;
    const cur = points[i]!;
    if (cur[0] - prev[0] > thr) out.push([prev[0] + 1, null]);
    out.push(cur);
  }
  return out;
}

export interface SequenceStats {
  received: number;
  replayed: number;
  delayed: number;
  /** Missing sequence numbers within each boot (gaps between consecutive telemetry sequences). */
  missing: number;
  boots: number;
}

/**
 * Sequence analysis over telemetry rows. Note: the gateway's sequence counter
 * is shared by all message kinds (live, replay, meta, event), so a gap may be a
 * non-telemetry message rather than a lost one; reported as "unaccounted".
 */
export function sequenceStats(rows: RawTelemetryRow[]): SequenceStats {
  const byBoot = new Map<string, number[]>();
  let replayed = 0;
  let delayed = 0;
  for (const r of rows) {
    if (r.source.delivery === 'replay') replayed++;
    if (r.timestamps.time_flags.includes('late_delivery')) delayed++;
    const list = byBoot.get(r.source.boot_id) ?? [];
    list.push(r.source.sequence);
    byBoot.set(r.source.boot_id, list);
  }
  let missing = 0;
  for (const seqs of byBoot.values()) {
    seqs.sort((a, b) => a - b);
    for (let i = 1; i < seqs.length; i++) missing += Math.max(0, seqs[i]! - seqs[i - 1]! - 1);
  }
  return { received: rows.length, replayed, delayed, missing, boots: byBoot.size };
}
