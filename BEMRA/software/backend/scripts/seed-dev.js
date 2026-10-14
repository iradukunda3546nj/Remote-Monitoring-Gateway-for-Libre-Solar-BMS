#!/usr/bin/env node
/**
 * Registers the development site, gateway and device (idempotent).
 * Usage: npm run db:seed [-- path/to/registry.json]
 *
 * Existing rows are updated in place; a current assignment is created only if
 * the device has none. Relocations must be done deliberately (see docs).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closePool, withTransaction } from '../src/db/pool.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const file = process.argv[2] ?? path.join(here, 'fixtures', 'dev-registry.json');

export async function seedRegistry(db, registry) {
  for (const s of registry.sites) {
    await db.query(
      `INSERT INTO sites (external_id, name, country_code, region, district, installation_description, address, latitude, longitude)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (external_id) DO UPDATE SET name = EXCLUDED.name, country_code = EXCLUDED.country_code,
         region = EXCLUDED.region, district = EXCLUDED.district,
         installation_description = EXCLUDED.installation_description, address = EXCLUDED.address,
         latitude = EXCLUDED.latitude, longitude = EXCLUDED.longitude`,
      [s.external_id, s.name, s.country_code, s.region, s.district, s.installation_description, s.address, s.latitude, s.longitude],
    );
  }
  for (const g of registry.gateways) {
    await db.query(
      `INSERT INTO gateways (external_id, model, notes) VALUES ($1, $2, $3)
       ON CONFLICT (external_id) DO UPDATE SET model = EXCLUDED.model, notes = EXCLUDED.notes`,
      [g.external_id, g.model, g.notes ?? null],
    );
  }
  for (const d of registry.devices) {
    const { rows } = await db.query(
      `INSERT INTO devices (external_id, bms_model) VALUES ($1, $2)
       ON CONFLICT (external_id) DO UPDATE SET bms_model = EXCLUDED.bms_model
       RETURNING id`,
      [d.external_id, d.bms_model],
    );
    const deviceId = rows[0].id;
    await db.query(
      `INSERT INTO device_site_assignments (device_id, site_id, valid_from, note)
       SELECT $1, s.id, $3, 'seed' FROM sites s
        WHERE s.external_id = $2
          AND NOT EXISTS (SELECT 1 FROM device_site_assignments WHERE device_id = $1 AND valid_to IS NULL)`,
      [deviceId, d.site, d.assigned_from],
    );
    await db.query(
      `INSERT INTO device_gateway_assignments (device_id, gateway_id, valid_from, note)
       SELECT $1, g.id, $3, 'seed' FROM gateways g
        WHERE g.external_id = $2
          AND NOT EXISTS (SELECT 1 FROM device_gateway_assignments WHERE device_id = $1 AND valid_to IS NULL)`,
      [deviceId, d.gateway, d.assigned_from],
    );
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const registry = JSON.parse(fs.readFileSync(file, 'utf8'));
    await withTransaction((client) => seedRegistry(client, registry));
    console.log(
      `Seeded ${registry.sites.length} site(s), ${registry.gateways.length} gateway(s), ${registry.devices.length} device(s) from ${path.basename(file)}`,
    );
  } catch (err) {
    console.error(`Seed failed: ${err.message}`);
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}
