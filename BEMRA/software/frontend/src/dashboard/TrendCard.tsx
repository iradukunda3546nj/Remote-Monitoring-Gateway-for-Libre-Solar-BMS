/**
 * One trend chart. Live and 1h use raw samples with incremental polling; 24h
 * uses server-side 5-minute averages, refreshed every minute.
 */
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/endpoints';
import { qk } from '../api/queryKeys';
import { useLiveTelemetry } from '../hooks/useLiveTelemetry';
import { TimeSeriesChart, type ChartAxis, type ChartSeries } from '../components/charts/TimeSeriesChart';
import type { Point } from '../domain/series';
import type { AggregatableField, RawTelemetryRow } from '../api/types';

type Metric = 'voltage' | 'current' | 'soc' | 'temperature';
type Range = 'live' | '1h' | '24h';

const METRICS: Record<Metric, { label: string; field: AggregatableField; color: string; axis: ChartAxis }> = {
  voltage: {
    label: 'Voltage',
    field: 'rPackVoltage_V',
    color: '#e3a33a',
    axis: { name: 'Pack voltage', unit: 'V', decimals: 2, minInterval: 0.01 },
  },
  current: {
    label: 'Current',
    field: 'rPackCurrent_A',
    color: '#58a6ff',
    axis: { name: 'Pack current', unit: 'A', decimals: 2, minInterval: 0.01 },
  },
  soc: {
    label: 'SOC',
    field: 'rSOC_pct',
    color: '#3fb950',
    axis: { name: 'SOC', unit: '%', decimals: 1, min: 0, max: 100 },
  },
  temperature: {
    label: 'Temperature',
    field: 'rICTemp_degC',
    color: '#f0883e',
    axis: { name: 'Temperature', unit: '°C', decimals: 1, minInterval: 0.1 },
  },
};
const TEMP_COLORS = ['#f0883e', '#d2a8ff', '#79c0ff', '#ffa198'];
const RANGE_S: Record<Range, number> = { live: 900, '1h': 3600, '24h': 86400 };
const RANGE_LABEL: Record<Range, string> = { live: 'Live', '1h': '1h', '24h': '24h' };
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function rawSeries(rows: RawTelemetryRow[], metric: Metric): ChartSeries[] {
  const pts = (pick: (r: RawTelemetryRow) => number | null) =>
    rows.map((r) => [Date.parse(r.timestamps.observed_at), pick(r)] as Point).filter((p) => p[1] !== null);
  const m = METRICS[metric];
  if (metric !== 'temperature')
    return [{ name: m.axis.name, points: pts((r) => num(r.values[m.field])), color: m.color }];
  const thermistors = Math.max(0, ...rows.map((r) => r.thingset?.rCellTemps_degC?.length ?? 0));
  const out: ChartSeries[] = [
    { name: 'BMS IC', points: pts((r) => num(r.values.rICTemp_degC)), color: TEMP_COLORS[0] },
  ];
  for (let i = 0; i < thermistors; i++) {
    out.push({
      name: `Thermistor ${i + 1}`,
      points: pts((r) => num(r.thingset?.rCellTemps_degC?.[i])),
      color: TEMP_COLORS[(i + 1) % TEMP_COLORS.length],
    });
  }
  return out.filter((s) => s.points.length > 0);
}

export function TrendCard({ deviceId }: { deviceId: string }) {
  const [metric, setMetric] = useState<Metric>('voltage');
  const [range, setRange] = useState<Range>('live');
  const m = METRICS[metric];

  const raw = useLiveTelemetry(deviceId, RANGE_S[range], false, range !== '24h');
  const agg = useQuery({
    queryKey: qk.trend(deviceId, { range, field: m.field }),
    enabled: range === '24h',
    refetchInterval: 60_000,
    queryFn: ({ signal }) =>
      api.telemetryAggregate(
        deviceId,
        {
          from: new Date(Date.now() - 86_400_000).toISOString(),
          to: new Date(Date.now() + 300_000).toISOString(),
          interval: '5m',
          fields: [m.field],
        },
        signal,
      ),
  });

  const series = useMemo<ChartSeries[]>(() => {
    if (range !== '24h') return rawSeries(raw.rows, metric);
    const pts = (agg.data?.data ?? [])
      .map((r) => [Date.parse(r.bucket_start) + 150_000, r.values[m.field]?.avg ?? null] as Point)
      .filter((p) => p[1] !== null);
    return [{ name: metric === 'temperature' ? 'BMS IC' : m.axis.name, points: pts, color: m.color }];
  }, [range, raw.rows, agg.data, metric, m]);

  const xMax = range === '24h' ? Date.now() : (raw.lastPollAt ?? Date.now());
  const hasData = series.some((s) => s.points.length > 0);
  const loading = range === '24h' ? agg.isPending : raw.loading;
  const error = range === '24h' ? agg.error : raw.error;

  return (
    <section className="card" aria-label="Telemetry trend">
      <header className="card__head">
        <h2>Telemetry trend</h2>
        <div className="toggles">
          <div className="seg" role="group" aria-label="Measurement">
            {(Object.keys(METRICS) as Metric[]).map((k) => (
              <button key={k} type="button" aria-pressed={metric === k} onClick={() => setMetric(k)}>
                {METRICS[k].label}
              </button>
            ))}
          </div>
          <div className="seg" role="group" aria-label="Time range">
            {(Object.keys(RANGE_S) as Range[]).map((r) => (
              <button key={r} type="button" aria-pressed={range === r} onClick={() => setRange(r)}>
                {RANGE_LABEL[r]}
              </button>
            ))}
          </div>
        </div>
      </header>
      {error ? (
        <p className="empty">Trend unavailable: {(error as Error).message}</p>
      ) : !hasData ? (
        <p className="empty">{loading ? 'Loading…' : 'No measurements in this range'}</p>
      ) : (
        <TimeSeriesChart
          series={series}
          axis={m.axis}
          xMin={xMax - RANGE_S[range] * 1000}
          xMax={xMax}
          zeroLine={metric === 'current'}
          height={240}
          ariaLabel={`${m.label} trend`}
        />
      )}
    </section>
  );
}
