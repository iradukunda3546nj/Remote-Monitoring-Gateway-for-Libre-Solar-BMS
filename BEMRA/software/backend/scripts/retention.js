#!/usr/bin/env node
/**
 * Data retention: deletes telemetry (cells cascade), events, gateway status
 * history and rejections older than RETENTION_DAYS, in small batches so the
 * database is never locked for long. Run daily (Task Scheduler / cron).
 *
 * Usage: npm run db:retention [-- --dry-run]
 */
import { getConfig } from '../src/config/index.js';
import { closePool, getPool } from '../src/db/pool.js';

const BATCH = 5000;
const dryRun = process.argv.includes('--dry-run');
const days = getConfig().retentionDays;
const pool = getPool();

// [table, time column, extra condition]. The newest metadata snapshot per
// device and newest status per gateway are always kept, however old.
const targets = [
  ['telemetry', 'observed_at', ''],
  ['bms_events', 'observed_at', ''],
  [
    'gateway_status',
    'ingested_at',
    'AND id NOT IN (SELECT DISTINCT ON (gateway_id) id FROM gateway_status ORDER BY gateway_id, ingested_at DESC, id DESC)',
  ],
  [
    'device_metadata',
    'ingested_at',
    'AND id NOT IN (SELECT DISTINCT ON (device_id) id FROM device_metadata ORDER BY device_id, ingested_at DESC, id DESC)',
  ],
  ['ingest_rejections', 'received_at', ''],
];

try {
  const cutoff = new Date(Date.now() - days * 86_400_000);
  console.log(`Retention: ${days} days, cutoff ${cutoff.toISOString()}${dryRun ? ' (dry run)' : ''}`);
  for (const [table, column, keep] of targets) {
    // table/column come from the constant list above
    if (dryRun) {
      const { rows } = await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${column} < $1 ${keep}`, [cutoff]);
      console.log(`${table}: ${rows[0].n} row(s) would be deleted`);
      continue;
    }
    let total = 0;
    for (;;) {
      const { rowCount } = await pool.query(
        `DELETE FROM ${table} WHERE id IN (SELECT id FROM ${table} WHERE ${column} < $1 ${keep} LIMIT ${BATCH})`,
        [cutoff],
      );
      total += rowCount;
      if (rowCount < BATCH) break;
    }
    console.log(`${table}: deleted ${total} row(s)`);
  }
} catch (err) {
  console.error(`Retention failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  await closePool();
}
