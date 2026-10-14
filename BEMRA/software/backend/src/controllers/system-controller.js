import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { listSites } from '../repositories/registry-repository.js';
import { migrationStatus } from '../db/migrator.js';

export function createSystemController({ db, rootDir }) {
  const specPath = path.join(rootDir, 'docs', 'openapi.yaml');
  let specCache;
  const spec = () => (specCache ??= fs.readFileSync(specPath, 'utf8'));

  return {
    /** Liveness: the process is up. No dependencies checked. */
    health: (_req, res) => res.json({ status: 'ok', uptime_s: Math.round(process.uptime()) }),

    /** Readiness: database reachable and all migrations applied. */
    ready: async (_req, res) => {
      try {
        const started = Date.now();
        await db.query('SELECT 1');
        const migrations = await migrationStatus(db);
        const pending = migrations.filter((m) => m.state !== 'applied').map((m) => m.file);
        const ok = pending.length === 0;
        res.status(ok ? 200 : 503).json({
          status: ok ? 'ready' : 'not_ready',
          checks: { database: { ok: true, latency_ms: Date.now() - started }, migrations: { ok, pending } },
        });
      } catch (err) {
        res.status(503).json({ status: 'not_ready', checks: { database: { ok: false, error: err.code ?? 'unreachable' } } });
      }
    },

    sites: async (_req, res) => res.json({ data: await listSites(db) }),
    openapiYaml: (_req, res) => res.type('application/yaml').send(spec()),
    openapiJson: (_req, res) => res.json(YAML.parse(spec())),
  };
}
