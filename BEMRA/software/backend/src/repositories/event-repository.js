export async function insertEvent(db, ctx, msg) {
  const ts = msg.thingset ?? {};
  const { rows } = await db.query(
    `INSERT INTO bms_events (device_id, gateway_id, site_id, schema_version, boot_id, sequence,
                             measured_at, gateway_received_at, published_at,
                             code, severity, state, message, error_flags, bms_state, thingset)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
     ON CONFLICT ON CONSTRAINT bms_events_dedup DO NOTHING
     RETURNING id`,
    [
      ctx.deviceId,
      ctx.gatewayId,
      ctx.siteId,
      msg.schema_version,
      msg.boot_id,
      msg.sequence,
      msg.timestamps.measured_at,
      msg.timestamps.gateway_received_at,
      msg.timestamps.published_at,
      msg.event.code,
      msg.event.severity,
      msg.event.state,
      msg.event.message ?? null,
      ts.rErrorFlags ?? null,
      ts.rBmsState ?? null,
      JSON.stringify(ts),
    ],
  );
  return rows.length ? { inserted: true, id: rows[0].id } : { inserted: false };
}

export async function listEvents(db, deviceId, { from, to, order, limit, cursor, severity }) {
  const dir = order === 'asc' ? 'ASC' : 'DESC';
  const cmp = order === 'asc' ? '>' : '<';
  const params = [deviceId, from, to, limit + 1, severity ?? null];
  let cursorSql = '';
  if (cursor) {
    params.push(cursor.observedAt, cursor.id);
    cursorSql = `AND (e.observed_at, e.id) ${cmp} ($6::timestamptz, $7::bigint)`;
  }
  const { rows } = await db.query(
    `SELECT e.id, e.code, e.severity, e.state, e.message, e.error_flags, e.bms_state, e.thingset,
            e.boot_id, e.sequence, e.measured_at, e.gateway_received_at, e.published_at, e.ingested_at,
            e.observed_at, g.external_id AS gateway_id, s.external_id AS site_id
       FROM bms_events e JOIN gateways g ON g.id = e.gateway_id JOIN sites s ON s.id = e.site_id
      WHERE e.device_id = $1 AND e.observed_at >= $2 AND e.observed_at < $3
        AND ($5::text IS NULL OR e.severity = $5) ${cursorSql}
      ORDER BY e.observed_at ${dir}, e.id ${dir}
      LIMIT $4`,
    params,
  );
  return rows;
}

export async function countEventsBySeverity(db, deviceId, { from, to }) {
  const { rows } = await db.query(
    `SELECT severity, state, count(*)::int AS count FROM bms_events
      WHERE device_id = $1 AND observed_at >= $2 AND observed_at < $3
      GROUP BY severity, state ORDER BY severity, state`,
    [deviceId, from, to],
  );
  return rows;
}
