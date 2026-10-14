import { useMemo } from 'react';
import type { EChartsCoreOption } from 'echarts/core';
import { EChart } from './EChart';
import { CHART } from './theme';
import type { Point } from '../../domain/series';

export interface ChartSeries {
  name: string;
  points: Point[];
  color?: string;
}

export interface ChartAxis {
  name: string;
  unit: string;
  decimals: number;
  min?: number;
  max?: number;
  /** Smallest tick step, matched to measurement resolution so labels never repeat. */
  minInterval?: number;
}

interface Props {
  series: ChartSeries[];
  axis: ChartAxis;
  xMin?: number;
  xMax?: number;
  zeroLine?: boolean;
  height?: number | string;
  ariaLabel: string;
}

function timeLabel(ms: number, spanMs: number): string {
  const d = new Date(ms);
  const two = (n: number) => String(n).padStart(2, '0');
  if (spanMs > 3 * 3_600_000) return `${two(d.getHours())}:${two(d.getMinutes())}`;
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

/** Plain line chart of stored measurements. */
export function TimeSeriesChart({ series, axis, xMin, xMax, zeroLine, height = 220, ariaLabel }: Props) {
  const option = useMemo<EChartsCoreOption>(() => {
    const allT = series.flatMap((s) => s.points.map((p) => p[0]));
    const span = (xMax ?? Math.max(...allT, 0)) - (xMin ?? Math.min(...allT, 0)) || 60_000;
    const vals = series.flatMap((s) => s.points.map((p) => p[1]).filter((v): v is number => v !== null));
    let yMin = axis.min;
    let yMax = axis.max;
    let step: number | undefined;
    if (yMin === undefined && vals.length) {
      // Round ticks: pick a 1/2/5 × 10^n step giving ~4 intervals around the data.
      const lo = Math.min(...vals);
      const hi = Math.max(...vals);
      const span = Math.max(hi - lo, (axis.minInterval ?? 0.01) * 4);
      const raw = span / 4;
      const mag = 10 ** Math.floor(Math.log10(raw));
      step = [1, 2, 5, 10].map((k) => k * mag).find((v) => v >= raw)!;
      yMin = Math.floor(lo / step) * step - step;
      yMax = Math.ceil(hi / step) * step + step;
    }
    return {
      animation: false,
      textStyle: { fontFamily: CHART.sans, color: CHART.text },
      grid: { left: 58, right: 18, top: series.length > 1 ? 30 : 12, bottom: 26 },
      legend:
        series.length > 1
          ? {
              top: 0,
              right: 8,
              itemWidth: 14,
              itemHeight: 2,
              icon: 'rect',
              textStyle: { color: CHART.text, fontSize: 11 },
            }
          : { show: false },
      tooltip: {
        trigger: 'axis',
        backgroundColor: CHART.tooltipBg,
        borderColor: CHART.tooltipBorder,
        textStyle: { color: '#e6eaee', fontFamily: CHART.mono, fontSize: 11 },
        valueFormatter: (v: number) => `${v.toFixed(axis.decimals)} ${axis.unit}`,
      },
      xAxis: {
        type: 'time',
        min: xMin,
        max: xMax,
        axisLine: { lineStyle: { color: CHART.axis } },
        axisTick: { show: false },
        splitLine: { show: false },
        axisLabel: {
          color: CHART.text,
          fontFamily: CHART.mono,
          fontSize: 10.5,
          hideOverlap: true,
          formatter: (v: number) => timeLabel(v, span),
        },
      },
      yAxis: {
        type: 'value',
        name: `${axis.name} [${axis.unit}]`,
        nameLocation: 'middle',
        nameGap: 44,
        nameTextStyle: { color: CHART.textDim, fontSize: 11 },
        min: yMin,
        max: yMax,
        minInterval: axis.minInterval,
        interval: step,
        splitLine: { lineStyle: { color: CHART.split } },
        axisLabel: {
          color: CHART.text,
          fontFamily: CHART.mono,
          fontSize: 10.5,
          formatter: (v: number) => v.toFixed(axis.decimals),
        },
      },
      series: series.map((s, i) => {
        const color = s.color ?? CHART.series[i % CHART.series.length]!;
        return {
          type: 'line',
          name: s.name,
          data: s.points,
          showSymbol: s.points.length <= 60,
          symbol: 'circle',
          symbolSize: 4,
          lineStyle: { width: 1.5, color },
          itemStyle: { color },
          emphasis: { disabled: true },
          markLine:
            i === 0 && zeroLine
              ? {
                  silent: true,
                  symbol: 'none',
                  label: { show: false },
                  data: [{ yAxis: 0 }],
                  lineStyle: { color: CHART.zero, type: 'solid', width: 1 },
                }
              : undefined,
        };
      }),
    };
  }, [series, axis, xMin, xMax, zeroLine]);

  return <EChart option={option} height={height} ariaLabel={ariaLabel} />;
}
