#!/usr/bin/env node
/**
 * Deletes ingested data (telemetry, cells, events, status, metadata) belonging
 * ONLY to the listed development devices/gateways. Nothing else is touched;
 * no tables are dropped or truncated.
 *
 * Usage:
 *   npm run db:reset-test-data -- --yes                 data of devices in dev-registry.json
 *   npm run db:reset-test-data -- --yes --registry      ...and the registry rows themselves
 *   npm run db:reset-test-data -- --yes --rejections    ...and all ingest_rejections rows
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closePool, withTransaction } from '../src/db/pool.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = new Set(process.argv.slice(2));

export async function resetData(db, { deviceIds, gatewayIds, siteIds = [], registry = false }) {
  const counts = {};
  const del = async (label, sql, params) => {
    counts[label] = (await db.query(sql, params)).rowCount;
  };
  const devSub = 'SELECT id FROM devices WHERE external_id = ANY($1)';
  const gwSub = 'SELECT id FROM gateways WHERE external_id = ANY($1)';
  // cell_measurements cascade from telemetry
  await del('telemetry', `DELETE FROM telemetry WHERE device_id IN (${devSub})`, [deviceIds]);
  await del('bms_events', `DELETE FROM bms_events WHERE device_id IN (${devSub})`, [deviceIds]);
  await del('device_metadata', `DELETE FROM device_metadata WHERE device_id IN (${devSub})`, [deviceIds]);
  await del('gateway_status', `DELETE FROM gateway_status WHERE gateway_id IN (${gwSub})`, [gatewayIds]);
  if (registry) {
    await del('device_site_assignments', `DELETE FROM device_site_assignments WHERE device_id IN (${devSub})`, [deviceIds]);
    await del('device_gateway_assignments', `DELETE FROM device_gateway_assignments WHERE device_id IN (${devSub})`, [deviceIds]);
    await del('devices', 'DELETE FROM devices WHERE external_id = ANY($1)', [deviceIds]);
    await del('gateways', 'DELETE FROM gateways WHERE external_id = ANY($1)', [gatewayIds]);
    await del(
      'sites',
      'DELETE FROM sites s WHERE s.external_id = ANY($1) AND NOT EXISTS (SELECT 1 FROM device_site_assignments a WHERE a.site_id = s.id)',
      [siteIds],
    );
  }
  return counts;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!args.has('--yes')) {
    console.error('Refusing to delete without --yes. Example: npm run db:reset-test-data -- --yes');
    process.exit(1);
  }
  try {
    const reg = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'dev-registry.json'), 'utf8'));
    const counts = await withTransaction(async (client) => {
      const c = await resetData(client, {
        deviceIds: reg.devices.map((d) => d.external_id),
        gatewayIds: reg.gateways.map((g) => g.external_id),
        siteIds: reg.sites.map((s) => s.external_id),
        registry: args.has('--registry'),
      });
      if (args.has('--rejections')) c.ingest_rejections = (await client.query('DELETE FROM ingest_rejections')).rowCount;
      return c;
    });
    console.table(counts);
  } catch (err) {
    console.error(`Reset failed: ${err.message}`);
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}
