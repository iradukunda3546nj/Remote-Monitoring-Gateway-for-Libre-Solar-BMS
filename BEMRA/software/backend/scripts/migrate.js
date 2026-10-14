#!/usr/bin/env node
/**
 * Usage:
 *   npm run db:migrate   -> apply pending migrations
 *   npm run db:status    -> show applied / pending migrations
 */
import { describeConfig } from '../src/config/index.js';
import { closePool, getPool } from '../src/db/pool.js';
import { migrateUp, migrationStatus } from '../src/db/migrator.js';

const command = process.argv[2] ?? 'status';

try {
  console.log('Database:', JSON.stringify(describeConfig().db));
  const pool = getPool();
  if (command === 'up') {
    const applied = await migrateUp(pool, (msg) => console.log(`  ${msg}`));
    console.log(applied.length ? `Applied ${applied.length} migration(s).` : 'Database is up to date.');
  } else if (command !== 'status') {
    throw new Error(`Unknown command "${command}" (use "up" or "status")`);
  }
  const status = await migrationStatus(pool);
  console.table(status.map(({ version, name, state, applied_at }) => ({ version, name, state, applied_at })));
  if (status.some((s) => s.state === 'checksum_mismatch')) process.exitCode = 1;
} catch (err) {
  console.error(`Migration error: ${err.message}`);
  process.exitCode = 1;
} finally {
  await closePool();
}
