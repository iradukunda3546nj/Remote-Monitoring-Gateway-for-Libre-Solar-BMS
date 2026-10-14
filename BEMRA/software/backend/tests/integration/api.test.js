import '../helpers/env.js';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { getConfig } from '../../src/config/index.js';
import {
  databaseUnavailableReason,
  prepareDatabase,
  cleanupDatabase,
  makeIngestService,
  testMessage,
  newBootId,
  topicFor,
  toBuffer,
} from '../helpers/db.js';

const skip = await databaseUnavailableReason();

describe('REST API /api/v1', { skip: skip ?? false }, () => {
  let app;
  let pool;
  const boot = newBootId();

  before(async () => {
    pool = await prepareDatabase();
    const config = getConfig();
    app = createApp({ db: pool, config: { ...config, http: { ...config.http, apiKeys: [] } } });
    const service = makeIngestService();
    // 12 live samples, one per 5 minutes, 14:00..14:55Z, plus one event and meta
    for (let i = 0; i < 12; i++) {
      const m = testMessage('live.json', { boot_id: boot, sequence: 1000 + i });
      const t = new Date(Date.UTC(2026, 9, 9, 14, i * 5)).toISOString();
      m.timestamps = { measured_at: null, gateway_received_at: t, published_at: t };
      m.thingset.rSOC_pct = 80 - i;
      m.thingset.rPackVoltage_V = Number((13.3 - i * 0.01).toFixed(2)); // 2 decimals, as the firmware reports
      const r = await service.ingest({ topic: topicFor('live', m), payload: toBuffer(m) });
      assert.equal(r.outcome, 'stored');
    }
    const ev = testMessage('event.json', { boot_id: boot, sequence: 2000 });
    await service.ingest({ topic: topicFor('event', ev), payload: toBuffer(ev) });
    const meta = testMessage('meta.json', { boot_id: boot, sequence: 1 });
    await service.ingest({ topic: topicFor('meta', meta), payload: toBuffer(meta) });
    const st = testMessage('status-online.json', { boot_id: boot });
    await service.ingest({ topic: topicFor('status', st), payload: toBuffer(st), retained: true });
  });
  after(cleanupDatabase);

  const range = 'from=2026-10-09T14:00:00Z&to=2026-10-09T15:00:00Z';

  it('health and readiness', async () => {
    await request(app).get('/health').expect(200);
    const r = await request(app).get('/ready').expect(200);
    assert.equal(r.body.checks.migrations.ok, true);
  });

  it('lists sites and devices with associations', async () => {
    const sites = await request(app).get('/api/v1/sites').expect(200);
    assert.ok(sites.body.data.some((s) => s.site_id === 'test-site-a' && s.device_count === 1));
    const devices = await request(app).get('/api/v1/devices?site=test-site-a').expect(200);
    assert.deepEqual(
      devices.body.data.map((d) => [d.device_id, d.gateway_id, d.site_id]),
      [['test-bms-1', 'test-gw-1', 'test-site-a']],
    );
    assert.equal(devices.body.data[0].id, undefined, 'internal id not exposed');
  });

  it('device detail includes location, assignment history and metadata', async () => {
    const r = await request(app).get('/api/v1/devices/test-bms-1').expect(200);
    assert.equal(r.body.data.site.latitude, -1.9441);
    assert.equal(r.body.data.assignment_history.length, 2);
    assert.equal(r.body.data.latest_metadata.layout.cell_count, 4);
    assert.equal(r.body.data.cell_count, 4);
  });

  it('latest returns units, decoded state, missing fields and freshness', async () => {
    const r = await request(app).get('/api/v1/devices/test-bms-1/latest').expect(200);
    const d = r.body.data;
    assert.deepEqual(d.measurements.rPackVoltage_V, { value: 13.19, unit: 'V', thingset_id: '0x71' });
    assert.equal(d.measurements.rSOC_pct.value, 69);
    assert.equal(d.bms_state.code, 'NORMAL');
    assert.deepEqual(d.error_flags.active, []);
    assert.ok(d.not_reported.includes('rShuntTemp_degC'));
    assert.equal(d.timestamps.measured_at, null);
    assert.equal(d.timestamps.observed_at, '2026-10-09T14:55:00.000Z');
    assert.equal(d.source.gateway_id, 'test-gw-1');
    assert.equal(d.data_freshness.stale, true);
  });

  it('thingset returns the complete stored object unchanged', async () => {
    const r = await request(app).get('/api/v1/devices/test-bms-1/thingset').expect(200);
    const expected = testMessage('live.json').thingset;
    expected.rSOC_pct = 69;
    expected.rPackVoltage_V = 13.19;
    assert.deepEqual(r.body.data.thingset, expected);
  });

  it('cells returns per-cell voltages and the BMS statistics', async () => {
    const r = await request(app).get('/api/v1/devices/test-bms-1/cells').expect(200);
    assert.deepEqual(
      r.body.data.cells.map((c) => c.voltage_v),
      [3.311, 3.302, 3.318, 3.309],
    );
    assert.equal(r.body.data.bms_statistics.rCellMinVoltage_V, 3.302);
  });

  it('raw telemetry is time-filtered, ordered and keyset-paginated', async () => {
    const p1 = await request(app).get(`/api/v1/devices/test-bms-1/telemetry?${range}&order=asc&limit=5&fields=rSOC_pct`).expect(200);
    assert.equal(p1.body.data.length, 5);
    assert.deepEqual(
      p1.body.data.map((x) => x.values.rSOC_pct),
      [80, 79, 78, 77, 76],
    );
    assert.equal(p1.body.meta.units.rSOC_pct, '%');
    const p2 = await request(app)
      .get(`/api/v1/devices/test-bms-1/telemetry?${range}&order=asc&limit=5&fields=rSOC_pct&cursor=${p1.body.meta.next_cursor}`)
      .expect(200);
    assert.deepEqual(
      p2.body.data.map((x) => x.values.rSOC_pct),
      [75, 74, 73, 72, 71],
    );
    const p3 = await request(app)
      .get(`/api/v1/devices/test-bms-1/telemetry?${range}&order=asc&limit=5&fields=rSOC_pct&cursor=${p2.body.meta.next_cursor}`)
      .expect(200);
    assert.equal(p3.body.data.length, 2);
    assert.equal(p3.body.meta.next_cursor, null);
  });

  it('aggregated telemetry buckets with min/avg/max', async () => {
    const r = await request(app).get(`/api/v1/devices/test-bms-1/telemetry?${range}&interval=15m&order=asc&fields=rSOC_pct`).expect(200);
    assert.equal(r.body.data.length, 4);
    assert.deepEqual(r.body.data[0].values.rSOC_pct, { min: 78, avg: 79, max: 80 });
    assert.equal(r.body.data[0].sample_count, 3);
    assert.equal(r.body.data[0].bucket_start, '2026-10-09T14:00:00.000Z');
  });

  it('events, Home Assistant and MPM summary endpoints', async () => {
    const ev = await request(app).get('/api/v1/devices/test-bms-1/events?from=2026-10-09T00:00:00Z&to=2026-10-10T00:00:00Z').expect(200);
    assert.equal(ev.body.data[0].code, 'BMS_ERR_CELL_UNDERVOLTAGE');

    const ha = await request(app).get('/api/v1/integrations/home-assistant/devices/test-bms-1').expect(200);
    assert.equal(ha.body.rSOC_pct, 69);
    assert.equal(ha.body.cell_3_V, 3.318);
    assert.equal(ha.body.bms_state_code, 'NORMAL');

    const mpm = await request(app).get(`/api/v1/integrations/mpm/devices/test-bms-1/summary?interval=hourly&${range}`).expect(200);
    assert.equal(mpm.body.data.length, 1);
    assert.equal(mpm.body.data[0].sample_count, 12);
    assert.equal(mpm.body.data[0].soc_pct_last, 69);
    assert.equal(mpm.body.data[0].soc_pct_min, 69);
    assert.equal(mpm.body.data[0].cell_voltage_spread_mv_max, 16);
    assert.match(mpm.body.meta.compatibility, /provisional/);
  });

  it('returns consistent errors for bad input and unknown resources', async () => {
    const e1 = await request(app).get('/api/v1/devices/NOT_VALID/latest').expect(400);
    assert.equal(e1.body.error.code, 'bad_request');
    await request(app).get('/api/v1/devices/unknown-device/latest').expect(404);
    await request(app).get('/api/v1/devices/test-bms-1/telemetry?from=yesterday').expect(400);
    await request(app).get('/api/v1/devices/test-bms-1/telemetry?fields=rErrorFlags&interval=1h').expect(400);
    await request(app)
      .get(`/api/v1/devices/test-bms-1/telemetry?interval=1m&from=2026-01-01T00:00:00Z&to=2026-10-01T00:00:00Z`)
      .expect(400);
    await request(app).get('/api/v1/nope').expect(404);
    await request(app).post('/api/v1/devices').expect(404);
  });

  it('enforces API keys when configured', async () => {
    const config = getConfig();
    const secured = createApp({ db: pool, config: { ...config, http: { ...config.http, apiKeys: ['k1'] } } });
    await request(secured).get('/api/v1/devices').expect(401);
    await request(secured).get('/api/v1/devices').set('X-API-Key', 'wrong').expect(401);
    await request(secured).get('/api/v1/devices').set('X-API-Key', 'k1').expect(200);
    await request(secured).get('/health').expect(200);
  });

  it('serves the OpenAPI document', async () => {
    const r = await request(app).get('/api/v1/openapi.json').expect(200);
    assert.equal(r.body.openapi.startsWith('3.1'), true);
  });
});
