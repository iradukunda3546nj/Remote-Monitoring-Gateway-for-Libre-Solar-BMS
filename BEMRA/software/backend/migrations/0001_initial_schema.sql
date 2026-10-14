-- =============================================================================
-- BEMRA 0001: initial schema
-- Requires PostgreSQL >= 15 (UNIQUE NULLS NOT DISTINCT).
--
-- Conventions
--   * Every entity has an internal BIGINT identity `id` and, where it appears in
--     MQTT topics, a stable lowercase `external_id`.
--   * All timestamps are TIMESTAMPTZ (stored UTC).
--   * Measurement values are DOUBLE PRECISION: the BMS produces IEEE-754 float32,
--     every float32 is exactly representable as float64, and the original JSON
--     text of each value is additionally preserved in telemetry.thingset (JSONB).
--   * uint32 ThingSet values (rErrorFlags, rBalancingStatus, sequence) are BIGINT
--     with explicit range checks.
-- =============================================================================

CREATE OR REPLACE FUNCTION bemra_set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- ----------------------------------------------------------------------------
-- Installation sites (location metadata lives here, never in telemetry rows)
-- ----------------------------------------------------------------------------
CREATE TABLE sites (
  id                        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  external_id               TEXT NOT NULL UNIQUE
                              CHECK (external_id ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  name                      TEXT NOT NULL,
  country_code              CHAR(2) CHECK (country_code ~ '^[A-Z]{2}$'),   -- ISO 3166-1 alpha-2
  region                    TEXT,
  district                  TEXT,
  installation_description  TEXT,
  address                   TEXT,
  latitude                  DOUBLE PRECISION CHECK (latitude BETWEEN -90 AND 90),
  longitude                 DOUBLE PRECISION CHECK (longitude BETWEEN -180 AND 180),
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sites_lat_lon_together CHECK ((latitude IS NULL) = (longitude IS NULL))
);
CREATE TRIGGER sites_updated_at BEFORE UPDATE ON sites
  FOR EACH ROW EXECUTE FUNCTION bemra_set_updated_at();

-- ----------------------------------------------------------------------------
-- Edge gateways (ESP32 T-Call), distinct from the BMS they read
-- ----------------------------------------------------------------------------
CREATE TABLE gateways (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  external_id       TEXT NOT NULL UNIQUE CHECK (external_id ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  model             TEXT NOT NULL DEFAULT 'LILYGO T-Call ESP32 SIM800L',
  firmware_version  TEXT,
  notes             TEXT,
  last_seen_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER gateways_updated_at BEFORE UPDATE ON gateways
  FOR EACH ROW EXECUTE FUNCTION bemra_set_updated_at();

-- ----------------------------------------------------------------------------
-- BMS devices
-- ----------------------------------------------------------------------------
CREATE TABLE devices (
  id                   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  external_id          TEXT NOT NULL UNIQUE
                         CHECK (external_id ~ '^[a-z0-9][a-z0-9-]{1,62}$' AND external_id <> 'gateways'),
  bms_model            TEXT NOT NULL DEFAULT 'Libre Solar BMS C1',
  -- Values reported by the BMS Device group (cManufacturer, cDeviceType, ...)
  manufacturer         TEXT,
  device_type          TEXT,
  hardware_version     TEXT,
  firmware_version     TEXT,
  -- Provisioned pack layout (declared by the gateway in the meta message)
  cell_count           SMALLINT CHECK (cell_count BETWEEN 1 AND 32),
  thermistor_count     SMALLINT CHECK (thermistor_count BETWEEN 0 AND 16),
  chemistry            TEXT CHECK (chemistry IN ('LFP', 'NMC', 'LTO')),
  nominal_capacity_ah  DOUBLE PRECISION CHECK (nominal_capacity_ah > 0),
  status               TEXT NOT NULL DEFAULT 'active'
                         CHECK (status IN ('active', 'inactive', 'decommissioned')),
  last_schema_version  TEXT,
  last_seen_at         TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER devices_updated_at BEFORE UPDATE ON devices
  FOR EACH ROW EXECUTE FUNCTION bemra_set_updated_at();

-- ----------------------------------------------------------------------------
-- Assignment history. valid_to IS NULL marks the current assignment; at most
-- one current row per device. Relocations close the old row, keeping history.
-- ----------------------------------------------------------------------------
CREATE TABLE device_site_assignments (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  device_id   BIGINT NOT NULL REFERENCES devices (id),
  site_id     BIGINT NOT NULL REFERENCES sites (id),
  valid_from  TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_to    TIMESTAMPTZ,
  note        TEXT,
  CHECK (valid_to IS NULL OR valid_to > valid_from)
);
CREATE UNIQUE INDEX device_site_assignments_one_current
  ON device_site_assignments (device_id) WHERE valid_to IS NULL;
CREATE INDEX device_site_assignments_site ON device_site_assignments (site_id);

CREATE TABLE device_gateway_assignments (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  device_id   BIGINT NOT NULL REFERENCES devices (id),
  gateway_id  BIGINT NOT NULL REFERENCES gateways (id),
  valid_from  TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_to    TIMESTAMPTZ,
  note        TEXT,
  CHECK (valid_to IS NULL OR valid_to > valid_from)
);
CREATE UNIQUE INDEX device_gateway_assignments_one_current
  ON device_gateway_assignments (device_id) WHERE valid_to IS NULL;
CREATE INDEX device_gateway_assignments_gateway ON device_gateway_assignments (gateway_id);

-- ----------------------------------------------------------------------------
-- Telemetry (ThingSet Meas group snapshots from live/replay topics)
-- ----------------------------------------------------------------------------
CREATE TABLE telemetry (
  id                   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  device_id            BIGINT NOT NULL REFERENCES devices (id),
  gateway_id           BIGINT NOT NULL REFERENCES gateways (id),
  site_id              BIGINT NOT NULL REFERENCES sites (id),   -- site at ingestion time
  delivery             TEXT NOT NULL CHECK (delivery IN ('live', 'replay')),
  schema_version       TEXT NOT NULL,
  boot_id              TEXT NOT NULL,
  sequence             BIGINT NOT NULL CHECK (sequence BETWEEN 0 AND 4294967295),

  -- Timestamps exactly as supplied; NULL means "not provided", never invented.
  measured_at          TIMESTAMPTZ,
  gateway_received_at  TIMESTAMPTZ,
  published_at         TIMESTAMPTZ,
  ingested_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Best available time for ordering/queries, plus which clock it came from.
  observed_at          TIMESTAMPTZ GENERATED ALWAYS AS
                         (COALESCE(measured_at, gateway_received_at, published_at, ingested_at)) STORED,
  observed_at_source   TEXT GENERATED ALWAYS AS (
                         CASE WHEN measured_at IS NOT NULL THEN 'bms'
                              WHEN gateway_received_at IS NOT NULL THEN 'gateway'
                              WHEN published_at IS NOT NULL THEN 'publish'
                              ELSE 'backend' END) STORED,
  time_flags           TEXT[] NOT NULL DEFAULT '{}',

  -- Typed extraction of ThingSet Meas objects (names/units unchanged, see docs)
  pack_voltage_v       DOUBLE PRECISION,              -- rPackVoltage_V    0x71
  stack_voltage_v      DOUBLE PRECISION,              -- rStackVoltage_V   0x72
  pack_current_a       DOUBLE PRECISION,              -- rPackCurrent_A    0x73 (+ = charging)
  cell_temps_degc      DOUBLE PRECISION[],            -- rCellTemps_degC   0x74
  ic_temp_degc         DOUBLE PRECISION,              -- rICTemp_degC      0x75
  mosfet_temp_degc     DOUBLE PRECISION,              -- rMOSFETTemp_degC  0x77
  shunt_temp_degc      DOUBLE PRECISION,              -- rShuntTemp_degC   0x78
  soc_pct              DOUBLE PRECISION,              -- rSOC_pct          0x7C
  error_flags          BIGINT CHECK (error_flags BETWEEN 0 AND 4294967295),       -- rErrorFlags 0x7E
  bms_state            SMALLINT CHECK (bms_state BETWEEN 0 AND 255),              -- rBmsState   0x7F
  cell_count           SMALLINT CHECK (cell_count BETWEEN 0 AND 32),              -- len(rCellVoltages_V)
  cell_voltage_avg_v   DOUBLE PRECISION,              -- rCellAvgVoltage_V 0x81
  cell_voltage_min_v   DOUBLE PRECISION,              -- rCellMinVoltage_V 0x82
  cell_voltage_max_v   DOUBLE PRECISION,              -- rCellMaxVoltage_V 0x83
  balancing_status     BIGINT CHECK (balancing_status BETWEEN 0 AND 4294967295),  -- rBalancingStatus 0x84

  -- Complete validated ThingSet object as received (including fields without a typed column)
  thingset             JSONB NOT NULL CHECK (jsonb_typeof(thingset) = 'object'),

  CONSTRAINT telemetry_dedup UNIQUE (device_id, boot_id, sequence)
);
CREATE INDEX telemetry_device_time ON telemetry (device_id, observed_at DESC, id DESC);
CREATE INDEX telemetry_observed_brin ON telemetry USING BRIN (observed_at);

-- Per-cell voltages (one row per element of rCellVoltages_V, 1-based index)
CREATE TABLE cell_measurements (
  telemetry_id  BIGINT NOT NULL REFERENCES telemetry (id) ON DELETE CASCADE,
  device_id     BIGINT NOT NULL REFERENCES devices (id),
  observed_at   TIMESTAMPTZ NOT NULL,
  cell_index    SMALLINT NOT NULL CHECK (cell_index BETWEEN 1 AND 32),
  voltage_v     DOUBLE PRECISION,   -- NULL = gateway reported the value as invalid
  PRIMARY KEY (telemetry_id, cell_index)
);
CREATE INDEX cell_measurements_device_cell_time
  ON cell_measurements (device_id, cell_index, observed_at DESC);

-- ----------------------------------------------------------------------------
-- Events published by the gateway (fault raise/clear, state transitions, ...)
-- ----------------------------------------------------------------------------
CREATE TABLE bms_events (
  id                   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  device_id            BIGINT NOT NULL REFERENCES devices (id),
  gateway_id           BIGINT NOT NULL REFERENCES gateways (id),
  site_id              BIGINT NOT NULL REFERENCES sites (id),
  schema_version       TEXT NOT NULL,
  boot_id              TEXT NOT NULL,
  sequence             BIGINT NOT NULL CHECK (sequence BETWEEN 0 AND 4294967295),
  measured_at          TIMESTAMPTZ,
  gateway_received_at  TIMESTAMPTZ,
  published_at         TIMESTAMPTZ,
  ingested_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  observed_at          TIMESTAMPTZ GENERATED ALWAYS AS
                         (COALESCE(measured_at, gateway_received_at, published_at, ingested_at)) STORED,
  code                 TEXT NOT NULL CHECK (code ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  severity             TEXT NOT NULL CHECK (severity IN ('critical', 'warning', 'info')),
  state                TEXT NOT NULL CHECK (state IN ('raised', 'cleared', 'instant')),
  message              TEXT,
  error_flags          BIGINT CHECK (error_flags BETWEEN 0 AND 4294967295),
  bms_state            SMALLINT CHECK (bms_state BETWEEN 0 AND 255),
  thingset             JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(thingset) = 'object'),
  CONSTRAINT bms_events_dedup UNIQUE (device_id, boot_id, sequence)
);
CREATE INDEX bms_events_device_time ON bms_events (device_id, observed_at DESC, id DESC);

-- ----------------------------------------------------------------------------
-- Gateway connectivity history (status topic, incl. broker Last Will)
-- ----------------------------------------------------------------------------
CREATE TABLE gateway_status (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  gateway_id         BIGINT NOT NULL REFERENCES gateways (id),
  site_id            BIGINT NOT NULL REFERENCES sites (id),
  state              TEXT NOT NULL CHECK (state IN ('online', 'offline')),
  boot_id            TEXT,
  sequence           BIGINT CHECK (sequence BETWEEN 0 AND 4294967295),
  published_at       TIMESTAMPTZ,
  ingested_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  link_type          TEXT CHECK (link_type IN ('wifi', 'gprs', 'lte', 'ethernet')),
  rssi_dbm           SMALLINT CHECK (rssi_dbm BETWEEN -150 AND 0),
  uptime_s           BIGINT CHECK (uptime_s >= 0),
  buffered_messages  INTEGER CHECK (buffered_messages >= 0),
  firmware_version   TEXT,
  retained           BOOLEAN NOT NULL DEFAULT false,
  payload            JSONB NOT NULL,
  -- Retained status and Last Will messages are re-delivered on every
  -- reconnect; they must not create new history rows.
  CONSTRAINT gateway_status_dedup UNIQUE NULLS NOT DISTINCT (gateway_id, boot_id, state, sequence)
);
CREATE INDEX gateway_status_gateway_time ON gateway_status (gateway_id, ingested_at DESC, id DESC);

-- ----------------------------------------------------------------------------
-- Device metadata snapshots (ThingSet Device + Conf groups, pack layout)
-- Configuration is stored read-only here; the API never writes it to a BMS.
-- ----------------------------------------------------------------------------
CREATE TABLE device_metadata (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  device_id         BIGINT NOT NULL REFERENCES devices (id),
  gateway_id        BIGINT NOT NULL REFERENCES gateways (id),
  schema_version    TEXT NOT NULL,
  boot_id           TEXT NOT NULL,
  sequence          BIGINT NOT NULL CHECK (sequence BETWEEN 0 AND 4294967295),
  published_at      TIMESTAMPTZ,
  ingested_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  device_info       JSONB NOT NULL DEFAULT '{}'::jsonb,   -- ThingSet Device group
  conf              JSONB NOT NULL DEFAULT '{}'::jsonb,   -- ThingSet Conf group snapshot
  layout            JSONB NOT NULL DEFAULT '{}'::jsonb,   -- cell_count, thermistor_count, chemistry
  gateway_info      JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT device_metadata_dedup UNIQUE (device_id, boot_id, sequence)
);
CREATE INDEX device_metadata_device_time ON device_metadata (device_id, ingested_at DESC);

-- ----------------------------------------------------------------------------
-- Rejected MQTT messages (bounded; pruned by the ingestion worker)
-- ----------------------------------------------------------------------------
CREATE TABLE ingest_rejections (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  received_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  topic            TEXT NOT NULL,
  reason           TEXT NOT NULL,
  detail           JSONB NOT NULL DEFAULT '{}'::jsonb,
  payload_bytes    INTEGER NOT NULL,
  payload_excerpt  TEXT          -- first 2 KiB only
);
CREATE INDEX ingest_rejections_time ON ingest_rejections (received_at DESC);

-- ----------------------------------------------------------------------------
-- Convenience view: each device with its current site and gateway
-- ----------------------------------------------------------------------------
CREATE VIEW v_device_current AS
SELECT d.id, d.external_id, d.bms_model, d.manufacturer, d.device_type, d.hardware_version,
       d.firmware_version, d.cell_count, d.thermistor_count, d.chemistry, d.nominal_capacity_ah,
       d.status, d.last_schema_version, d.last_seen_at, d.created_at, d.updated_at,
       s.id AS site_id, s.external_id AS site_external_id, s.name AS site_name,
       g.id AS gateway_id, g.external_id AS gateway_external_id, g.firmware_version AS gateway_firmware_version
FROM devices d
LEFT JOIN device_site_assignments dsa ON dsa.device_id = d.id AND dsa.valid_to IS NULL
LEFT JOIN sites s ON s.id = dsa.site_id
LEFT JOIN device_gateway_assignments dga ON dga.device_id = d.id AND dga.valid_to IS NULL
LEFT JOIN gateways g ON g.id = dga.gateway_id;
