import type { FlowState } from '../domain/battery';
import { fmt, fmtSigned } from '../domain/format';

/** Fill colour by state of charge. */
export function socColor(soc: number): string {
  if (soc >= 60) return '#3fb950';
  if (soc >= 30) return '#e3a33a';
  if (soc >= 15) return '#f0883e';
  return '#e5534b';
}

/**
 * Plain battery outline with SOC fill and the operating direction as text.
 * Direction comes from the measured pack current (+ = charging).
 */
export function Battery({
  socPct,
  currentA,
  flow,
  live,
  fault,
}: {
  socPct: number | null;
  currentA: number | null;
  flow: FlowState;
  live: boolean;
  fault: boolean;
}) {
  const soc = socPct === null ? null : Math.max(0, Math.min(100, socPct));
  const mode = !live ? 'offline' : flow === 'charging' || flow === 'discharging' ? flow : 'idle';
  const title = {
    charging: 'Charging',
    discharging: 'Discharging',
    idle: flow === 'unknown' ? 'Current n/a' : 'Idle',
    offline: 'Not live',
  }[mode];
  const outline = fault ? '#e5534b' : '#c9d1d9';

  return (
    <div className="battery">
      <svg
        viewBox="0 0 280 120"
        role="img"
        aria-label={`State of charge ${soc === null ? 'n/a' : `${fmt(soc, 1)}%`}, ${title}`}
      >
        <rect x="4" y="10" width="250" height="100" rx="8" fill="none" stroke={outline} strokeWidth="3" />
        <rect x="256" y="42" width="12" height="36" rx="3" fill={outline} />
        {soc !== null && (
          <rect
            className="battery__fill"
            data-testid="soc-fill"
            x="12"
            y="18"
            width="234"
            height="84"
            rx="4"
            fill={live ? socColor(soc) : '#3a4552'}
            style={{ transform: `scaleX(${soc / 100})` }}
          />
        )}
        <text x="129" y="72" textAnchor="middle" className="battery__soc" data-testid="soc-readout">
          {soc === null ? 'n/a' : `${fmt(soc, 1)}%`}
        </text>
      </svg>
      <div className={`battery__mode mode--${mode}`} data-testid="flow-caption">
        {title}
        {mode !== 'offline' && currentA !== null && <span className="num"> {fmtSigned(currentA, 2)} A</span>}
      </div>
    </div>
  );
}
