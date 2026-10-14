import '../helpers/env.js';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  databaseUnavailableReason,
  prepareDatabase,
  cleanupDatabase,
  makeIngestService,
  testMessage,
  newBootId,
  topicFor,
  toBuffer,
  TOPIC_ROOT,
} from '../helpers/db.js';

const skip = await databaseUnavailableReason();

describe('MQTT ingestion -> PostgreSQL', { skip: skip ?? false }, () => {
  let pool;
  let service;
  const boot = newBootId();
  const ingest = (kind, msg, extra = {}) => service.ingest({ topic: topicFor(kind, msg), payload: toBuffer(msg), ...extra });

  before(async () => {
    pool = await prepareDatabase();
    service = makeIngestService();
  });
  after(cleanupDatabase);

  it('stores a live message with the complete ThingSet object, typed columns and cells', async () => {
    const msg = testMessage('live.json', { boot_id: boot, sequence: 100 });
    const r = await ingest('live', msg);
    assert.equal(r.outcome, 'stored');
    assert.equal(r.table, 'telemetry');

    const { rows } = await pool.query(
      `SELECT t.*, d.external_id AS device, s.external_id AS site, g.external_id AS gateway
         FROM telemetry t JOIN devices d ON d.id = t.device_id JOIN sites s ON s.id = t.site_id
         JOIN gateways g ON g.id = t.gateway_id WHERE t.id = $1`,
      [r.id],
    );
    const row = rows[0];
    assert.deepEqual(row.thingset, msg.thingset, 'complete ThingSet object preserved');
    assert.equal(row.device, 'test-bms-1');
    assert.equal(row.site, 'test-site-a');
    assert.equal(row.gateway, 'test-gw-1');
    assert.equal(row.pack_voltage_v, msg.thingset.rPackVoltage_V);
    assert.equal(row.pack_current_a, msg.thingset.rPackCurrent_A);
    assert.equal(row.soc_pct, msg.thingset.rSOC_pct);
    assert.equal(row.bms_state, 3);
    assert.equal(row.error_flags, 0);
    assert.deepEqual(row.cell_temps_degc, msg.thingset.rCellTemps_degC);
    assert.equal(row.shunt_temp_degc, null, 'absent object -> NULL column');
    assert.equal(row.measured_at, null, 'measurement time never invented');
    assert.equal(row.gateway_received_at.toISOString(), '2026-10-09T14:30:00.000Z');
    assert.equal(row.observed_at_source, 'gateway');
    assert.equal(row.delivery, 'live');

    const cells = await pool.query('SELECT cell_index, voltage_v FROM cell_measurements WHERE telemetry_id = $1 ORDER BY cell_index', [
      r.id,
    ]);
    assert.deepEqual(
      cells.rows.map((c) => c.voltage_v),
      msg.thingset.rCellVoltages_V,
    );
  });

  it('ignores an identical redelivery (dedup on device + boot_id + sequence)', async () => {
    const msg = testMessage('live.json', { boot_id: boot, sequence: 100 });
    const before = await pool.query(
      "SELECT count(*)::int n FROM telemetry t JOIN devices d ON d.id=t.device_id WHERE d.external_id='test-bms-1'",
    );
    const r = await ingest('live', msg);
    assert.equal(r.outcome, 'duplicate');
    const afterCount = await pool.query(
      "SELECT count(*)::int n FROM telemetry t JOIN devices d ON d.id=t.device_id WHERE d.external_id='test-bms-1'",
    );
    assert.equal(afterCount.rows[0].n, before.rows[0].n);
  });

  it('rejects a reused sequence number carrying different data', async () => {
    const msg = testMessage('live.json', { boot_id: boot, sequence: 100 });
    msg.thingset.rSOC_pct = 12.3;
    const r = await ingest('live', msg);
    assert.equal(r.outcome, 'rejected');
    assert.equal(r.reason, 'sequence_conflict');
  });

  it('treats the same sequence after a reboot (new boot_id) as a new message', async () => {
    const r = await ingest('live', testMessage('live.json', { boot_id: newBootId(), sequence: 100 }));
    assert.equal(r.outcome, 'stored');
  });

  it('stores replayed (older) telemetry without displacing the latest snapshot', async () => {
    const r = await ingest('replay', testMessage('replay.json', { boot_id: boot, sequence: 90 }));
    assert.equal(r.outcome, 'stored');
    const { rows } = await pool.query(
      `SELECT sequence, delivery FROM telemetry t JOIN devices d ON d.id = t.device_id
        WHERE d.external_id = 'test-bms-1' AND boot_id = $1 ORDER BY observed_at DESC, t.id DESC LIMIT 1`,
      [boot],
    );
    assert.equal(rows[0].sequence, 100, 'latest by measurement time is still the live message');
  });

  it('rejects invalid messages without throwing, and records them', async () => {
    const cases = [
      ['invalid_json', topicFor('live', testMessage('live.json')), Buffer.from('{not json')],
      [
        'schema_violation',
        topicFor('live', testMessage('live.json')),
        toBuffer({ ...testMessage('live.json'), thingset: { rBmsState: 'discharging' } }),
      ],
      [
        'identity_mismatch',
        `${TOPIC_ROOT}/v1/test-site-a/test-bms-1/live`,
        toBuffer(testMessage('live.json', { device_id: 'test-bms-2' })),
      ],
      [
        'unknown_device',
        `${TOPIC_ROOT}/v1/test-site-a/test-bms-404/live`,
        toBuffer(testMessage('live.json', { device_id: 'test-bms-404' })),
      ],
      [
        'site_mismatch',
        `${TOPIC_ROOT}/v1/test-site-b/test-bms-1/live`,
        toBuffer(testMessage('live.json', { site_id: 'test-site-b', boot_id: boot, sequence: 101 })),
      ],
      ['unknown_topic', `${TOPIC_ROOT}/v1/test-site-a/test-bms-1/summary`, toBuffer(testMessage('live.json'))],
      ['payload_too_large', topicFor('live', testMessage('live.json')), Buffer.alloc(20000, 32)],
    ];
    for (const [reason, topic, payload] of cases) {
      const r = await service.ingest({ topic, payload });
      assert.equal(r.outcome, 'rejected', reason);
      assert.equal(r.reason, reason);
    }
    const { rows } = await pool.query('SELECT reason FROM ingest_rejections WHERE topic LIKE $1', [`${TOPIC_ROOT}/%`]);
    for (const [reason] of cases)
      assert.ok(
        rows.some((x) => x.reason === reason),
        `rejection row for ${reason}`,
      );
  });

  it('stores events with dedup', async () => {
    const msg = testMessage('event.json', { boot_id: boot, sequence: 101 });
    assert.equal((await ingest('event', msg)).outcome, 'stored');
    assert.equal((await ingest('event', msg)).outcome, 'duplicate');
    const { rows } = await pool.query(
      "SELECT code, severity, error_flags, bms_state FROM bms_events e JOIN devices d ON d.id=e.device_id WHERE d.external_id='test-bms-1'",
    );
    assert.deepEqual(rows[0], { code: 'BMS_ERR_CELL_UNDERVOLTAGE', severity: 'critical', error_flags: 1, bms_state: 1 });
  });

  it('applies meta to the device record and stores the snapshot', async () => {
    const msg = testMessage('meta.json', { boot_id: boot, sequence: 1 });
    assert.equal((await ingest('meta', msg, { retained: true })).outcome, 'stored');
    assert.equal((await ingest('meta', msg, { retained: true })).outcome, 'duplicate', 'retained redelivery ignored');
    const { rows } = await pool.query(
      "SELECT firmware_version, cell_count, thermistor_count, chemistry, nominal_capacity_ah FROM devices WHERE external_id='test-bms-1'",
    );
    assert.deepEqual(rows[0], { firmware_version: 'v23.1', cell_count: 4, thermistor_count: 2, chemistry: 'LFP', nominal_capacity_ah: 6 });
  });

  it('records gateway status and the Last Will once per boot', async () => {
    const online = testMessage('status-online.json', { boot_id: boot });
    const lwt = testMessage('status-lwt-offline.json', { boot_id: boot });
    assert.equal((await ingest('status', online, { retained: true })).outcome, 'stored');
    assert.equal((await ingest('status', online, { retained: true })).outcome, 'duplicate');
    assert.equal((await ingest('status', lwt, { retained: true })).outcome, 'stored');
    assert.equal((await ingest('status', lwt, { retained: true })).outcome, 'duplicate');
  });

  it('accepts buffered data from the old site after a relocation, and new data only from the new site', async () => {
    // Relocate test-bms-1 from site A to site B at 2026-10-09T15:00Z
    await pool.query(
      `UPDATE device_site_assignments SET valid_to = '2026-10-09T15:00:00Z'
        WHERE device_id = (SELECT id FROM devices WHERE external_id='test-bms-1') AND valid_to IS NULL`,
    );
    await pool.query(
      `INSERT INTO device_site_assignments (device_id, site_id, valid_from, note)
       SELECT d.id, s.id, '2026-10-09T15:00:00Z', 'relocated' FROM devices d, sites s
        WHERE d.external_id='test-bms-1' AND s.external_id='test-site-b'`,
    );
    const oldSite = testMessage('replay.json', { boot_id: boot, sequence: 95 }); // measured 14:18, site A
    assert.equal((await ingest('replay', oldSite)).outcome, 'stored');

    const newSite = testMessage('live.json', { site_id: 'test-site-b', boot_id: boot, sequence: 200 });
    newSite.timestamps = { measured_at: null, gateway_received_at: '2026-10-09T16:00:00Z', published_at: '2026-10-09T16:00:01Z' };
    assert.equal((await ingest('live', newSite)).outcome, 'stored');

    const wrong = testMessage('live.json', { boot_id: boot, sequence: 201 }); // claims site A at 16:00
    wrong.timestamps = newSite.timestamps;
    const r = await ingest('live', wrong);
    assert.equal(r.reason, 'site_mismatch');

    const { rows } = await pool.query(
      `SELECT t.sequence, s.external_id AS site FROM telemetry t JOIN sites s ON s.id = t.site_id
        WHERE t.boot_id = $1 AND t.sequence IN (95, 200) ORDER BY t.sequence`,
      [boot],
    );
    assert.deepEqual(rows, [
      { sequence: 95, site: 'test-site-a' },
      { sequence: 200, site: 'test-site-b' },
    ]);
  });
});
