import { useEffect, useState } from 'react';
import { useDevice, useDevices, useLatest, useReady, useStatus } from '../hooks/queries';
import { useNow } from '../hooks/useNow';
import { ApiError } from '../api/client';
import { deriveSnapshot, gatewayLink } from './snapshot';
import { Battery } from './Battery';
import { CellChart } from './CellChart';
import { TrendCard } from './TrendCard';
import { ageSeconds, fmt, fmtAge, fmtSigned, fmtUtc } from '../domain/format';
import { isLive, LIVENESS_LABEL } from '../domain/freshness';
import { ERROR_BY_CODE } from '../domain/thingset';

/** Selected device lives in the URL (?device=bms-001) so the view can be shared and reloaded. */
function useSelectedDevice(available: string[]) {
  const [selected, setSelected] = useState(() => new URLSearchParams(window.location.search).get('device') ?? '');
  useEffect(() => {
    if (available.length && !available.includes(selected)) setSelected(available[0]!);
  }, [available, selected]);
  useEffect(() => {
    if (!selected) return;
    const url = new URL(window.location.href);
    url.searchParams.set('device', selected);
    window.history.replaceState(null, '', url);
  }, [selected]);
  return [selected, setSelected] as const;
}

function Kpi({
  label,
  value,
  unit,
  sub,
  dim,
  tone,
}: {
  label: string;
  value: string;
  unit?: string;
  sub?: string;
  dim?: boolean;
  tone?: string;
}) {
  return (
    <div className={`kpi ${dim ? 'kpi--dim' : ''}`}>
      <div className="kpi__label">{label}</div>
      <div className={`kpi__value num ${tone ? `tone-${tone}` : ''}`}>
        {value}
        {unit && value !== 'n/a' && <span className="kpi__unit">{unit}</span>}
      </div>
      {sub && <div className="kpi__sub">{sub}</div>}
    </div>
  );
}

const show = (v: number | null, d: number) => (v === null ? 'n/a' : fmt(v, d));

