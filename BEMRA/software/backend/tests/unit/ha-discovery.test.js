import '../helpers/env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildDiscovery } from '../../src/integrations/ha-discovery.js';

const device = { device_id: 'bms-001', site_id: 'site-001', gateway_id: 'gw-001', cell_count: 4, thermistor_count: 2, site_name: 'Bench' };
const opts = { topicRoot: 'bemra-dev-x', prefix: 'bemra-dev-x/homeassistant' };

describe('Home Assistant discovery', () => {
  const cfgs = buildDiscovery(device, opts);
  const byKey = Object.fromEntries(cfgs.map((c) => [c.topic.split('/').at(-2), c]));

  it('creates core sensors, one per cell and thermistor, and a fault binary sensor', () => {
    for (const k of [
      'soc',
      'pack_voltage',
      'pack_current',
      'power',
      'bms_ic_temperature',
      'cell_spread',
      'bms_state',
      'operating_mode',
      'error_flags',
      'fault',
    ]) {
      assert.ok(byKey[k], k);
    }
    assert.equal(cfgs.filter((c) => /\/cell_\d+\//.test(c.topic)).length, 4);
    assert.equal(cfgs.filter((c) => /\/thermistor_\d+\//.test(c.topic)).length, 2);
    assert.equal(byKey.fault.topic, 'bemra-dev-x/homeassistant/binary_sensor/bemra_bms_001/fault/config');
  });

  it('reads the existing telemetry topic and follows gateway availability', () => {
    const soc = byKey.soc.payload;
    assert.equal(soc.state_topic, 'bemra-dev-x/v1/site-001/bms-001/live');
    assert.equal(soc.availability_topic, 'bemra-dev-x/v1/site-001/gateways/gw-001/status');
    assert.equal(soc.value_template, '{{ value_json.thingset.rSOC_pct }}');
    assert.equal(soc.unique_id, 'bemra_bms_001_soc');
    assert.equal(soc.expire_after, 300);
    assert.deepEqual(soc.device.identifiers, ['bemra_bms_001']);
  });

  it('uses the private discovery prefix, never the global default', () => {
    assert.ok(cfgs.every((c) => c.topic.startsWith('bemra-dev-x/homeassistant/')));
  });
});
