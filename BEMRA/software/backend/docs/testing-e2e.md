# End-to-end test procedure

**MQTTX → Mosquitto (TLS) → ingestion worker → PostgreSQL → Express API → Postman**

All commands are for **Windows PowerShell** in `BEMRA\software\backend`.

## 0. One-time setup

```powershell
cd "C:\Users\jeanc\Box\Big-Projects\Battery Monitoring\BEMRA\software\backend"
npm install
# Enter your PostgreSQL password in .env (DB_PASSWORD=...). Never paste it in chat or commit it.
notepad .env
```

Note the `MQTT_TOPIC_ROOT` value in `.env` (e.g. `bemra-dev-01092a`). Every topic below starts with it.

## 1. Database connectivity, migrations, registry

```powershell
npm run db:check      # connects, prints server version, lists BEMRA tables
npm run db:migrate    # applies migrations (safe to repeat)
npm run db:status     # every migration should be "applied"
npm run db:seed       # registers site-001, gw-001, bms-001 (idempotent)
npm run db:check      # all tables present
```

## 2. Automated tests

```powershell
npm test              # unit + contract + integration (integration uses test-* fixtures and cleans up)
npm run lint
```

## 3. Broker round trip (no database needed)

```powershell
npm run mqtt:check    # TLS-verified connect, subscribe, publish, receive, validate
```

## 4. Start the services (two terminals)

```powershell
npm run start:worker  # terminal 1: expect "connected to MQTT broker" and "subscribed"
npm run start:api     # terminal 2: expect "BEMRA API listening" on port 3000
```

## 5. Publish with MQTTX

Connection: host `test.mosquitto.org`, port `8886`, protocol `mqtts://`, SSL/TLS **on**,
"CA signed server certificate", MQTT 3.1.1, no username.

| Step | Topic (replace `<root>`)                    | Payload file                                    | QoS | Retain |
| ---- | ------------------------------------------- | ----------------------------------------------- | --- | ------ |
| a    | `<root>/v1/site-001/gateways/gw-001/status` | `docs/samples/status-online.json`               | 1   | ✔      |
| b    | `<root>/v1/site-001/bms-001/meta`           | `docs/samples/meta.json`                        | 1   | ✔      |
| c    | `<root>/v1/site-001/bms-001/live`           | `docs/samples/live.json`                        | 1   |        |
| d    | same as c, **published again unchanged**    | `live.json`                                     | 1   |        |
| e    | `<root>/v1/site-001/bms-001/replay`         | `docs/samples/replay.json`                      | 1   |        |
| f    | `<root>/v1/site-001/bms-001/event`          | `docs/samples/event.json`                       | 1   |        |
| g    | `<root>/v1/site-001/bms-001/live`           | `docs/samples/invalid/bms-state-as-string.json` | 1   |        |
| h    | `<root>/v1/site-001/bms-001/live`           | text `{not json`                                | 1   |        |

Expected worker log lines: a–c, e, f → `stored`; d → nothing new (duplicate);
g → `message rejected` `schema_violation`; h → `invalid_json`. The worker keeps running.

Equivalent without MQTTX:

```powershell
npm run mqtt:publish-sample -- status docs/samples/status-online.json --retain
npm run mqtt:publish-sample -- meta   docs/samples/meta.json --retain
npm run mqtt:publish-sample -- live   docs/samples/live.json
npm run mqtt:publish-sample -- live   docs/samples/live.json          # duplicate
npm run mqtt:publish-sample -- replay docs/samples/replay.json
npm run mqtt:publish-sample -- event  docs/samples/event.json
npm run mqtt:publish-sample -- live   docs/samples/invalid/bms-state-as-string.json
```

Use `--sequence <n> --now` to publish additional, current samples.

## 6. Verify in PostgreSQL (pgAdmin Query Tool on bemra_db)

