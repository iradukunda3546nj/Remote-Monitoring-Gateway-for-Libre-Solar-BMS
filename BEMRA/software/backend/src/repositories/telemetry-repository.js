import { MEAS_OBJECTS } from '../contracts/thingset.js';

/** ThingSet name -> typed column, taken from the verified catalogue. */
const SCALAR_COLUMNS = MEAS_OBJECTS.filter((o) => o.column && !o.type.endsWith('[]')).map((o) => [o.name, o.column]);

/**
 * Inserts one telemetry snapshot and its per-cell rows. Values are copied
 * unchanged; absent ThingSet objects become NULL columns but remain absent
 * (not null) in the preserved JSONB.
 *
 * @returns {{inserted: true, id: number, observedAt: Date} | {inserted: false}}
 */
export async function insertTelemetry(db, ctx, msg, { delivery, timeFlags }) {
  const ts = msg.thingset;
  const columns = [
    'device_id',
    'gateway_id',
    'site_id',
    'delivery',
    'schema_version',
    'boot_id',
    'sequence',
    'measured_at',
    'gateway_received_at',
    'published_at',
    'time_flags',
    'cell_temps_degc',
    'cell_count',
    'thingset',
  ];
  const values = [
    ctx.deviceId,
    ctx.gatewayId,
    ctx.siteId,
    delivery,
    msg.schema_version,
    msg.boot_id,
    msg.sequence,
    msg.timestamps.measured_at,
    msg.timestamps.gateway_received_at,
    msg.timestamps.published_at,
    timeFlags,
    ts.rCellTemps_degC ?? null,
    ts.rCellVoltages_V.length,
    JSON.stringify(ts),
  ];
  for (const [name, column] of SCALAR_COLUMNS) {
    columns.push(column);
    values.push(ts[name] ?? null);
  }
  const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');
  const { rows } = await db.query(
    `INSERT INTO telemetry (${columns.join(', ')}) VALUES (${placeholders})
     ON CONFLICT ON CONSTRAINT telemetry_dedup DO NOTHING
     RETURNING id, observed_at`,
    values,
  );
  if (rows.length === 0) return { inserted: false };

  const { id, observed_at: observedAt } = rows[0];
  const cells = ts.rCellVoltages_V;
  await db.query(
    `INSERT INTO cell_measurements (telemetry_id, device_id, observed_at, cell_index, voltage_v)
     SELECT $1, $2, $3, c.ord::smallint, c.v
       FROM unnest($4::double precision[]) WITH ORDINALITY AS c(v, ord)`,
    [id, ctx.deviceId, observedAt, cells],
  );
  return { inserted: true, id, observedAt };
}

/** For a dedup conflict: is the stored snapshot identical to the incoming one? */
export async function isSameTelemetry(db, deviceId, bootId, sequence, thingset) {
  const { rows } = await db.query(
    `SELECT thingset = $4::jsonb AS same FROM telemetry WHERE device_id = $1 AND boot_id = $2 AND sequence = $3`,
    [deviceId, bootId, sequence, JSON.stringify(thingset)],
  );
  return rows[0]?.same ?? false;
}

// --- Read side ---------------------------------------------------------------

const ROW_SELECT = `
  t.id, t.delivery, t.schema_version, t.boot_id, t.sequence,
  t.measured_at, t.gateway_received_at, t.published_at, t.ingested_at, t.observed_at, t.observed_at_source,
  t.time_flags, g.external_id AS gateway_id, s.external_id AS site_id`;

/** Latest snapshot by measurement time (late replays never displace newer data). */
export async function getLatest(db, deviceId) {
  const { rows } = await db.query(
    `SELECT ${ROW_SELECT}, t.thingset
       FROM telemetry t JOIN gateways g ON g.id = t.gateway_id JOIN sites s ON s.id = t.site_id
      WHERE t.device_id = $1
      ORDER BY t.observed_at DESC, t.id DESC
      LIMIT 1`,
    [deviceId],
  );
  return rows[0] ?? null;
}

export async function getLatestCells(db, deviceId) {
  const { rows } = await db.query(
    `WITH latest AS (
       SELECT id, observed_at FROM telemetry WHERE device_id = $1 ORDER BY observed_at DESC, id DESC LIMIT 1)
     SELECT l.id AS telemetry_id, l.observed_at, c.cell_index, c.voltage_v
       FROM latest l JOIN cell_measurements c ON c.telemetry_id = l.id
      ORDER BY c.cell_index`,
    [deviceId],
  );
  return rows;
}

