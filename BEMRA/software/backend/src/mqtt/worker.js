#!/usr/bin/env node
/**
 * BEMRA MQTT ingestion worker (independently startable: `npm run start:worker`).
 *
 * Delivery semantics
 *   - Subscribes with QoS 1. Persistent session (clean=false, fixed client id) by
 *     default; MQTT_CLEAN_SESSION=true for public test brokers that drop it.
 *   - Overrides mqtt.js `handleMessage`, whose callback gates the PUBACK: a
 *     message is acknowledged only after it is committed to PostgreSQL (or
 *     recorded as a rejection). Messages are processed strictly one at a time,
 *     so memory use is bounded and the broker applies back-pressure.
 *   - If the database stays unavailable longer than DB_RETRY_BUDGET_MS, the
 *     worker disconnects WITHOUT acknowledging, waits for the database, then
 *     reconnects; the broker redelivers unacknowledged messages.
 *   - Redelivery causes duplicates, which the (device, boot_id, sequence)
 *     unique keys absorb. Net effect: at-least-once delivery + idempotent
 *     storage. This is not exactly-once; see docs/mqtt-contract.md.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import mqtt from 'mqtt';
import { describeConfig, getConfig } from '../config/index.js';
import { logger } from '../config/logger.js';
import { closePool, getPool, isTransientDbError, withTransaction } from '../db/pool.js';
import { createIngestService } from '../ingestion/ingest-service.js';
import { insertRejection } from '../repositories/status-repository.js';
import { subscriptionFilters } from '../contracts/topics.js';
import { publishDiscovery } from '../integrations/ha-discovery.js';

const cfg = getConfig();
const log = logger.child({ component: 'mqtt-worker' });
const pool = getPool();
const ingestService = createIngestService({
  pool,
  withTransaction,
  options: {
    topicRoot: cfg.mqtt.topicRoot,
    maxPayloadBytes: cfg.mqtt.maxPayloadBytes,
    maxRejections: cfg.ingestion.maxRejections,
  },
  log,
});

const stats = { stored: 0, duplicate: 0, rejected: 0, internal_error: 0, db_retries: 0 };
let shuttingDown = false;
let paused = false;
let current = Promise.resolve();

class DatabaseUnavailable extends Error {}

/** Ingest with bounded retry on transient DB errors. */
async function processPacket(packet) {
  const payload = Buffer.isBuffer(packet.payload) ? packet.payload : Buffer.from(packet.payload ?? '');
  const started = Date.now();
  let delay = 250;
  for (;;) {
    try {
      try {
        const result = await ingestService.ingest({ topic: packet.topic, payload, retained: !!packet.retain });
        stats[result.outcome] += 1;
        if (result.outcome === 'stored') log.info({ topic: packet.topic, table: result.table, id: result.id }, 'stored');
        return;
      } catch (err) {
        if (isTransientDbError(err)) throw err;
        // Unexpected, non-transient failure (e.g. a bug or an unanticipated
        // constraint): record it and acknowledge, so one poison message cannot
        // block the queue forever. It stays visible in ingest_rejections.
        stats.internal_error += 1;
        log.error({ topic: packet.topic, err: err.message, code: err.code }, 'internal ingestion error');
        await insertRejection(
          pool,
          { topic: packet.topic, reason: 'internal_error', detail: { error: err.message, code: err.code ?? null }, payload },
          cfg.ingestion.maxRejections,
        );
        return;
      }
    } catch (err) {
      if (!isTransientDbError(err)) throw err;
      if (Date.now() - started > cfg.ingestion.dbRetryBudgetMs) throw new DatabaseUnavailable(err.message);
      stats.db_retries += 1;
      log.warn({ err: err.message, retryInMs: delay }, 'database unavailable, retrying');
      await sleep(delay);
      delay = Math.min(delay * 2, 5000);
    }
  }
}

