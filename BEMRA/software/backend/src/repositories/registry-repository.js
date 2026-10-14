/**
 * Sites, gateways, devices and their assignment history.
 * All functions take a pg client/pool as the first argument so they can run
 * inside a caller-controlled transaction.
 */

/**
 * Resolves the device and verifies that it was assigned to the given site and
 * gateway at time `at` (the message time). Using the message time rather than
 * "now" keeps buffered replays valid after a device is relocated.
 */
export async function resolveDeviceContext(db, { deviceExternalId, siteExternalId, gatewayExternalId, at }) {
  const { rows } = await db.query(
    `SELECT d.id AS device_id, d.status,
            (SELECT s.id FROM device_site_assignments a JOIN sites s ON s.id = a.site_id
              WHERE a.device_id = d.id AND s.external_id = $2
                AND a.valid_from <= $4 AND (a.valid_to IS NULL OR a.valid_to > $4)) AS site_id,
            (SELECT g.id FROM device_gateway_assignments a JOIN gateways g ON g.id = a.gateway_id
              WHERE a.device_id = d.id AND g.external_id = $3
                AND a.valid_from <= $4 AND (a.valid_to IS NULL OR a.valid_to > $4)) AS gateway_id
       FROM devices d
      WHERE d.external_id = $1`,
    [deviceExternalId, siteExternalId, gatewayExternalId, at],
  );
  return rows[0] ?? null;
}

export async function findGatewayAndSite(db, { gatewayExternalId, siteExternalId }) {
  const { rows } = await db.query(
    `SELECT (SELECT id FROM gateways WHERE external_id = $1) AS gateway_id,
            (SELECT id FROM sites WHERE external_id = $2) AS site_id`,
    [gatewayExternalId, siteExternalId],
  );
  return rows[0];
}

export async function touchDevice(db, deviceId, schemaVersion) {
  await db.query(
    `UPDATE devices SET last_seen_at = GREATEST(COALESCE(last_seen_at, now()), now()), last_schema_version = $2
      WHERE id = $1`,
    [deviceId, schemaVersion],
  );
}

export async function touchGateway(db, gatewayId, firmwareVersion = null) {
  await db.query(`UPDATE gateways SET last_seen_at = now(), firmware_version = COALESCE($2, firmware_version) WHERE id = $1`, [
    gatewayId,
    firmwareVersion,
  ]);
}

/** Copies identity/layout values reported in a meta message onto the device row. */
export async function applyDeviceMetadata(db, deviceId, { device = {}, layout = {}, conf = {} }) {
  await db.query(
    `UPDATE devices SET
        manufacturer        = COALESCE($2, manufacturer),
        device_type         = COALESCE($3, device_type),
        hardware_version    = COALESCE($4, hardware_version),
        firmware_version    = COALESCE($5, firmware_version),
        cell_count          = COALESCE($6, cell_count),
        thermistor_count    = COALESCE($7, thermistor_count),
        chemistry           = COALESCE($8, chemistry),
        nominal_capacity_ah = COALESCE($9, nominal_capacity_ah)
      WHERE id = $1`,
    [
      deviceId,
      device.cManufacturer ?? null,
      device.cDeviceType ?? null,
      device.cHardwareVersion ?? null,
      device.cFirmwareVersion ?? null,
      layout.cell_count ?? null,
      layout.thermistor_count ?? null,
      layout.chemistry ?? null,
      conf.sNominalCapacity_Ah > 0 ? conf.sNominalCapacity_Ah : null,
    ],
  );
}

// --- Read side (API) ---------------------------------------------------------

export async function listSites(db) {
  const { rows } = await db.query(
    `SELECT s.external_id AS site_id, s.name, s.country_code, s.region, s.district,
            s.installation_description, s.address, s.latitude, s.longitude, s.created_at, s.updated_at,
            (SELECT count(*)::int FROM device_site_assignments a WHERE a.site_id = s.id AND a.valid_to IS NULL) AS device_count
       FROM sites s ORDER BY s.external_id`,
  );
  return rows;
}

const DEVICE_SELECT = `
  SELECT v.id, v.external_id AS device_id, v.bms_model, v.manufacturer, v.device_type, v.hardware_version,
         v.firmware_version, v.cell_count, v.thermistor_count, v.chemistry, v.nominal_capacity_ah, v.status,
         v.last_schema_version, v.last_seen_at, v.created_at, v.updated_at,
         v.site_external_id AS site_id, v.site_name,
         v.gateway_external_id AS gateway_id, v.gateway_firmware_version
    FROM v_device_current v`;

export async function listDevices(db, { siteExternalId } = {}) {
  const { rows } = siteExternalId
    ? await db.query(`${DEVICE_SELECT} WHERE v.site_external_id = $1 ORDER BY v.external_id`, [siteExternalId])
    : await db.query(`${DEVICE_SELECT} ORDER BY v.external_id`);
  return rows;
}

export async function getDevice(db, deviceExternalId) {
  const { rows } = await db.query(`${DEVICE_SELECT} WHERE v.external_id = $1`, [deviceExternalId]);
  return rows[0] ?? null;
}

export async function getDeviceSite(db, siteExternalId) {
  const { rows } = await db.query(
    `SELECT external_id AS site_id, name, country_code, region, district, installation_description,
            address, latitude, longitude
       FROM sites WHERE external_id = $1`,
    [siteExternalId],
  );
  return rows[0] ?? null;
}

export async function getAssignmentHistory(db, deviceInternalId) {
  const { rows } = await db.query(
    `SELECT 'site' AS kind, s.external_id AS target_id, a.valid_from, a.valid_to, a.note
       FROM device_site_assignments a JOIN sites s ON s.id = a.site_id WHERE a.device_id = $1
     UNION ALL
     SELECT 'gateway', g.external_id, a.valid_from, a.valid_to, a.note
       FROM device_gateway_assignments a JOIN gateways g ON g.id = a.gateway_id WHERE a.device_id = $1
     ORDER BY valid_from DESC`,
    [deviceInternalId],
  );
  return rows;
}
