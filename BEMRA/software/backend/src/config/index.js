/**
 * Central configuration. Reads environment variables once, validates them and
 * exposes an immutable config object. No other module reads process.env.
 *
 * Database precedence: DATABASE_URL (if set) > individual DB_* variables.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// Load .env for local development. Real deployments inject variables directly.
const envFile = path.join(ROOT_DIR, '.env');
if (fs.existsSync(envFile) && !process.env.BEMRA_SKIP_ENV_FILE) {
  process.loadEnvFile(envFile);
}

class ConfigError extends Error {}

function str(name, fallback) {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function int(name, fallback, { min = -Infinity, max = Infinity } = {}) {
  const raw = str(name);
  if (raw === undefined) return fallback;
  const v = Number(raw);
  if (!Number.isInteger(v) || v < min || v > max) {
    throw new ConfigError(`${name} must be an integer in [${min}, ${max}], got "${raw}"`);
  }
  return v;
}

function oneOf(name, fallback, allowed) {
  const v = str(name, fallback);
  if (!allowed.includes(v)) {
    throw new ConfigError(`${name} must be one of ${allowed.join(', ')}, got "${v}"`);
  }
  return v;
}

function list(name) {
  return (str(name, '') || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function readFileIfSet(name) {
  const file = str(name);
  if (!file) return undefined;
  try {
    return fs.readFileSync(path.resolve(ROOT_DIR, file), 'utf8');
  } catch (err) {
    throw new ConfigError(`${name} points to an unreadable file: ${err.message}`);
  }
}

/** Builds the pg.Pool TLS option from DB_SSL / DB_SSL_CA_FILE. */
function buildDbSsl() {
  const mode = oneOf('DB_SSL', 'false', ['false', 'true', 'no-verify']);
  if (mode === 'false') return false;
  if (mode === 'no-verify') return { rejectUnauthorized: false };
  const ca = readFileIfSet('DB_SSL_CA_FILE');
  return ca ? { rejectUnauthorized: true, ca } : { rejectUnauthorized: true };
}

function buildDb() {
  const common = {
    ssl: buildDbSsl(),
    max: int('DB_POOL_MAX', 10, { min: 1, max: 100 }),
    connectionTimeoutMillis: int('DB_CONNECT_TIMEOUT_MS', 5000, { min: 100 }),
    idleTimeoutMillis: int('DB_IDLE_TIMEOUT_MS', 30000, { min: 1000 }),
    statement_timeout: int('DB_STATEMENT_TIMEOUT_MS', 15000, { min: 100 }),
    application_name: str('DB_APPLICATION_NAME', 'bemra-backend'),
  };
  const url = str('DATABASE_URL');
  if (url) {
    // When a URL is used, TLS still comes from DB_SSL so that certificate
    // verification can never be silently disabled by a URL parameter.
    const u = new URL(url);
    u.searchParams.delete('sslmode');
    return { source: 'DATABASE_URL', connectionString: u.toString(), ...common };
  }
  const password = str('DB_PASSWORD');
  if (password === undefined) {
    throw new ConfigError('DB_PASSWORD is empty. Enter it in software/backend/.env (never commit it) or set DATABASE_URL.');
  }
  return {
    source: 'DB_*',
    host: str('DB_HOST', 'localhost'),
    port: int('DB_PORT', 5432, { min: 1, max: 65535 }),
    database: str('DB_NAME', 'bemra_db'),
    user: str('DB_USER', 'postgres'),
    password,
    ...common,
  };
}

