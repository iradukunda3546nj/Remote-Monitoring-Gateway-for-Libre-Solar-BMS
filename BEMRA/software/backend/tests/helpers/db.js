import crypto from 'node:crypto';
import { getConfig } from '../../src/config/index.js';
import { getPool, withTransaction, closePool } from '../../src/db/pool.js';
import { migrateUp } from '../../src/db/migrator.js';
import { seedRegistry } from '../../scripts/seed-dev.js';
import { resetData } from '../../scripts/reset-test-data.js';
import { createIngestService } from '../../src/ingestion/ingest-service.js';
import { deviceTopic, statusTopic } from '../../src/contracts/topics.js';
import { logger } from '../../src/config/logger.js';
import { sample } from './samples.js';

export const TOPIC_ROOT = 'bemra-test';

/** Registry used only by integration tests; never overlaps with dev fixtures. */
export const TEST_REGISTRY = {
  sites: [
    {
      external_id: 'test-site-a',
      name: 'Test site A',
      country_code: 'RW',
      region: 'Kigali City',
      district: 'Gasabo',
      installation_description: 'integration test',
      address: null,
      latitude: -1.9441,
      longitude: 30.0619,
    },
    {
      external_id: 'test-site-b',
      name: 'Test site B',
      country_code: 'RW',
      region: 'Northern',
      district: 'Musanze',
      installation_description: 'relocation target',
      address: null,
      latitude: null,
      longitude: null,
    },
  ],
  gateways: [{ external_id: 'test-gw-1', model: 'LILYGO T-Call ESP32 SIM800L', notes: 'integration test' }],
  devices: [
    {
      external_id: 'test-bms-1',
      bms_model: 'Libre Solar BMS C1',
      site: 'test-site-a',
      gateway: 'test-gw-1',
      assigned_from: '2026-01-01T00:00:00Z',
    },
  ],
};

const IDS = {
  deviceIds: TEST_REGISTRY.devices.map((d) => d.external_id),
  gatewayIds: TEST_REGISTRY.gateways.map((g) => g.external_id),
  siteIds: TEST_REGISTRY.sites.map((s) => s.external_id),
};

/** Returns a reason string if the database is not usable for tests, else null. */
export async function databaseUnavailableReason() {
  try {
    getConfig();
    await getPool().query('SELECT 1');
    return null;
  } catch (err) {
    return `PostgreSQL not available for integration tests: ${err.message}`;
  }
}

export async function prepareDatabase() {
  const pool = getPool();
  await migrateUp(pool);
  await withTransaction((c) => resetData(c, { ...IDS, registry: true }));
  await withTransaction((c) => seedRegistry(c, TEST_REGISTRY));
  return pool;
}

export async function cleanupDatabase() {
  try {
    await withTransaction((c) => resetData(c, { ...IDS, registry: true }));
    await getPool().query(`DELETE FROM ingest_rejections WHERE topic LIKE $1`, [`${TOPIC_ROOT}/%`]);
  } finally {
    await closePool();
  }
}

export function makeIngestService() {
  return createIngestService({
    pool: getPool(),
    withTransaction,
    options: { topicRoot: TOPIC_ROOT, maxPayloadBytes: 16384, maxRejections: 10000 },
    log: logger,
  });
}

/** Sample message rewritten to the test identities with a unique boot id. */
export function testMessage(file, overrides = {}) {
  const m = sample(file);
  if ('device_id' in m) m.device_id = 'test-bms-1';
  m.gateway_id = 'test-gw-1';
  m.site_id = 'test-site-a';
  return { ...m, ...overrides };
}

export const newBootId = () => `t${crypto.randomBytes(6).toString('hex')}`;

export function topicFor(kind, msg) {
  return kind === 'status'
    ? statusTopic(TOPIC_ROOT, msg.site_id, msg.gateway_id)
    : deviceTopic(TOPIC_ROOT, msg.site_id, msg.device_id, kind);
}

export const toBuffer = (msg) => Buffer.from(typeof msg === 'string' ? msg : JSON.stringify(msg));