export function Dashboard() {
  const ready = useReady();
  const devices = useDevices();
  const ids = (devices.data ?? []).map((d) => d.device_id);
  const [deviceId, setDeviceId] = useSelectedDevice(ids);
  const detail = useDevice(deviceId || undefined);
  const status = useStatus(deviceId || undefined);
  const latest = useLatest(deviceId || undefined);
  const now = useNow(1000);
  const s = deriveSnapshot(detail.data, status.data, latest.data, now);
  const live = isLive(s.liveness);
  const mode = !live ? 'not live' : s.flow === 'unknown' ? 'n/a' : s.flow;
  const apiOk = ready.data?.status === 'ready';
  const link = gatewayLink(status.data, now);
  const publishedAt = latest.data?.timestamps.published_at ?? null;
  const receivedAt = latest.data?.timestamps.ingested_at ?? null;
  const loadError = devices.error ?? status.error ?? latest.error;
  const unreachable = loadError instanceof ApiError && loadError.kind === 'network';

  return (
    <div className="page">
      <header className="top">
        <div className="brand">
          <div className="brand__logo">
            BEMR<span>A</span>
          </div>
          <div className="brand__sub">Battery Energy Monitoring &amp; Remote Analytics</div>
        </div>
        <label className="picker">
          <span>Device</span>
          <select value={deviceId} onChange={(e) => setDeviceId(e.target.value)} aria-label="Select device">
            {(devices.data ?? []).map((d) => (
              <option key={d.device_id} value={d.device_id}>
                {d.device_id}
                {d.site_name ? ` · ${d.site_name}` : ''}
              </option>
            ))}
          </select>
        </label>
        <div className={`api ${apiOk ? 'api--ok' : ready.isPending ? '' : 'api--down'}`} role="status">
          <span className="dot" aria-hidden />{' '}
          {apiOk ? 'API connected' : ready.isPending ? 'Connecting…' : 'API unavailable'}
        </div>
      </header>

      {unreachable && <div className="alert">Backend unreachable. Start the API with npm run start:api.</div>}
      {!devices.isPending && ids.length === 0 && !unreachable && (
        <div className="alert">No devices registered in the backend.</div>
      )}
      {latest.data === null && (
        <div className="alert">No telemetry stored for {deviceId} yet. Publish a live message to see measurements.</div>
      )}

      {deviceId && (
        <>
          <section className="kpis" aria-label="Telemetry summary">
            <Kpi label="SOC" value={show(s.socPct, 1)} unit="%" dim={!live} />
            <Kpi label="Pack voltage" value={show(s.packV, 2)} unit="V" dim={!live} />
            <Kpi
              label="Pack current"
              value={s.currentA === null ? 'n/a' : fmtSigned(s.currentA, 2)}
              unit="A"
              dim={!live}
            />
            <Kpi label="Power" value={s.powerW === null ? 'n/a' : fmtSigned(s.powerW, 1)} unit="W" dim={!live} />
            <Kpi
              label="Temperature"
              value={show(s.tempMaxC, 1)}
              unit="°C"
              sub={s.tempSource ? `max (${s.tempSource})` : undefined}
              dim={!live}
            />
            <Kpi
              label="Operating mode"
              value={mode.toUpperCase()}
              tone={live ? (s.flow === 'charging' || s.flow === 'discharging' ? s.flow : 'idle') : 'offline'}
              sub={s.stateCode ? `BMS state: ${s.stateCode}` : undefined}
            />
          </section>

          <div className="row">
            <section className="card" aria-label="Battery">
              <header className="card__head">
                <h2>Battery</h2>
                <span className={`badge badge--${s.liveness}`}>{LIVENESS_LABEL[s.liveness]}</span>
              </header>
              <Battery
                socPct={s.socPct}
                currentA={s.currentA}
                flow={s.flow}
                live={live}
                fault={s.activeFaults.length > 0}
              />
            </section>

            <section className="card" aria-label="Cell voltages">
              <header className="card__head">
                <h2>Cell voltages</h2>
                <span className="card__meta num">
                  {s.cellVoltages.length}S · Δ {s.stats.spreadMv === null ? 'n/a' : `${s.stats.spreadMv.toFixed(1)} mV`}
                </span>
              </header>
              {s.cellVoltages.length ? (
                <CellChart voltages={s.cellVoltages} live={live} />
              ) : (
                <p className="empty">No cell measurements</p>
              )}
            </section>

            <section className="card" aria-label="Status">
              <header className="card__head">
                <h2>Status</h2>
              </header>
              <dl className="status">
                <dt>Device</dt>
                <dd className="num" data-testid="status-device">
                  {deviceId}
                </dd>
                <dt>Site</dt>
                <dd>{detail.data?.site?.name ?? detail.data?.site_id ?? 'n/a'}</dd>
                <dt>Gateway</dt>
                <dd>
                  <span className="num">{status.data?.gateway_id ?? 'n/a'}</span>{' '}
                  <span className={link.state === 'online' ? 'ok' : 'warn'} data-testid="gateway-state">
                    {
                      { online: 'online', offline: 'offline (Last Will)', silent: 'no recent data', unknown: '' }[
                        link.state
                      ]
                    }
                  </span>
                  {link.heardAgeS !== null && <span className="muted"> · heard {fmtAge(link.heardAgeS)} ago</span>}
                </dd>
                <dt>Last published</dt>
                <dd data-testid="last-published">
                  {publishedAt ? (
                    <>
                      <span className="num">{fmtUtc(publishedAt)} UTC</span>{' '}
                      <span className={live ? 'muted' : 'warn'}>({fmtAge(ageSeconds(publishedAt, now))} ago)</span>
                    </>
                  ) : (
                    <span className="muted">{latest.data ? 'not stamped by gateway' : 'never'}</span>
                  )}
                </dd>
                <dt>Received</dt>
                <dd>
                  {receivedAt ? (
                    <>
                      <span className="num">{fmtUtc(receivedAt)} UTC</span>{' '}
                      <span className="muted">({fmtAge(ageSeconds(receivedAt, now))} ago)</span>
                    </>
                  ) : (
                    'never'
                  )}
                </dd>
                <dt>Faults</dt>
                <dd>
                  {s.activeFaults.length === 0 ? (
                    <span className="muted">none</span>
                  ) : (
                    s.activeFaults.map((c) => (
                      <span key={c} className="fault" title={c}>
                        {ERROR_BY_CODE[c]?.title ?? c}
                      </span>
                    ))
                  )}
                </dd>
              </dl>
            </section>
          </div>

          <TrendCard key={deviceId} deviceId={deviceId} />
        </>
      )}
    </div>
  );
}