```sql
-- c) stored with complete ThingSet object, device/site/gateway and all timestamps
SELECT t.id, d.external_id device, s.external_id site, g.external_id gateway, t.delivery,
       t.boot_id, t.sequence, t.measured_at, t.gateway_received_at, t.published_at,
       t.ingested_at, t.observed_at_source, t.pack_voltage_v, t.soc_pct, t.bms_state, t.thingset
  FROM telemetry t JOIN devices d ON d.id=t.device_id JOIN sites s ON s.id=t.site_id
  JOIN gateways g ON g.id=t.gateway_id ORDER BY t.id DESC;

-- 4 cell rows for the live sample
SELECT telemetry_id, cell_index, voltage_v FROM cell_measurements ORDER BY telemetry_id DESC, cell_index;

-- d) no duplicates: must return zero rows
SELECT device_id, boot_id, sequence, count(*) FROM telemetry GROUP BY 1,2,3 HAVING count(*) > 1;

-- g, h) rejections recorded with reasons
SELECT received_at, reason, topic, detail FROM ingest_rejections ORDER BY id DESC LIMIT 10;

-- b) metadata applied to the device
SELECT external_id, firmware_version, cell_count, thermistor_count, chemistry, nominal_capacity_ah FROM devices;
```

## 7. Verify with Postman

Import `docs/postman/bemra.postman_collection.json`. Set `baseUrl` = `http://localhost:3000`
(and `apiKey` if `API_KEYS` is set). Requests:

| Request                                                                                                                  | Expect                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `GET /ready`                                                                                                             | 200, `migrations.ok: true`                                                                                         |
| `GET /api/v1/devices`                                                                                                    | `bms-001` with `site_id: site-001`, `gateway_id: gw-001`                                                           |
| `GET /api/v1/devices/bms-001/latest`                                                                                     | `rPackVoltage_V` 13.24 V, `bms_state.code` NORMAL, `observed_at` 14:30:00Z (the live sample, not the older replay) |
| `GET /api/v1/devices/bms-001/thingset`                                                                                   | object identical to `live.json` → `thingset`                                                                       |
| `GET /api/v1/devices/bms-001/cells`                                                                                      | 4 cells                                                                                                            |
| `GET /api/v1/devices/bms-001/telemetry?from=2026-10-09T00:00:00Z&to=2026-10-10T00:00:00Z&order=asc`                      | replay (14:18) then live (14:30)                                                                                   |
| `GET …/telemetry?from=2026-10-09T00:00:00Z&to=2026-10-10T00:00:00Z&interval=1h&fields=rSOC_pct,rPackVoltage_V`           | one bucket at 14:00 with min/avg/max                                                                               |
| `GET /api/v1/devices/bms-001/events?from=2026-10-09T00:00:00Z`                                                           | `BMS_ERR_CELL_UNDERVOLTAGE`                                                                                        |
| `GET /api/v1/devices/bms-001/status`                                                                                     | gateway `online`, `data_freshness.stale: true` (sample timestamps are in the past)                                 |
| `GET /api/v1/integrations/home-assistant/devices/bms-001`                                                                | flat object                                                                                                        |
| `GET /api/v1/integrations/mpm/devices/bms-001/summary?interval=hourly&from=2026-10-09T00:00:00Z&to=2026-10-10T00:00:00Z` | hourly buckets                                                                                                     |
| `GET /api/v1/devices/bms-404/latest`                                                                                     | 404, `error.code: not_found`                                                                                       |

## 8. Reset dev data (only the dev fixtures)

```powershell
npm run db:reset-test-data -- --yes              # telemetry/events/status/metadata of bms-001/gw-001
npm run db:reset-test-data -- --yes --rejections # also clears ingest_rejections
```

## Troubleshooting

| Symptom                                                      | Cause / fix                                                                                     |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `DB_PASSWORD is empty`                                       | Fill `DB_PASSWORD` in `.env`.                                                                   |
| `28P01 password authentication failed`                       | Wrong password or user.                                                                         |
| `ECONNREFUSED 127.0.0.1:5432`                                | PostgreSQL service stopped: `Get-Service postgresql*` / start it.                               |
| Worker never logs `stored`                                   | Topic root in MQTTX ≠ `MQTT_TOPIC_ROOT`; or device not seeded (`unknown_device` in rejections). |
| `site_mismatch`                                              | Message site ≠ the device's assignment at the message time (check `assigned_from`).             |
| `self-signed certificate` / TLS error                        | Wrong port (8886 = Let's Encrypt); for a private CA, set `MQTT_CA_FILE`.                        |
| Messages published while the worker was stopped never arrive | Expected on `test.mosquitto.org` (no offline queueing). Use a private broker.                   |
| Nothing received after restart                               | Another process uses the same `MQTT_CLIENT_ID` (the broker kicks duplicates).                   |