function connect() {
  const m = cfg.mqtt;
  const client = mqtt.connect({
    protocol: m.protocol,
    host: m.host,
    port: m.port,
    servername: m.host, // SNI + hostname verification
    rejectUnauthorized: true, // never disable certificate verification
    ...(m.ca ? { ca: m.ca } : {}),
    clientId: m.clientId,
    username: m.username,
    password: m.password,
    protocolVersion: 4, // MQTT 3.1.1
    clean: m.cleanSession, // false = persistent session: broker queues QoS 1 while we are away
    keepalive: m.keepalive,
    connectTimeout: 30_000,
    reconnectPeriod: 1000,
  });

  // Acknowledge only after the database work finished (see header comment).
  client.handleMessage = (packet, callback) => {
    current = processPacket(packet).then(
      () => callback(),
      (err) => {
        if (err instanceof DatabaseUnavailable) {
          pauseUntilDatabaseRecovers(client, err.message);
          return; // callback intentionally not called: message stays unacknowledged
        }
        log.error({ err: err.message }, 'unexpected processing failure');
        callback(err);
      },
    );
  };

  let backoff = 1000;
  client.on('connect', (connack) => {
    backoff = 1000;
    client.options.reconnectPeriod = 1000;
    log.info({ sessionPresent: connack.sessionPresent, keepaliveS: m.keepalive }, 'connected to MQTT broker');
    const connectedAt = Date.now();
    // Distinguish "closed by broker/network" from client-side failures.
    client.stream?.once('end', () =>
      log.warn({ afterS: Math.round((Date.now() - connectedAt) / 1000) }, 'connection closed by broker or network (TCP end received)'),
    );
    client.subscribe(Object.fromEntries(subscriptionFilters(m.topicRoot).map((topic) => [topic, { qos: 1 }])), (err, granted) => {
      if (err) return log.error({ err: err.message }, 'subscribe failed');
      const refused = granted.filter((g) => g.qos === 128);
      if (refused.length) log.error({ refused }, 'broker refused subscriptions');
      log.info({ subscriptions: granted.map((g) => `${g.topic} (qos ${g.qos})`) }, 'subscribed');
    });
    announceDiscovery(client);
  });
  client.on('close', () => {
    if (shuttingDown || paused) return;
    backoff = Math.min(backoff * 2, 60_000); // exponential reconnect backoff, capped at 60 s
    client.options.reconnectPeriod = backoff;
    log.warn({ nextAttemptMs: backoff }, 'MQTT connection closed');
  });
  client.on('error', (err) => log.error({ err: err.message, code: err.code }, 'MQTT error'));
  client.on('offline', () => log.warn('MQTT client offline'));
  return client;
}

/** Publishes Home Assistant discovery configs (retained) for all registered devices. */
async function announceDiscovery(client) {
  if (!cfg.mqtt.haDiscovery || !client.connected) return;
  try {
    const r = await publishDiscovery(client, pool, {
      topicRoot: cfg.mqtt.topicRoot,
      prefix: cfg.mqtt.haDiscoveryPrefix,
      expireAfterS: cfg.ingestion.staleAfterSeconds,
    });
    log.info({ ...r, prefix: cfg.mqtt.haDiscoveryPrefix }, 'Home Assistant discovery published');
  } catch (err) {
    log.warn({ err: err.message }, 'Home Assistant discovery failed');
  }
}

function pauseUntilDatabaseRecovers(client, reason) {
  if (paused) return;
  paused = true;
  log.error({ reason }, 'database unavailable beyond retry budget; disconnecting without acknowledging');
  client.end(true, async () => {
    let delay = 2000;
    while (!shuttingDown) {
      try {
        await pool.query('SELECT 1');
        break;
      } catch {
        await sleep(delay);
        delay = Math.min(delay * 2, 30_000);
      }
    }
    if (shuttingDown) return;
    paused = false;
    log.info('database recovered; reconnecting to MQTT broker');
    client.reconnect();
  });
}

async function shutdown(client, signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, 'shutting down: finishing in-flight message');
  const timeout = sleep(10_000).then(() => log.warn('in-flight message did not finish within 10 s'));
  await Promise.race([current.catch(() => {}), timeout]);
  await new Promise((resolve) => client.end(false, {}, resolve));
  await closePool();
  log.info({ stats }, 'worker stopped');
  process.exit(0);
}

log.info({ config: describeConfig() }, 'starting MQTT ingestion worker');
try {
  await pool.query('SELECT 1');
} catch (err) {
  log.fatal({ err: err.message }, 'cannot reach PostgreSQL at startup');
  process.exit(1);
}
const client = connect();
// Re-announce periodically so newly registered devices appear in Home Assistant.
const discoveryTimer = setInterval(() => announceDiscovery(client), 5 * 60_000);
discoveryTimer.unref();
const statsTimer = setInterval(() => log.info({ stats }, 'ingestion stats'), 60_000);
statsTimer.unref();
process.on('SIGINT', () => shutdown(client, 'SIGINT'));
process.on('SIGTERM', () => shutdown(client, 'SIGTERM'));
