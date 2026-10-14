/**
 * Home Assistant MQTT auto-discovery.
 *
 * For every registered, active device the backend publishes retained discovery
 * configs. Each entity reads the device's existing telemetry topic
 * ({root}/v1/{site}/{device}/live); availability follows the gateway status
 * topic (online / Last Will). No gateway firmware or schema changes are needed.
 *
 * Discovery prefix is configurable: on the shared public broker it must be a
 * private namespace (e.g. bemra-dev-01092a/homeassistant), never the global
 * default "homeassistant".
 */
import { deviceTopic, statusTopic } from '../contracts/topics.js';

const DEFAULT_EXPIRE_S = 300; // entity becomes unavailable after this long without telemetry (= backend STALE_AFTER_S)

const ts = (k) => `value_json.thingset.${k}`;

/** @returns {{topic: string, payload: object}[]} */
export function buildDiscovery(device, { topicRoot, prefix, idleCurrentA = 0.1, expireAfterS = DEFAULT_EXPIRE_S }) {
  const id = device.device_id;
  const uid = `bemra_${id.replace(/-/g, '_')}`;
  const stateTopic = deviceTopic(topicRoot, device.site_id, id, 'live');
  const deviceBlock = {
    identifiers: [uid],
    name: `BEMRA ${id}`,
    manufacturer: device.manufacturer ?? 'Libre Solar',
    model: device.bms_model ?? 'BMS C1',
    sw_version: device.firmware_version ?? undefined,
    suggested_area: device.site_name ?? undefined,
  };
  const common = {
    state_topic: stateTopic,
    availability_topic: statusTopic(topicRoot, device.site_id, device.gateway_id),
    availability_template: '{{ value_json.state }}',
    payload_available: 'online',
    payload_not_available: 'offline',
    expire_after: expireAfterS,
    device: deviceBlock,
    origin: { name: 'BEMRA backend' },
  };

  const sensors = [
    { key: 'soc', name: 'SOC', unit: '%', dc: 'battery', tpl: `{{ ${ts('rSOC_pct')} }}`, prec: 1 },
    { key: 'pack_voltage', name: 'Pack voltage', unit: 'V', dc: 'voltage', tpl: `{{ ${ts('rPackVoltage_V')} }}`, prec: 2 },
    { key: 'pack_current', name: 'Pack current', unit: 'A', dc: 'current', tpl: `{{ ${ts('rPackCurrent_A')} }}`, prec: 2 },
    {
      key: 'power',
      name: 'Power',
      unit: 'W',
      dc: 'power',
      tpl: `{{ (${ts('rPackVoltage_V')} * ${ts('rPackCurrent_A')}) | round(1) }}`,
      prec: 1,
    },
    { key: 'bms_ic_temperature', name: 'BMS IC temperature', unit: '°C', dc: 'temperature', tpl: `{{ ${ts('rICTemp_degC')} }}`, prec: 1 },
    {
      key: 'cell_spread',
      name: 'Cell spread',
      unit: 'mV',
      dc: 'voltage',
      tpl: `{{ (((${ts('rCellVoltages_V')} | max) - (${ts('rCellVoltages_V')} | min)) * 1000) | round(1) }}`,
      prec: 1,
    },
    { key: 'error_flags', name: 'Error flags', icon: 'mdi:alert-circle-outline', tpl: `{{ ${ts('rErrorFlags')} }}`, measurement: false },
    {
      key: 'bms_state',
      name: 'BMS state',
      icon: 'mdi:shield-check-outline',
      tpl: `{{ {0: 'Off', 1: 'Charge only', 2: 'Discharge only', 3: 'Normal', 4: 'Shutdown'}.get(${ts('rBmsState')}, 'Unknown') }}`,
      measurement: false,
    },
    {
      key: 'operating_mode',
      name: 'Operating mode',
      icon: 'mdi:battery-charging',
      tpl: `{% set i = ${ts('rPackCurrent_A')} %}{{ 'Charging' if i > ${idleCurrentA} else ('Discharging' if i < -${idleCurrentA} else 'Idle') }}`,
      measurement: false,
    },
  ];
  for (let i = 1; i <= (device.cell_count ?? 0); i++) {
    sensors.push({
      key: `cell_${i}`,
      name: `Cell ${i}`,
      unit: 'V',
      dc: 'voltage',
      tpl: `{{ ${ts('rCellVoltages_V')}[${i - 1}] }}`,
      prec: 3,
    });
  }
  for (let i = 1; i <= (device.thermistor_count ?? 0); i++) {
    sensors.push({
      key: `thermistor_${i}`,
      name: `Thermistor ${i}`,
      unit: '°C',
      dc: 'temperature',
      tpl: `{{ ${ts('rCellTemps_degC')}[${i - 1}] }}`,
      prec: 1,
    });
  }

  const out = sensors.map((s) => ({
    topic: `${prefix}/sensor/${uid}/${s.key}/config`,
    payload: {
      ...common,
      name: s.name,
      unique_id: `${uid}_${s.key}`,
      value_template: s.tpl,
      ...(s.unit ? { unit_of_measurement: s.unit } : {}),
      ...(s.dc ? { device_class: s.dc } : {}),
      ...(s.icon ? { icon: s.icon } : {}),
      ...(s.prec !== undefined ? { suggested_display_precision: s.prec } : {}),
      ...(s.measurement === false ? {} : { state_class: 'measurement' }),
    },
  }));
  out.push({
    topic: `${prefix}/binary_sensor/${uid}/fault/config`,
    payload: {
      ...common,
      name: 'Fault',
      unique_id: `${uid}_fault`,
      device_class: 'problem',
      value_template: `{{ 'ON' if ${ts('rErrorFlags')} > 0 else 'OFF' }}`,
    },
  });
  return out;
}

/** Registered, active devices with their current site/gateway and channel counts. */
export async function loadDiscoveryDevices(db) {
  const { rows } = await db.query(
    `SELECT v.external_id AS device_id, v.site_external_id AS site_id, v.gateway_external_id AS gateway_id,
            v.manufacturer, v.bms_model, v.firmware_version, v.site_name,
            COALESCE(v.cell_count, lt.cell_count) AS cell_count,
            COALESCE(v.thermistor_count, lt.thermistors) AS thermistor_count
       FROM v_device_current v
       LEFT JOIN LATERAL (
         SELECT t.cell_count, COALESCE(array_length(t.cell_temps_degc, 1), 0) AS thermistors
           FROM telemetry t WHERE t.device_id = v.id ORDER BY t.observed_at DESC LIMIT 1) lt ON true
      WHERE v.status = 'active' AND v.site_external_id IS NOT NULL AND v.gateway_external_id IS NOT NULL
      ORDER BY v.external_id`,
  );
  return rows;
}

/** Publishes retained discovery configs for all devices. Returns the number of configs sent. */
export async function publishDiscovery(client, db, opts) {
  const devices = await loadDiscoveryDevices(db);
  let n = 0;
  for (const d of devices) {
    for (const { topic, payload } of buildDiscovery(d, opts)) {
      await client.publishAsync(topic, JSON.stringify(payload), { qos: 1, retain: true });
      n++;
    }
  }
  return { devices: devices.length, configs: n };
}
