/** Gateway status history and device metadata snapshots. */

export async function insertGatewayStatus(db, ids, msg, { retained }) {
  const { rows } = await db.query(
    `INSERT INTO gateway_status (gateway_id, site_id, state, boot_id, sequence, published_at, link_type, rssi_dbm,
                                 uptime_s, buffered_messages, firmware_version, retained, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT ON CONSTRAINT gateway_status_dedup DO NOTHING
     RETURNING id`,
    [
      ids.gatewayId,
      ids.siteId,
      msg.state,
      msg.boot_id ?? null,
      msg.sequence ?? null,
      msg.published_at ?? null,
      msg.link?.type ?? null,
      msg.link?.rssi_dbm ?? null,
      msg.uptime_s ?? null,
      msg.buffered_messages ?? null,
      msg.firmware_version ?? null,
      retained,
      JSON.stringify(msg),
    ],
  );
  return rows.length ? { inserted: true, id: rows[0].id } : { inserted: false };
}

/** Latest gateway status for the gateway currently serving a device. */
export async function getLatestGatewayStatus(db, gatewayExternalId) {
  const { rows } = await db.query(
    `SELECT gs.state, gs.boot_id, gs.sequence, gs.published_at, gs.ingested_at, gs.link_type, gs.rssi_dbm,
            gs.uptime_s, gs.buffered_messages, gs.firmware_version, gs.retained
       FROM gateway_status gs JOIN gateways g ON g.id = gs.gateway_id
      WHERE g.external_id = $1
      ORDER BY gs.ingested_at DESC, gs.id DESC
      LIMIT 1`,
    [gatewayExternalId],
  );
  return rows[0] ?? null;
}

export async function insertDeviceMetadata(db, ctx, msg) {
  const { rows } = await db.query(
    `INSERT INTO device_metadata (device_id, gateway_id, schema_version, boot_id, sequence, published_at,
                                  device_info, conf, layout, gateway_info)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT ON CONSTRAINT device_metadata_dedup DO NOTHING
     RETURNING id`,
    [
      ctx.deviceId,
      ctx.gatewayId,
      msg.schema_version,
      msg.boot_id,
      msg.sequence,
      msg.timestamps.published_at,
      JSON.stringify(msg.device),
      JSON.stringify(msg.conf ?? {}),
      JSON.stringify(msg.layout),
      JSON.stringify(msg.gateway ?? {}),
    ],
  );
  return rows.length ? { inserted: true, id: rows[0].id } : { inserted: false };
}

export async function getLatestMetadata(db, deviceId) {
  const { rows } = await db.query(
    `SELECT device_info, conf, layout, gateway_info, boot_id, sequence, published_at, ingested_at
       FROM device_metadata WHERE device_id = $1 ORDER BY ingested_at DESC, id DESC LIMIT 1`,
    [deviceId],
  );
  return rows[0] ?? null;
}

// --- Rejections --------------------------------------------------------------

let insertsSincePrune = 0;

export async function insertRejection(db, { topic, reason, detail, payload }, maxRows) {
  const excerpt = payload.subarray(0, 2048).toString('utf8');
  await db.query(
    `INSERT INTO ingest_rejections (topic, reason, detail, payload_bytes, payload_excerpt)
     VALUES ($1, $2, $3, $4, $5)`,
    [topic.slice(0, 512), reason, JSON.stringify(detail ?? {}), payload.length, excerpt],
  );
  if (++insertsSincePrune >= 100) {
    insertsSincePrune = 0;
    await db.query(
      `DELETE FROM ingest_rejections
        WHERE id <= (SELECT id FROM ingest_rejections ORDER BY id DESC OFFSET $1 LIMIT 1)`,
      [maxRows],
    );
  }
}