/** Raw rows, keyset-paginated on (observed_at, id). */
export async function listRaw(db, deviceId, { from, to, order, limit, cursor, columns }) {
  const dir = order === 'asc' ? 'ASC' : 'DESC';
  const cmp = order === 'asc' ? '>' : '<';
  const params = [deviceId, from, to, limit + 1];
  let cursorSql = '';
  if (cursor) {
    params.push(cursor.observedAt, cursor.id);
    cursorSql = `AND (t.observed_at, t.id) ${cmp} ($5::timestamptz, $6::bigint)`;
  }
  // `columns` is validated against an allow-list by the caller; never user text.
  const { rows } = await db.query(
    `SELECT ${ROW_SELECT}, ${columns.map((c) => `t.${c}`).join(', ')}
       FROM telemetry t JOIN gateways g ON g.id = t.gateway_id JOIN sites s ON s.id = t.site_id
      WHERE t.device_id = $1 AND t.observed_at >= $2 AND t.observed_at < $3 ${cursorSql}
      ORDER BY t.observed_at ${dir}, t.id ${dir}
      LIMIT $4`,
    params,
  );
  return rows;
}

/** Time-bucketed aggregates (min/avg/max per numeric column). Empty buckets are omitted. */
export async function listAggregated(db, deviceId, { from, to, bucketSeconds, order, columns }) {
  const aggs = columns.map((c) => `avg(t.${c}) AS ${c}_avg, min(t.${c}) AS ${c}_min, max(t.${c}) AS ${c}_max`).join(', ');
  const { rows } = await db.query(
    `SELECT date_bin(make_interval(secs => $4), t.observed_at, TIMESTAMPTZ '2000-01-01T00:00:00Z') AS bucket,
            count(*)::int AS sample_count, ${aggs}
       FROM telemetry t
      WHERE t.device_id = $1 AND t.observed_at >= $2 AND t.observed_at < $3
      GROUP BY bucket
      ORDER BY bucket ${order === 'asc' ? 'ASC' : 'DESC'}`,
    [deviceId, from, to, bucketSeconds],
  );
  return rows;
}

/** Summary for integrations: battery-relevant aggregates per bucket. */
export async function summarize(db, deviceId, { from, to, bucketSeconds }) {
  const { rows } = await db.query(
    `SELECT date_bin(make_interval(secs => $4), t.observed_at, TIMESTAMPTZ '2000-01-01T00:00:00Z') AS bucket,
            count(*)::int AS sample_count,
            min(t.observed_at) AS first_observed_at, max(t.observed_at) AS last_observed_at,
            avg(t.soc_pct) AS soc_pct_avg, min(t.soc_pct) AS soc_pct_min, max(t.soc_pct) AS soc_pct_max,
            (array_agg(t.soc_pct ORDER BY t.observed_at DESC) FILTER (WHERE t.soc_pct IS NOT NULL))[1] AS soc_pct_last,
            avg(t.pack_voltage_v) AS pack_voltage_v_avg, min(t.pack_voltage_v) AS pack_voltage_v_min,
            max(t.pack_voltage_v) AS pack_voltage_v_max,
            avg(t.pack_current_a) AS pack_current_a_avg, min(t.pack_current_a) AS pack_current_a_min,
            max(t.pack_current_a) AS pack_current_a_max,
            -- Derived by the backend from BMS min/max; mV with 0.1 mV resolution (firmware reports 1 mV)
            round((max(t.cell_voltage_max_v - t.cell_voltage_min_v) * 1000)::numeric, 1)::float8 AS cell_voltage_spread_mv_max,
            min(t.cell_voltage_min_v) AS cell_voltage_min_v, max(t.cell_voltage_max_v) AS cell_voltage_max_v,
            max(GREATEST(t.ic_temp_degc, t.mosfet_temp_degc, t.shunt_temp_degc,
                         (SELECT max(x) FROM unnest(t.cell_temps_degc) x))) AS temp_max_degc,
            bit_or(t.error_flags) AS error_flags_any,
            count(*) FILTER (WHERE t.error_flags <> 0)::int AS samples_with_errors
       FROM telemetry t
      WHERE t.device_id = $1 AND t.observed_at >= $2 AND t.observed_at < $3
      GROUP BY bucket
      ORDER BY bucket DESC`,
    [deviceId, from, to, bucketSeconds],
  );
  return rows;
}
