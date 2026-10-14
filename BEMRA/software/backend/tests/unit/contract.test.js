import '../helpers/env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePayload, checkIdentity } from '../../src/validation/contract-validator.js';
import { MEAS_OBJECTS } from '../../src/contracts/thingset.js';
import { sample } from '../helpers/samples.js';

const schemaDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/contracts/schemas');
const telemetrySchema = JSON.parse(fs.readFileSync(path.join(schemaDir, 'telemetry.schema.json'), 'utf8'));

const expectValid = (kind, payload) => {
  const r = validatePayload(kind, payload);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
};
const expectInvalid = (kind, payload, pathFragment) => {
  const r = validatePayload(kind, payload);
  assert.equal(r.ok, false, 'expected payload to be rejected');
  if (pathFragment)
    assert.ok(
      r.errors.some((e) => e.path.includes(pathFragment)),
      JSON.stringify(r.errors),
    );
};

describe('contract v1: documented samples', () => {
  it('accepts every valid sample', () => {
    expectValid('live', sample('live.json'));
    expectValid('replay', sample('replay.json'));
    expectValid('meta', sample('meta.json'));
    expectValid('event', sample('event.json'));
    expectValid('status', sample('status-online.json'));
    expectValid('status', sample('status-lwt-offline.json'));
  });

  it('rejects every sample in docs/samples/invalid that is invalid by schema', () => {
    expectInvalid('live', sample('invalid/bms-state-as-string.json'), '/thingset/rBmsState');
    expectInvalid('live', sample('invalid/missing-soc.json'), '/thingset');
    expectInvalid('live', sample('invalid/writable-object-in-live.json'), '/thingset');
    expectInvalid('live', sample('invalid/timestamp-without-offset.json'), '/timestamps/published_at');
  });
});

describe('contract v1: telemetry rules', () => {
  it('schema covers every verified Meas object, and nothing else', () => {
    const schemaNames = Object.keys(telemetrySchema.properties.thingset.properties).sort();
    const catalogue = MEAS_OBJECTS.map((o) => o.name).sort();
    assert.deepEqual(schemaNames, catalogue);
  });

  it('allows conditional objects to be absent (firmware without BMS_IC_SWITCHES)', () => {
    const m = sample('live.json');
    delete m.thingset.rStackVoltage_V;
    delete m.thingset.rPackCurrent_A;
    delete m.thingset.rMOSFETTemp_degC;
    expectValid('live', m);
  });

  it('accepts null for an invalid measurement but not for integer bitmaps', () => {
    const m = sample('live.json');
    m.thingset.rPackCurrent_A = null;
    m.thingset.rCellVoltages_V[2] = null;
    expectValid('live', m);
    m.thingset.rErrorFlags = null;
    expectInvalid('live', m, '/thingset/rErrorFlags');
  });

  it('preserves unknown read-only ThingSet objects but rejects writable ones', () => {
    const m = sample('live.json');
    m.thingset.rFutureMeasurement_mV = 12;
    expectValid('live', m);
    m.thingset.wChgEnable = true;
    expectInvalid('live', m);
  });

  it('enforces uint32 / uint8 ranges from the firmware types', () => {
    const m = sample('live.json');
    m.thingset.rErrorFlags = 4294967296;
    expectInvalid('live', m, '/thingset/rErrorFlags');
    const s = sample('live.json');
    s.thingset.rBmsState = 256;
    expectInvalid('live', s, '/thingset/rBmsState');
  });

  it('rejects SOC outside the firmware clamp range and absurd cell voltages', () => {
    const m = sample('live.json');
    m.thingset.rSOC_pct = 100.5;
    expectInvalid('live', m, '/thingset/rSOC_pct');
    const c = sample('live.json');
    c.thingset.rCellVoltages_V = [3.3, 33.0];
    expectInvalid('live', c, '/thingset/rCellVoltages_V/1');
  });

  it('bounds array lengths (max 32 cells)', () => {
    const m = sample('live.json');
    m.thingset.rCellVoltages_V = Array(33).fill(3.3);
    expectInvalid('live', m, '/thingset/rCellVoltages_V');
    m.thingset.rCellVoltages_V = [];
    expectInvalid('live', m, '/thingset/rCellVoltages_V');
  });

  it('requires all three timestamp keys but allows null values', () => {
    const m = sample('live.json');
    m.timestamps = { measured_at: null, gateway_received_at: null, published_at: null };
    expectValid('live', m);
    delete m.timestamps.measured_at;
    expectInvalid('live', m, '/timestamps');
  });

  it('accepts any 1.x schema version and rejects 2.0', () => {
    const m = sample('live.json');
    m.schema_version = '1.7';
    expectValid('live', m);
    m.schema_version = '2.0';
    expectInvalid('live', m, '/schema_version');
  });

  it('rejects unknown envelope fields and reserved device id', () => {
    const m = sample('live.json');
    m.firmware = 'x';
    expectInvalid('live', m);
    const g = sample('live.json');
    g.device_id = 'gateways';
    expectInvalid('live', g, '/device_id');
  });

  it('does not mutate the payload during validation', () => {
    const m = sample('live.json');
    const before = JSON.stringify(m);
    validatePayload('live', m);
    assert.equal(JSON.stringify(m), before);
  });
});

describe('contract v1: other message kinds', () => {
  it('meta requires layout with cell and thermistor counts', () => {
    const m = sample('meta.json');
    delete m.layout.cell_count;
    expectInvalid('meta', m, '/layout');
  });

  it('meta conf only accepts s-prefixed (Conf group) objects', () => {
    const m = sample('meta.json');
    m.conf.rPackVoltage_V = 13;
    expectInvalid('meta', m, '/conf');
  });

  it('event codes and severities are constrained', () => {
    const e = sample('event.json');
    e.event.severity = 'fatal';
    expectInvalid('event', e, '/event/severity');
    const c = sample('event.json');
    c.event.code = 'lower_case';
    expectInvalid('event', c, '/event/code');
  });

  it('status requires a known state', () => {
    const s = sample('status-online.json');
    s.state = 'sleeping';
    expectInvalid('status', s, '/state');
  });
});

describe('topic/payload identity check', () => {
  it('detects device and site mismatches', () => {
    const m = sample('invalid/identity-mismatch.json');
    const mismatches = checkIdentity({ kind: 'live', siteId: 'site-001', deviceId: 'bms-001' }, m);
    assert.deepEqual(
      mismatches.map((x) => x.field),
      ['device_id'],
    );
    assert.deepEqual(checkIdentity({ kind: 'live', siteId: 'site-001', deviceId: 'bms-001' }, sample('live.json')), []);
  });
});
