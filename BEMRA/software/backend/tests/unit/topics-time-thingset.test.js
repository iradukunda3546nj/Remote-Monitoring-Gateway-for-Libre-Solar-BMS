import '../helpers/env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseTopic, subscriptionFilters, deviceTopic, statusTopic } from '../../src/contracts/topics.js';
import { computeTimeFlags, messageTime } from '../../src/ingestion/time-quality.js';
import { decodeErrorFlags, describeBmsState } from '../../src/contracts/thingset.js';

describe('topics', () => {
  const root = 'bemra-dev-abc';

  it('parses device topics', () => {
    assert.deepEqual(parseTopic(root, `${root}/v1/site-001/bms-001/live`), { kind: 'live', siteId: 'site-001', deviceId: 'bms-001' });
    assert.equal(parseTopic(root, `${root}/v1/site-001/bms-001/replay`).kind, 'replay');
  });

  it('parses gateway status topics', () => {
    assert.deepEqual(parseTopic(root, `${root}/v1/site-001/gateways/gw-001/status`), {
      kind: 'status',
      siteId: 'site-001',
      gatewayId: 'gw-001',
    });
  });

  it('rejects topics outside the contract', () => {
    for (const t of [
      `${root}/v2/site-001/bms-001/live`,
      `other/v1/site-001/bms-001/live`,
      `${root}/v1/site-001/bms-001/summary`, // removed from v1
      `${root}/v1/site-001/bms-001/status`, // status is gateway-scoped
      `${root}/v1/Site_001/bms-001/live`,
      `${root}/v1/site-001/gateways/live`,
      `${root}/v1/site-001/bms-001/live/extra`,
    ]) {
      assert.equal(parseTopic(root, t), null, t);
    }
  });

  it('builders and filters agree with the parser', () => {
    assert.equal(parseTopic(root, deviceTopic(root, 's-1', 'd-1', 'event')).kind, 'event');
    assert.equal(parseTopic(root, statusTopic(root, 's-1', 'g-1')).gatewayId, 'g-1');
    assert.equal(subscriptionFilters(root).length, 5);
  });
});

describe('time quality', () => {
  const now = new Date('2026-10-09T15:00:00Z');

  it('never invents a measurement time', () => {
    const ts = { measured_at: null, gateway_received_at: null, published_at: null };
    assert.deepEqual(computeTimeFlags(ts, now, 'live'), ['no_gateway_clock']);
    assert.equal(messageTime(ts, now), now);
  });

  it('flags future timestamps and late live delivery', () => {
    assert.ok(
      computeTimeFlags({ measured_at: null, gateway_received_at: '2026-10-09T15:30:00Z', published_at: null }, now, 'live').includes(
        'future_timestamp',
      ),
    );
    assert.ok(
      computeTimeFlags({ measured_at: null, gateway_received_at: null, published_at: '2026-10-09T14:00:00Z' }, now, 'live').includes(
        'late_delivery',
      ),
    );
    assert.deepEqual(
      computeTimeFlags({ measured_at: null, gateway_received_at: null, published_at: '2026-10-09T14:00:00Z' }, now, 'replay'),
      [],
    );
  });

  it('uses the earliest-precedence timestamp, but not a future one', () => {
    assert.equal(
      messageTime(
        { measured_at: null, gateway_received_at: '2026-10-09T14:00:00Z', published_at: '2026-10-09T14:01:00Z' },
        now,
      ).toISOString(),
      '2026-10-09T14:00:00.000Z',
    );
    assert.equal(messageTime({ measured_at: null, gateway_received_at: '2027-01-01T00:00:00Z', published_at: null }, now), now);
  });
});

describe('ThingSet decoding', () => {
  it('decodes bms_state enum including unknown values', () => {
    assert.equal(describeBmsState(2).code, 'DIS');
    assert.equal(describeBmsState(9).code, 'UNKNOWN');
    assert.equal(describeBmsState(undefined), null);
  });

  it('decodes error flags and reports undefined bits', () => {
    const d = decodeErrorFlags(1 + 2 ** 7 + 2 ** 20);
    assert.deepEqual(d.active, ['BMS_ERR_CELL_UNDERVOLTAGE', 'BMS_ERR_DIS_OVERTEMP']);
    assert.deepEqual(d.unknown_bits, [20]);
    assert.deepEqual(decodeErrorFlags(0).active, []);
    assert.equal(decodeErrorFlags(4294967295).active.length, 15);
  });
});
