/**
 * Test-only fetch mock. bms-001 responses are REAL responses captured from the
 * running backend (src/test/fixtures). bms-002 is a SYNTHETIC test fixture
 * (8 cells, charging) used only to prove device isolation. Never used at runtime.
 */
import { vi } from 'vitest';
import devices from './fixtures/devices.json';
import detail from './fixtures/device-detail.json';
import status from './fixtures/status.json';
import latest from './fixtures/latest.json';
import telemetryRaw from './fixtures/telemetry-raw.json';
import telemetryAgg from './fixtures/telemetry-agg.json';

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

export interface MockOptions {
  fresh?: boolean;
  withSecondDevice?: boolean;
  down?: boolean;
  /** Override bms-001 latest measurements (simulates a newly published message). */
  latest001?: Record<string, unknown>;
}

export function installMockApi(opts: MockOptions = {}) {
  const fresh = <T extends { data_freshness?: { observed_at: string | null; age_s: number | null; stale: boolean } }>(
    o: T,
  ): T => {
    if (opts.fresh && o.data_freshness)
      Object.assign(o.data_freshness, {
        observed_at: new Date(Date.now() - 3000).toISOString(),
        age_s: 3,
        stale: false,
      });
    return o;
  };
  const l1 = fresh(clone(latest.data));
  for (const [k, v] of Object.entries(opts.latest001 ?? {}))
    l1.measurements[k as keyof typeof l1.measurements]!.value = v as never;

  const l2 = fresh(clone(latest.data));
  l2.device_id = 'bms-002';
  l2.measurements.rSOC_pct!.value = 41.0;
  l2.measurements.rPackVoltage_V!.value = 26.71;
  l2.measurements.rPackCurrent_A!.value = 3.4;
  l2.measurements.rCellVoltages_V!.value = [3.341, 3.338, 3.344, 3.29, 3.339, 3.342, 3.337, 3.34];
  const d2 = { ...clone(detail.data), device_id: 'bms-002', site_id: 'site-002', gateway_id: 'gw-002', cell_count: 8 };
  const s2 = fresh({ ...clone(status.data), device_id: 'bms-002', site_id: 'site-002', gateway_id: 'gw-002' });

  const byDevice: Record<string, Record<string, unknown>> = {
    'bms-001': { detail: detail.data, status: fresh(clone(status.data)), latest: l1 },
    'bms-002': { detail: d2, status: s2, latest: l2 },
  };
  const list = opts.withSecondDevice
    ? [...devices.data, { ...devices.data[0]!, device_id: 'bms-002', gateway_id: 'gw-002', cell_count: 8 }]
    : devices.data;

  const fn = vi.fn(async (input: RequestInfo | URL) => {
    if (opts.down) throw new TypeError('Failed to fetch');
    const url = new URL(String(input));
    const p = url.pathname.replace(/^\/api\/v1/, '');
    const json = (body: unknown, code = 200) =>
      new Response(JSON.stringify(body), { status: code, headers: { 'Content-Type': 'application/json' } });
    if (url.pathname === '/ready')
      return json({ status: 'ready', checks: { database: { ok: true }, migrations: { ok: true, pending: [] } } });
    if (p === '/devices') return json({ data: list });
    const m = p.match(/^\/devices\/([^/]+)(?:\/(\w+))?$/);
    const d = m ? byDevice[m[1]!] : undefined;
    if (!m || !d || (m[1] === 'bms-002' && !opts.withSecondDevice))
      return json({ error: { code: 'not_found', message: 'not registered' } }, 404);
    if (!m[2]) return json({ data: d.detail });
    if (m[2] === 'telemetry')
      return json(
        url.searchParams.get('interval') === 'raw'
          ? { ...telemetryRaw, data: m[1] === 'bms-001' ? telemetryRaw.data : [] }
          : telemetryAgg,
      );
    return json({ data: d[m[2]] });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}
