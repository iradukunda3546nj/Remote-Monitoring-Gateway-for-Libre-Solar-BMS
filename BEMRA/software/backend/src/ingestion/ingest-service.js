/**
 * Turns one MQTT message into database rows, or a recorded rejection.
 *
 * Outcomes:
 *   stored     - new rows committed
 *   duplicate  - identical message already stored (dedup key hit); nothing written
 *   rejected   - permanently invalid; recorded in ingest_rejections
 * Transient database errors are thrown so the caller can retry and withhold
 * the MQTT acknowledgement (at-least-once delivery into PostgreSQL).
 *
 * The gateway is the authoritative normaliser. This service validates and
 * associates; it never rescales, renames or recomputes ThingSet values.
 */
import { parseTopic } from '../contracts/topics.js';
import { checkIdentity, validatePayload } from '../validation/contract-validator.js';
import * as registry from '../repositories/registry-repository.js';
import * as telemetryRepo from '../repositories/telemetry-repository.js';
import * as eventRepo from '../repositories/event-repository.js';
import * as statusRepo from '../repositories/status-repository.js';
import { computeTimeFlags, messageTime } from './time-quality.js';

class Rejection extends Error {
  constructor(reason, detail) {
    super(reason);
    this.reason = reason;
    this.detail = detail;
  }
}

/**
 * @param {object} deps
 * @param {import('pg').Pool} deps.pool
 * @param {(fn: (client) => Promise<any>) => Promise<any>} deps.withTransaction
 * @param {{topicRoot: string, maxPayloadBytes: number, maxRejections: number}} deps.options
 * @param {import('pino').Logger} deps.log
 */
export function createIngestService({ pool, withTransaction, options, log }) {
  async function ingest({ topic, payload, retained = false, now = new Date() }) {
    try {
      const { route, msg } = parseAndValidate(topic, payload);
      const result = await withTransaction((client) => persist(client, route, msg, { retained, now }));
      if (result.outcome === 'duplicate') log.debug({ topic, ...result }, 'duplicate message ignored');
      return result;
    } catch (err) {
      if (!(err instanceof Rejection)) throw err; // transient/unexpected: caller retries
      log.warn({ topic, reason: err.reason, detail: err.detail }, 'message rejected');
      await statusRepo.insertRejection(pool, { topic, reason: err.reason, detail: err.detail, payload }, options.maxRejections);
      return { outcome: 'rejected', reason: err.reason, detail: err.detail };
    }
  }

  function parseAndValidate(topic, payload) {
    if (payload.length > options.maxPayloadBytes) {
      throw new Rejection('payload_too_large', { bytes: payload.length, limit: options.maxPayloadBytes });
    }
    const route = parseTopic(options.topicRoot, topic);
    if (!route) throw new Rejection('unknown_topic');

    let msg;
    try {
      msg = JSON.parse(payload.toString('utf8'));
    } catch (err) {
      throw new Rejection('invalid_json', { error: err.message });
    }
    const validation = validatePayload(route.kind, msg);
    if (!validation.ok) throw new Rejection('schema_violation', { kind: route.kind, errors: validation.errors });

    const mismatches = checkIdentity(route, msg);
    if (mismatches.length) throw new Rejection('identity_mismatch', { mismatches });
    return { route, msg };
  }

  async function persist(client, route, msg, { retained, now }) {
    if (route.kind === 'status') return persistStatus(client, msg, retained);

    const ctx = await resolveContext(client, msg, now);
    switch (route.kind) {
      case 'live':
      case 'replay':
        return persistTelemetry(client, ctx, msg, route.kind, now);
      case 'event': {
        const r = await eventRepo.insertEvent(client, ctx, msg);
        if (r.inserted) await registry.touchDevice(client, ctx.deviceId, msg.schema_version);
        return r.inserted ? { outcome: 'stored', table: 'bms_events', id: r.id } : { outcome: 'duplicate' };
      }
      case 'meta': {
        const r = await statusRepo.insertDeviceMetadata(client, ctx, msg);
        if (r.inserted) {
          await registry.applyDeviceMetadata(client, ctx.deviceId, msg);
          await registry.touchGateway(client, ctx.gatewayId, msg.gateway?.firmware_version ?? null);
        }
        return r.inserted ? { outcome: 'stored', table: 'device_metadata', id: r.id } : { outcome: 'duplicate' };
      }
      default:
        throw new Rejection('unknown_topic');
    }
  }

  async function resolveContext(client, msg, now) {
    const at = messageTime(msg.timestamps, now);
    const row = await registry.resolveDeviceContext(client, {
      deviceExternalId: msg.device_id,
      siteExternalId: msg.site_id,
      gatewayExternalId: msg.gateway_id,
      at,
    });
    if (!row) throw new Rejection('unknown_device', { device_id: msg.device_id });
    if (row.status !== 'active') throw new Rejection('device_not_active', { device_id: msg.device_id, status: row.status });
    if (!row.site_id) throw new Rejection('site_mismatch', { device_id: msg.device_id, site_id: msg.site_id, at });
    if (!row.gateway_id) throw new Rejection('gateway_mismatch', { device_id: msg.device_id, gateway_id: msg.gateway_id, at });
    return { deviceId: row.device_id, siteId: row.site_id, gatewayId: row.gateway_id };
  }

  async function persistTelemetry(client, ctx, msg, delivery, now) {
    const timeFlags = computeTimeFlags(msg.timestamps, now, delivery);
    const r = await telemetryRepo.insertTelemetry(client, ctx, msg, { delivery, timeFlags });
    if (!r.inserted) {
      // Same (device, boot_id, sequence) but different content means the
      // gateway reused a sequence number: reject instead of silently dropping.
      const same = await telemetryRepo.isSameTelemetry(client, ctx.deviceId, msg.boot_id, msg.sequence, msg.thingset);
      if (!same) throw new Rejection('sequence_conflict', { boot_id: msg.boot_id, sequence: msg.sequence });
      return { outcome: 'duplicate' };
    }
    await registry.touchDevice(client, ctx.deviceId, msg.schema_version);
    await registry.touchGateway(client, ctx.gatewayId);
    return { outcome: 'stored', table: 'telemetry', id: r.id, cells: msg.thingset.rCellVoltages_V.length, timeFlags };
  }

  async function persistStatus(client, msg, retained) {
    const ids = await registry.findGatewayAndSite(client, {
      gatewayExternalId: msg.gateway_id,
      siteExternalId: msg.site_id,
    });
    if (!ids.gateway_id) throw new Rejection('unknown_gateway', { gateway_id: msg.gateway_id });
    if (!ids.site_id) throw new Rejection('unknown_site', { site_id: msg.site_id });
    const r = await statusRepo.insertGatewayStatus(client, { gatewayId: ids.gateway_id, siteId: ids.site_id }, msg, { retained });
    if (r.inserted && msg.state === 'online') await registry.touchGateway(client, ids.gateway_id, msg.firmware_version ?? null);
    return r.inserted ? { outcome: 'stored', table: 'gateway_status', id: r.id } : { outcome: 'duplicate' };
  }

  return { ingest };
}

export { Rejection };