function buildMqtt() {
  const root = str('MQTT_TOPIC_ROOT', 'bemra');
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(root)) {
    throw new ConfigError('MQTT_TOPIC_ROOT may only contain letters, digits, "-" and "_"');
  }
  return {
    protocol: oneOf('MQTT_PROTOCOL', 'mqtts', ['mqtt', 'mqtts', 'ws', 'wss']),
    host: str('MQTT_HOST', 'localhost'),
    port: int('MQTT_PORT', 8883, { min: 1, max: 65535 }),
    clientId: str('MQTT_CLIENT_ID', 'bemra-backend'),
    // test.mosquitto.org (2026-10-10): a persistent session got SUBACK but no
    // messages, while a clean session with the same filters received them.
    cleanSession: str('MQTT_CLEAN_SESSION', 'false') === 'true',
    username: str('MQTT_USERNAME'),
    password: str('MQTT_PASSWORD'),
    ca: readFileIfSet('MQTT_CA_FILE'),
    topicRoot: root,
    // Must stay well below the shortest idle-connection timeout on the network
    // path. Measured 2026-10-09: idle TLS connections to test.mosquitto.org
    // are closed by the peer after ~60 s, so 60 s loses the race; 30 s does not.
    keepalive: int('MQTT_KEEPALIVE_S', 30, { min: 5, max: 600 }),
    maxPayloadBytes: int('MQTT_MAX_PAYLOAD_BYTES', 16384, { min: 1024, max: 262144 }),
    // Home Assistant MQTT discovery (published by the worker). On a shared broker
    // use a private prefix; the global default "homeassistant" is visible to everyone.
    haDiscovery: str('HA_DISCOVERY_ENABLED', 'true') === 'true',
    haDiscoveryPrefix: str('HA_DISCOVERY_PREFIX', `${root}/homeassistant`),
  };
}

function build() {
  const env = oneOf('NODE_ENV', 'development', ['development', 'test', 'production']);
  const apiKeys = list('API_KEYS');
  if (env === 'production' && apiKeys.length === 0) {
    throw new ConfigError('API_KEYS must be set in production');
  }
  let db;
  return Object.freeze({
    env,
    rootDir: ROOT_DIR,
    logLevel: getLogLevel(),
    http: Object.freeze({
      port: int('PORT', 3000, { min: 0, max: 65535 }),
      corsOrigins: list('CORS_ORIGINS'),
      apiKeys,
    }),
    // Built on first access, so MQTT-only tools (e.g. publish-sample) run
    // without database credentials. Validation errors surface at that point.
    get db() {
      return (db ??= Object.freeze(buildDb()));
    },
    mqtt: Object.freeze(buildMqtt()),
    ingestion: Object.freeze({
      // Telemetry older than this is "stale" in API freshness reporting.
      staleAfterSeconds: int('STALE_AFTER_S', 300, { min: 10 }),
      // Upper bound on stored rejection rows (oldest pruned first).
      maxRejections: int('MAX_REJECTIONS', 10000, { min: 100 }),
      // Total time a single message may wait for the DB before the worker
      // disconnects (without acknowledging) and waits for the DB to recover.
      dbRetryBudgetMs: int('DB_RETRY_BUDGET_MS', 20000, { min: 1000 }),
    }),
    retentionDays: int('RETENTION_DAYS', 365, { min: 1 }),
  });
}

/** Log level only. Needs no other configuration, so logging works even when config is incomplete. */
export function getLogLevel() {
  const env = str('NODE_ENV', 'development');
  return str('LOG_LEVEL', env === 'test' ? 'silent' : 'info');
}

let cached;
/** Returns the validated configuration (built lazily so tests can set env first). */
export function getConfig() {
  if (!cached) cached = build();
  return cached;
}

/** Redacted view of the config, safe for logs. */
export function describeConfig(cfg = getConfig()) {
  const { db, mqtt } = cfg;
  return {
    env: cfg.env,
    db: db.connectionString
      ? { source: db.source, url: db.connectionString.replace(/:[^:@/]+@/, ':***@'), ssl: !!db.ssl }
      : { source: db.source, host: db.host, port: db.port, database: db.database, user: db.user, ssl: !!db.ssl },
    mqtt: {
      url: `${mqtt.protocol}://${mqtt.host}:${mqtt.port}`,
      clientId: mqtt.clientId,
      cleanSession: mqtt.cleanSession,
      topicRoot: mqtt.topicRoot,
      auth: !!mqtt.username,
    },
  };
}

/** Builds a fresh (uncached) config from the current environment. For tests. */
export const loadConfig = build;

export { ConfigError };
