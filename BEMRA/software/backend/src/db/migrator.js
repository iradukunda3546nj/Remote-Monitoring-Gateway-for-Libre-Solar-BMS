/**
 * Minimal versioned SQL migration runner.
 *
 * - Migrations are files named NNNN_description.sql in /migrations.
 * - Each pending migration runs in its own transaction and is recorded in
 *   schema_migrations together with a SHA-256 checksum.
 * - A session advisory lock prevents two processes migrating concurrently.
 * - Editing an already-applied migration is detected (checksum mismatch) and
 *   aborts the run instead of silently diverging between environments.
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getConfig } from '../config/index.js';

const LOCK_KEY = 728_461_001; // arbitrary constant, unique to BEMRA migrations
const FILE_RE = /^(\d{4})_([a-z0-9_]+)\.sql$/;

export async function loadMigrations(dir = path.join(getConfig().rootDir, 'migrations')) {
  const files = (await fs.readdir(dir)).filter((f) => FILE_RE.test(f)).sort();
  return Promise.all(
    files.map(async (file) => {
      const [, version, name] = file.match(FILE_RE);
      const sql = await fs.readFile(path.join(dir, file), 'utf8');
      const checksum = crypto.createHash('sha256').update(sql).digest('hex');
      return { version, name, file, sql, checksum };
    }),
  );
}

async function ensureTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      checksum   TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
}

/** Returns [{version, name, file, state: 'applied'|'pending'|'checksum_mismatch', applied_at}]. */
export async function migrationStatus(pool) {
  const client = await pool.connect();
  try {
    await ensureTable(client);
    const { rows } = await client.query('SELECT version, checksum, applied_at FROM schema_migrations');
    const applied = new Map(rows.map((r) => [r.version, r]));
    const migrations = await loadMigrations();
    return migrations.map((m) => {
      const a = applied.get(m.version);
      const state = !a ? 'pending' : a.checksum === m.checksum ? 'applied' : 'checksum_mismatch';
      return { version: m.version, name: m.name, file: m.file, state, applied_at: a?.applied_at ?? null };
    });
  } finally {
    client.release();
  }
}

/** Applies all pending migrations. Returns the list of versions applied. */
export async function migrateUp(pool, log = () => {}) {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await ensureTable(client);
    const { rows } = await client.query('SELECT version, checksum FROM schema_migrations');
    const applied = new Map(rows.map((r) => [r.version, r.checksum]));
    const done = [];
    for (const m of await loadMigrations()) {
      if (applied.has(m.version)) {
        if (applied.get(m.version) !== m.checksum) {
          throw new Error(`Migration ${m.file} was modified after being applied (checksum mismatch). Create a new migration instead.`);
        }
        continue;
      }
      log(`applying ${m.file}`);
      try {
        await client.query('BEGIN');
        await client.query(m.sql);
        await client.query('INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)', [m.version, m.name, m.checksum]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        err.message = `Migration ${m.file} failed and was rolled back: ${err.message}`;
        throw err;
      }
      done.push(m.version);
    }
    return done;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
    client.release();
  }
}
