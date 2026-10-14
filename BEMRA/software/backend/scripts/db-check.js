#!/usr/bin/env node
/**
 * Connectivity and schema check: connects with the configured credentials,
 * prints the server version and lists BEMRA tables with their row counts.
 * Usage: npm run db:check
 */
import { describeConfig } from '../src/config/index.js';
import { closePool, getPool } from '../src/db/pool.js';

const EXPECTED = [
  'schema_migrations',
  'sites',
  'gateways',
  'devices',
  'device_site_assignments',
  'device_gateway_assignments',
  'telemetry',
  'cell_measurements',
  'bms_events',
  'gateway_status',
  'device_metadata',
  'ingest_rejections',
];

try {
  console.log('Connecting to', JSON.stringify(describeConfig().db));
  const pool = getPool();
  const { rows: info } = await pool.query(
    `SELECT current_database() AS database, current_user AS "user",
            current_setting('server_version') AS version, current_setting('TimeZone') AS timezone,
            (SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()) AS ssl`,
  );
  console.log('Connected:', info[0]);
  const major = Number(info[0].version.split('.')[0]);
  if (major < 15) console.warn('WARNING: PostgreSQL >= 15 is required (UNIQUE NULLS NOT DISTINCT).');

  const { rows } = await pool.query(
    `SELECT c.relname AS table, c.reltuples::bigint AS approx_rows
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname = ANY($1)
      ORDER BY c.relname`,
    [EXPECTED],
  );
  const present = new Set(rows.map((r) => r.table));
  const counts = [];
  for (const t of EXPECTED) {
    if (!present.has(t)) {
      counts.push({ table: t, present: false, rows: null });
      continue;
    }
    // Table names come from the fixed EXPECTED list above, never from input.
    const { rows: c } = await pool.query(`SELECT count(*)::int AS n FROM "${t}"`);
    counts.push({ table: t, present: true, rows: c[0].n });
  }
  console.table(counts);
  const missing = counts.filter((c) => !c.present).map((c) => c.table);
  if (missing.length) {
    console.log(`Missing tables: ${missing.join(', ')}. Run: npm run db:migrate`);
    process.exitCode = 2;
  } else {
    console.log('All BEMRA tables present.');
  }
} catch (err) {
  console.error(`Database check failed: ${err.message}`);
  if (err.code === '28P01') console.error('Authentication failed: check DB_USER / DB_PASSWORD in .env');
  process.exitCode = 1;
} finally {
  await closePool();
}
