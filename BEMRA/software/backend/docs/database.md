# PostgreSQL schema

Migration: [`migrations/0001_initial_schema.sql`](../migrations/0001_initial_schema.sql). Requires PostgreSQL ≥ 15.

```text
sites ─┬─< device_site_assignments >─┬─ devices ─┬─< telemetry ─< cell_measurements
       │      (valid_from/valid_to)  │           ├─< bms_events
       │                             │           └─< device_metadata
gateways ─< device_gateway_assignments >─┘
gateways ─< gateway_status
ingest_rejections (standalone, bounded)
```

| Table                        | Responsibility                                                             | Key / dedup                                                        |
| ---------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `sites`                      | Location metadata (country, region, district, optional lat/lon, address)   | `external_id` unique                                               |
| `gateways`                   | ESP32 gateway identity, firmware, last seen                                | `external_id` unique                                               |
| `devices`                    | BMS identity (Device group values), provisioned layout, status             | `external_id` unique; `gateways` reserved                          |
| `device_site_assignments`    | Site history; `valid_to IS NULL` = current                                 | partial unique: one current per device                             |
| `device_gateway_assignments` | Gateway history                                                            | partial unique: one current per device                             |
| `telemetry`                  | One row per ThingSet snapshot: typed columns + complete JSONB + timestamps | `UNIQUE (device_id, boot_id, sequence)`                            |
| `cell_measurements`          | One row per cell voltage                                                   | PK `(telemetry_id, cell_index)`                                    |
| `bms_events`                 | Gateway events                                                             | `UNIQUE (device_id, boot_id, sequence)`                            |
| `gateway_status`             | Online/offline history incl. Last Will                                     | `UNIQUE NULLS NOT DISTINCT (gateway_id, boot_id, state, sequence)` |
| `device_metadata`            | Device + Conf + layout snapshots                                           | `UNIQUE (device_id, boot_id, sequence)`                            |
| `ingest_rejections`          | Rejected MQTT messages (bounded to `MAX_REJECTIONS`)                       |                                                                    |
| `schema_migrations`          | Applied migrations + SHA‑256 checksums                                     |                                                                    |

The view `v_device_current` joins each device to its current site and gateway.

## Design decisions

- **Hybrid storage.** `telemetry.thingset` (JSONB) keeps the complete validated object.
  Typed `DOUBLE PRECISION` columns hold the frequently queried values. The BMS
  produces float32, every float32 fits exactly in float64, and the JSONB
  additionally keeps the original decimal text. uint32 values use `BIGINT` with range checks.
- **No static metadata in telemetry rows.** Location lives in `sites`. Each
  telemetry row stores only the `site_id` and `gateway_id` that were valid
  when it was ingested, so history stays correct after a relocation.
- **Timestamps.** `measured_at`, `gateway_received_at` and `published_at` are stored as
  received (NULL if not provided). `ingested_at` is set by the database.
  `observed_at` is a generated column, `COALESCE(measured_at, gateway_received_at, published_at, ingested_at)`,
  and `observed_at_source` records which one was used. `time_flags` records
  `no_gateway_clock`, `future_timestamp` and `late_delivery`.
- **Deduplication** uses identity, `boot_id` and `sequence`, never time.
- **Indexes.** `(device_id, observed_at DESC, id DESC)` serves latest, range and
  keyset-pagination queries. A BRIN index on `observed_at` serves retention
  scans. `(device_id, cell_index, observed_at DESC)` serves per-cell history.

## Column notes

- `gateway_status.retained` is the MQTT retain flag **as delivered to the backend**. Brokers set it only when
  replaying a stored retained message (e.g. after the backend re-subscribes), so a live status update arrives with
  `retained = false` even though the gateway published it as retained.
- `telemetry.id` values can have gaps: a duplicate insert consumes an identity value before `ON CONFLICT DO NOTHING`.
  Gaps are harmless; use `(device_id, boot_id, sequence)` to reason about completeness.
- The MPM summary's `cell_voltage_spread_mv_max` is derived by the backend (max − min per snapshot), in mV
  rounded to 0.1 mV. It is the only summary value not taken directly from BMS fields.

## Volume and retention

One gateway at 5 s produces ~17k telemetry rows/day (+4 cell rows each);
at 60 s, ~1.4k/day. A pilot fleet fits easily in a single table.
`npm run db:retention` deletes rows older than `RETENTION_DAYS` (default 365) in
5,000-row batches. It always keeps each device's latest metadata snapshot and
each gateway's latest status. **Scaling path:** convert `telemetry` to monthly
range partitions on `observed_at` (or TimescaleDB hypertables) and drop old
partitions instead of deleting rows. The schema is compatible with that change
because the deduplication key would just gain `observed_at`.

## Useful verification queries

```sql
-- tables and row counts
SELECT relname, n_live_tup FROM pg_stat_user_tables ORDER BY relname;

-- latest snapshot for a device, with identity and timestamps
SELECT t.id, d.external_id device, s.external_id site, g.external_id gateway,
       t.boot_id, t.sequence, t.delivery, t.measured_at, t.gateway_received_at,
       t.published_at, t.ingested_at, t.observed_at, t.observed_at_source,
       t.pack_voltage_v, t.pack_current_a, t.soc_pct, t.bms_state, t.error_flags, t.thingset
  FROM telemetry t JOIN devices d ON d.id = t.device_id
  JOIN sites s ON s.id = t.site_id JOIN gateways g ON g.id = t.gateway_id
 WHERE d.external_id = 'bms-001' ORDER BY t.observed_at DESC LIMIT 1;

-- per-cell voltages of that snapshot
SELECT cell_index, voltage_v FROM cell_measurements
 WHERE telemetry_id = (SELECT max(id) FROM telemetry) ORDER BY cell_index;

-- duplicates? (must return zero rows)
SELECT device_id, boot_id, sequence, count(*) FROM telemetry
 GROUP BY 1, 2, 3 HAVING count(*) > 1;

-- recent rejections
SELECT received_at, reason, topic, detail FROM ingest_rejections ORDER BY id DESC LIMIT 20;
```

## Relocating a device (preserves history)

```sql
BEGIN;
UPDATE device_site_assignments SET valid_to = now()
 WHERE device_id = (SELECT id FROM devices WHERE external_id = 'bms-001') AND valid_to IS NULL;
INSERT INTO device_site_assignments (device_id, site_id, valid_from, note)
SELECT d.id, s.id, now(), 'relocated' FROM devices d, sites s
 WHERE d.external_id = 'bms-001' AND s.external_id = 'site-002';
COMMIT;
```
