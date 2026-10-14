import { useMemo } from 'react';
import type { EChartsCoreOption } from 'echarts/core';
import { EChart } from '../components/charts/EChart';
import { CHART } from '../components/charts/theme';
import { config } from '../config';

/** One bar per configured cell (actual count from the gateway). Extremes turn amber only when the spread exceeds the threshold. */
export function CellChart({ voltages, live }: { voltages: (number | null)[]; live: boolean }) {
  const option = useMemo<EChartsCoreOption>(() => {
    const valid = voltages.filter((v): v is number => v !== null);
    const min = valid.length ? Math.min(...valid) : 0;
    const max = valid.length ? Math.max(...valid) : 0;
    const flag = (max - min) * 1000 > config.cellSpreadWarnMv;
    return {
      animation: false,
      grid: { left: 8, right: 8, top: 24, bottom: 22, containLabel: false },
      tooltip: {
        trigger: 'item',
        backgroundColor: CHART.tooltipBg,
        borderColor: CHART.tooltipBorder,
        textStyle: { color: '#e6eaee', fontFamily: CHART.mono, fontSize: 11 },
        formatter: (p: { dataIndex: number; value: number | null }) =>
          `Cell ${p.dataIndex + 1}: ${p.value === null ? 'unavailable' : `${p.value.toFixed(3)} V`}`,
      },
      xAxis: {
        type: 'category',
        data: voltages.map((_, i) => `C${i + 1}`),
        axisLine: { lineStyle: { color: CHART.axis } },
        axisTick: { show: false },
        axisLabel: { color: CHART.text, fontFamily: CHART.mono, fontSize: 10 },
      },
      // Range zoomed around the cells so millivolt differences are visible
      yAxis: { type: 'value', show: false, min: Math.max(0, min - 0.03), max: max + 0.01 },
      series: [
        {
          type: 'bar',
          barMaxWidth: 46,
          data: voltages.map((v) => ({
            value: v,
            itemStyle: {
              color: !live ? '#3a4552' : flag && v !== null && (v === min || v === max) ? CHART.amber : '#8a9bb0',
              borderRadius: [2, 2, 0, 0],
            },
          })),
          label: {
            show: true,
            position: 'top',
            color: '#e6eaee',
            fontFamily: CHART.mono,
            fontSize: 10.5,
            formatter: (p: { value: number | null }) => (p.value === null ? 'n/a' : p.value.toFixed(3)),
          },
        },
      ],
    };
  }, [voltages, live]);
  return <EChart option={option} height={170} ariaLabel="Cell voltages" />;
}
