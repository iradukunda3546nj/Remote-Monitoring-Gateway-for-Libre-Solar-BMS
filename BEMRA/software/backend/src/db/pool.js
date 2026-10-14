import pg from 'pg';
import { getConfig } from '../config/index.js';
import { logger } from '../config/logger.js';

// Return BIGINT (int8) as JS number when it is safely representable. All BIGINT
// columns in this schema (ids, uint32 flags, sequence numbers) stay < 2^53.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => {
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : v;
});

let pool;

/** Shared connection pool for the process (API or worker). */
export function getPool() {
  if (!pool) {
    const { source: _source, ...options } = getConfig().db;
    pool = new pg.Pool(options);
    // Errors on idle clients (e.g. DB restart) must not crash the process.
    pool.on('error', (err) => logger.warn({ err: err.message }, 'idle PostgreSQL client error'));
  }
  return pool;
}

/** Runs fn(client) inside a transaction; rolls back on any error. */
export async function withTransaction(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool() {
  if (pool) {
    const p = pool;
    pool = undefined;
    await p.end();
  }
}

/**
 * True for errors where retrying later can succeed (connection loss, server
 * shutdown, serialization conflicts) as opposed to data/constraint errors.
 */
export function isTransientDbError(err) {
  if (!err) return false;
  if (['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EPIPE'].includes(err.code)) return true;
  if (typeof err.code === 'string' && /^(08|57P|53|40001|40P01)/.test(err.code)) return true;
  return /timeout|Connection terminated/i.test(err.message ?? '');
}
