import '../helpers/env.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, ConfigError } from '../../src/config/index.js';
import { parseRange, parseFields, parseCursor, encodeCursor, parseInterval, parseLimit } from '../../src/validation/query.js';

describe('configuration', () => {
  let saved;
  beforeEach(() => {
    saved = { ...process.env };
  });
  afterEach(() => {
    process.env = saved;
  });

  it('DATABASE_URL takes precedence over DB_* and strips sslmode', () => {
    process.env.DATABASE_URL = 'postgres://app:secret@db.example.com:6543/bemra?sslmode=disable';
    process.env.DB_HOST = 'localhost';
    process.env.DB_SSL = 'true';
    const cfg = loadConfig();
    assert.equal(cfg.db.source, 'DATABASE_URL');
    assert.ok(!cfg.db.connectionString.includes('sslmode'));
    assert.deepEqual(cfg.db.ssl, { rejectUnauthorized: true });
    assert.equal(cfg.db.host, undefined);
  });

  it('uses DB_* when DATABASE_URL is absent and requires a password', () => {
    delete process.env.DATABASE_URL;
    process.env.DB_PASSWORD = '';
    assert.throws(() => loadConfig().db, ConfigError);
    process.env.DB_PASSWORD = 'x';
    process.env.DB_SSL = 'false';
    const cfg = loadConfig();
    assert.equal(cfg.db.source, 'DB_*');
    assert.equal(cfg.db.ssl, false);
  });

  it('requires API keys in production and validates MQTT topic root', () => {
    process.env.DB_PASSWORD = 'x';
    process.env.NODE_ENV = 'production';
    process.env.API_KEYS = '';
    assert.throws(() => loadConfig(), /API_KEYS/);
    process.env.NODE_ENV = 'test';
    process.env.MQTT_TOPIC_ROOT = 'bad/root';
    assert.throws(() => loadConfig(), /MQTT_TOPIC_ROOT/);
  });
});

describe('query validation', () => {
  it('parses half-open time windows and rejects invalid ones', () => {
    const r = parseRange({ from: '2026-10-09T00:00:00Z', to: '2026-10-09T12:00:00+02:00' });
    assert.equal(r.to.toISOString(), '2026-10-09T10:00:00.000Z');
    assert.throws(() => parseRange({ from: '2026-10-09' }), /ISO 8601/);
    assert.throws(() => parseRange({ from: '2026-10-10T00:00:00Z', to: '2026-10-09T00:00:00Z' }), /earlier/);
  });

  it('allow-lists fields', () => {
    assert.deepEqual(parseFields('rSOC_pct,rPackVoltage_V', { aggregated: true }), ['rSOC_pct', 'rPackVoltage_V']);
    assert.throws(() => parseFields('rErrorFlags', { aggregated: true }));
    assert.throws(() => parseFields('pack_voltage_v; DROP TABLE x', { aggregated: false }));
  });

  it('round-trips cursors and rejects tampered ones', () => {
    const c = encodeCursor({ observed_at: '2026-10-09T14:30:00Z', id: 42 });
    assert.deepEqual(parseCursor(c), { observedAt: new Date('2026-10-09T14:30:00Z'), id: 42 });
    assert.throws(() => parseCursor('not-a-cursor'));
  });

  it('validates interval and limit', () => {
    assert.equal(parseInterval('15m').seconds, 900);
    assert.throws(() => parseInterval('2m'));
    assert.throws(() => parseLimit('0'));
    assert.equal(parseLimit(undefined), 500);
  });
});
