/**
 * Read-side business logic for the REST API. Presents stored data with units,
 * freshness and decoded enums/bitmaps. Raw ThingSet values are always returned
 * unchanged next to any decoded representation.
 */
import { MEAS_BY_NAME, MEAS_OBJECTS, decodeErrorFlags, describeBmsState } from '../contracts/thingset.js';
import { notFound, badRequest } from '../middleware/errors.js';
import * as registry from '../repositories/registry-repository.js';
import * as telemetryRepo from '../repositories/telemetry-repository.js';
import * as eventRepo from '../repositories/event-repository.js';
import * as statusRepo from '../repositories/status-repository.js';
import {
  FIELD_COLUMNS,
  encodeCursor,
  parseCursor,
  parseFields,
  parseInterval,
  parseLimit,
  parseOrder,
  parseRange,
} from '../validation/query.js';

const MAX_BUCKETS = 5000;

export function createDeviceService({ db, staleAfterSeconds }) {
  async function requireDevice(deviceId) {
    const device = await registry.getDevice(db, deviceId);
    if (!device) throw notFound(`Device ${deviceId} is not registered`);
    return device;
  }

  function freshness(row, now = new Date()) {
    if (!row) return { observed_at: null, observed_at_source: null, age_s: null, stale: true, stale_after_s: staleAfterSeconds };
    const age = Math.max(0, Math.round((now - new Date(row.observed_at)) / 1000));
    return {
      observed_at: row.observed_at,
      observed_at_source: row.observed_at_source,
      age_s: age,
      stale: age > staleAfterSeconds,
      stale_after_s: staleAfterSeconds,
    };
  }

  const timestampsOf = (row) => ({
    measured_at: row.measured_at,
    gateway_received_at: row.gateway_received_at,
    published_at: row.published_at,
    ingested_at: row.ingested_at,
    observed_at: row.observed_at,
    observed_at_source: row.observed_at_source,
    time_flags: row.time_flags,
  });

  const sourceOf = (row) => ({
    gateway_id: row.gateway_id,
    site_id: row.site_id,
    boot_id: row.boot_id,
    sequence: row.sequence,
    delivery: row.delivery,
    schema_version: row.schema_version,
  });

  function publicDevice(d) {
    const { id: _internal, ...rest } = d;
    return rest;
  }

  return {
    async listDevices(query) {
      return (await registry.listDevices(db, { siteExternalId: query.site })).map(publicDevice);
    },

    async getDevice(deviceId) {
      const d = await requireDevice(deviceId);
      const [site, assignments, metadata] = await Promise.all([
        d.site_id ? registry.getDeviceSite(db, d.site_id) : null,
        registry.getAssignmentHistory(db, d.id),
        statusRepo.getLatestMetadata(db, d.id),
      ]);
      return { ...publicDevice(d), site, assignment_history: assignments, latest_metadata: metadata };
    },

    async getStatus(deviceId) {
      const d = await requireDevice(deviceId);
      const [latest, gateway] = await Promise.all([
        telemetryRepo.getLatest(db, d.id),
        d.gateway_id ? statusRepo.getLatestGatewayStatus(db, d.gateway_id) : null,
      ]);
      const f = freshness(latest);
      const ts = latest?.thingset ?? {};
      return {
        device_id: d.device_id,
        site_id: d.site_id,
        gateway_id: d.gateway_id,
        device_status: d.status,
        data_freshness: f,
        gateway: gateway ?? null,
        online: gateway ? gateway.state === 'online' && !f.stale : !f.stale,
        bms_state: describeBmsState(ts.rBmsState),
        error_flags: decodeErrorFlags(ts.rErrorFlags),
      };
    },

    async getLatest(deviceId) {
      const d = await requireDevice(deviceId);
      const row = await telemetryRepo.getLatest(db, d.id);
      if (!row) throw notFound(`No telemetry stored for device ${deviceId}`);
      const measurements = {};
      for (const [name, value] of Object.entries(row.thingset)) {
        const meta = MEAS_BY_NAME[name];
        measurements[name] = meta
          ? { value, unit: meta.unit, thingset_id: `0x${meta.id.toString(16)}` }
          : { value, unit: null, thingset_id: null, note: 'Not in verified catalogue; preserved as received' };
      }
      return {
        device_id: d.device_id,
        measurements,
        not_reported: MEAS_OBJECTS.map((o) => o.name).filter((n) => !(n in row.thingset)),
        bms_state: describeBmsState(row.thingset.rBmsState),
        error_flags: decodeErrorFlags(row.thingset.rErrorFlags),
        timestamps: timestampsOf(row),
        source: sourceOf(row),
        data_freshness: freshness(row),
      };
    },

    async getThingset(deviceId) {
      const d = await requireDevice(deviceId);
      const row = await telemetryRepo.getLatest(db, d.id);
      if (!row) throw notFound(`No telemetry stored for device ${deviceId}`);
      return { device_id: d.device_id, thingset: row.thingset, timestamps: timestampsOf(row), source: sourceOf(row) };
    },

    async getCells(deviceId) {
      const d = await requireDevice(deviceId);
      const [cells, latest] = await Promise.all([telemetryRepo.getLatestCells(db, d.id), telemetryRepo.getLatest(db, d.id)]);
      if (!latest) throw notFound(`No telemetry stored for device ${deviceId}`);
      const ts = latest.thingset;
      return {
        device_id: d.device_id,
        observed_at: latest.observed_at,
        cell_count: cells.length,
        unit: 'V',
        cells: cells.map((c) => ({ index: c.cell_index, voltage_v: c.voltage_v })),
        // Statistics exactly as computed by the BMS firmware (not recomputed here)
        bms_statistics: {
          rCellMinVoltage_V: ts.rCellMinVoltage_V ?? null,
          rCellMaxVoltage_V: ts.rCellMaxVoltage_V ?? null,
          rCellAvgVoltage_V: ts.rCellAvgVoltage_V ?? null,
        },
        rBalancingStatus: ts.rBalancingStatus ?? null,
        rCellTemps_degC: ts.rCellTemps_degC ?? null,
        data_freshness: freshness(latest),
      };
    },

    async getTelemetry(deviceId, query) {
      const d = await requireDevice(deviceId);
      const range = parseRange(query);
      const interval = parseInterval(query.interval);
      const order = parseOrder(query.order);
      const fields = parseFields(query.fields, { aggregated: interval.seconds > 0 });
      const columns = fields.map((f) => FIELD_COLUMNS[f]);
      const meta = { device_id: d.device_id, from: range.from, to: range.to, interval: interval.name, order, fields };

      if (interval.seconds > 0) {
        const buckets = Math.ceil((range.to - range.from) / 1000 / interval.seconds);
        if (buckets > MAX_BUCKETS)
          throw badRequest(`Too many buckets (${buckets}); use a larger interval or shorter range`, { max: MAX_BUCKETS });
        const rows = await telemetryRepo.listAggregated(db, d.id, { ...range, bucketSeconds: interval.seconds, order, columns });
        return {
          data: rows.map((r) => ({
            bucket_start: r.bucket,
            sample_count: r.sample_count,
            values: Object.fromEntries(
              fields.map((f) => {
                const c = FIELD_COLUMNS[f];
                return [f, { min: r[`${c}_min`], avg: r[`${c}_avg`], max: r[`${c}_max`] }];
              }),
            ),
          })),
          meta: { ...meta, bucket_seconds: interval.seconds, units: unitsOf(fields), empty_buckets: 'omitted' },
        };
      }

      const limit = parseLimit(query.limit);
      const cursor = parseCursor(query.cursor);
      const includeThingset = query.include === 'thingset';
      const rows = await telemetryRepo.listRaw(db, d.id, {
        ...range,
        order,
        limit,
        cursor,
        columns: includeThingset ? [...columns, 'thingset'] : columns,
      });
      const page = rows.slice(0, limit);
      return {
        data: page.map((r) => ({
          id: r.id,
          timestamps: timestampsOf(r),
          source: sourceOf(r),
          values: Object.fromEntries(fields.map((f) => [f, r[FIELD_COLUMNS[f]]])),
          ...(includeThingset ? { thingset: r.thingset } : {}),
        })),
        meta: {
          ...meta,
          limit,
          units: unitsOf(fields),
          next_cursor: rows.length > limit ? encodeCursor(page.at(-1)) : null,
        },
      };
    },

    async getEvents(deviceId, query) {
      const d = await requireDevice(deviceId);
      const range = parseRange(query, { defaultHours: 24 * 7 });
      const order = parseOrder(query.order);
      const limit = parseLimit(query.limit, { fallback: 200, max: 1000 });
      const cursor = parseCursor(query.cursor);
      const severity = query.severity;
      if (severity !== undefined && !['critical', 'warning', 'info'].includes(severity)) {
        throw badRequest('severity must be critical, warning or info');
      }
      const rows = await eventRepo.listEvents(db, d.id, { ...range, order, limit, cursor, severity });
      const page = rows.slice(0, limit);
      return {
        data: page,
        meta: {
          device_id: d.device_id,
          ...range,
          order,
          limit,
          next_cursor: rows.length > limit ? encodeCursor(page.at(-1)) : null,
        },
      };
    },

    /** Flat object for Home Assistant RESTful sensors (value_json.<key>). */
    async getHomeAssistantState(deviceId) {
      const status = await this.getStatus(deviceId);
      const d = await requireDevice(deviceId);
      const latest = await telemetryRepo.getLatest(db, d.id);
      const ts = latest?.thingset ?? {};
      const flat = {};
      for (const o of MEAS_OBJECTS) if (!o.type.endsWith('[]')) flat[o.name] = ts[o.name] ?? null;
      (ts.rCellVoltages_V ?? []).forEach((v, i) => (flat[`cell_${i + 1}_V`] = v));
      return {
        device_id: d.device_id,
        ...flat,
        bms_state_code: status.bms_state?.code ?? null,
        error_active: status.error_flags?.active ?? [],
        online: status.online,
        stale: status.data_freshness.stale,
        observed_at: status.data_freshness.observed_at,
      };
    },

    /**
     * Low-frequency battery summary intended for a MicroPowerManager adapter.
     * PROVISIONAL: shaped for MPM's documented need (SOC, imbalance, max
     * temperature, faults) but not yet verified against MPM's integration API.
     */
    async getMpmSummary(deviceId, query) {
      const d = await requireDevice(deviceId);
      const map = { '15m': 900, hourly: 3600, daily: 86400 };
      const name = query.interval ?? 'hourly';
      if (!map[name]) throw badRequest('interval must be 15m, hourly or daily');
      const defaultHours = { '15m': 24, hourly: 24 * 7, daily: 24 * 90 }[name];
      const range = parseRange(query, { defaultHours });
      const buckets = Math.ceil((range.to - range.from) / 1000 / map[name]);
      if (buckets > MAX_BUCKETS) throw badRequest(`Too many buckets (${buckets})`, { max: MAX_BUCKETS });
      const [rows, events] = await Promise.all([
        telemetryRepo.summarize(db, d.id, { ...range, bucketSeconds: map[name] }),
        eventRepo.countEventsBySeverity(db, d.id, range),
      ]);
      return {
        data: rows.map((r) => ({ ...r, error_flags_any: decodeErrorFlags(r.error_flags_any) })),
        meta: {
          device_id: d.device_id,
          site_id: d.site_id,
          interval: name,
          bucket_seconds: map[name],
          ...range,
          event_counts: events,
          empty_buckets: 'omitted',
          compatibility: 'provisional; not yet validated against the official MicroPowerManager API',
        },
      };
    },
  };
}

function unitsOf(fields) {
  return Object.fromEntries(fields.map((f) => [f, MEAS_BY_NAME[f]?.unit ?? null]));
}
