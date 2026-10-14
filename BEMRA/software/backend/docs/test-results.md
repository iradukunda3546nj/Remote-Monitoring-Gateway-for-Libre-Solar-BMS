# Verification record: 2026-10-09

Environment: Windows 11, Node.js 24.21.0, PostgreSQL 18.6 (local `bemra_db`, user `postgres`),
broker `mqtts://test.mosquitto.org:8886` (MQTT 3.1.1, TLS verified: Let's Encrypt, CN=test.mosquitto.org),
topic root `bemra-dev-01092a`. Every result below comes from a command that was actually executed.

## Automated tests: `npm test`

56 tests, 56 passed, 0 failed, 0 skipped.

| Suite                                                         | Tests | Covers                                                                                                                                                                           |
| ------------------------------------------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| contract v1 (samples, telemetry rules, other kinds, identity) | 18    | every sample valid/invalid as documented; schema ⇔ verified ThingSet catalogue; nulls; uint ranges; arrays; timestamps; versioning; no payload mutation                          |
| topics, time quality, ThingSet decoding                       | 9     | topic parsing incl. removed `summary` and device-scoped `status`; no invented timestamps; enum/bitmap decoding incl. unknown bits                                                |
| configuration, query validation                               | 7     | `DATABASE_URL` precedence and `sslmode` stripping; required password; production API keys; time windows, field allow-list, cursors                                               |
| MQTT ingestion → PostgreSQL                                   | 10    | complete JSONB preserved; typed columns; cells; dedup; `sequence_conflict`; reboot; replay ordering; 7 rejection reasons; events; meta; status/LWT dedup; relocation history     |
| REST API                                                      | 12    | health/ready; sites/devices; latest (units, missing fields, freshness); thingset; cells; raw pagination; aggregation; events; HA; MPM; error codes; API key enforcement; OpenAPI |

Lint (`eslint .`) and formatting (`prettier --check .`): clean.

## Database (Stage 2)

- `npm run db:check` before migration: connected, 0 BEMRA tables; no pre-existing objects in `bemra_db`.
- `npm run db:migrate`: applied `0001_initial_schema.sql`. A second run reported "Database is up to date".
- `npm run db:seed` twice: one site/gateway/device and one assignment each (idempotent).
- `npm run db:check`: all 12 tables present.

## Broker round trip (Stage 4): `npm run mqtt:check`

TLS authorized, 5 subscriptions granted QoS 1. Valid `live.json` (596 B) validated; the
`rBmsState: "discharging"` variant was rejected (`/thingset/rBmsState must be integer`).

## Live end-to-end (Stage 7): worker + API + public broker

| Step | Published                | Worker result                                                                                            |
| ---- | ------------------------ | -------------------------------------------------------------------------------------------------------- |
| a    | status-online (retained) | stored `gateway_status`                                                                                  |
| b    | meta (retained)          | stored `device_metadata`; device updated (Libre Solar, BMS-C1, v23.1, 4 cells, 2 thermistors, LFP, 6 Ah) |
| c    | live seq 1052            | stored `telemetry` (+4 `cell_measurements`)                                                              |
| d    | same live again          | duplicate, no new row                                                                                    |
| e    | replay seq 1040          | stored (`delivery = replay`)                                                                             |
| f    | event                    | stored `bms_events` (`BMS_ERR_CELL_UNDERVOLTAGE`, critical)                                              |
| g    | `rBmsState` as string    | rejected `schema_violation`                                                                              |
| h    | `{not json`              | rejected `invalid_json`                                                                                  |
| i    | device `bms-404`         | rejected `unknown_device`                                                                                |

SQL checks: the stored `thingset` is deep-equal to the published object (14 keys);
device/site/gateway association is correct; `measured_at` is NULL, other timestamps are preserved;
`observed_at_source = gateway`; duplicate query returned 0 rows; 3 rejection rows.

API checks (HTTP against the running server, same requests as the Postman collection): all 13
returned the expected status and data. `latest` returned the live sample (14:30Z), not the
older replay (14:18Z). Raw history was ordered replay → live. The 1 h aggregate had 2 samples.
Unknown device → 404. Malformed `from` → 400.

## Reliability experiments

| Experiment                                                                                               | Result                                                                                                      |
| -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Public broker: subscriber offline (clean=false), QoS 1 publish, reconnect (plain mqtt.js, no BEMRA code) | `sessionPresent=true`, **message not delivered**: public broker limitation                                  |
| Local broker (Aedes): worker killed with `kill -9`, 2 messages published, worker restarted               | `sessionPresent=true`, both stored                                                                          |
| Database outage (TCP proxy to PostgreSQL removed while running, retry budget 3 s)                        | retries 250→2000 ms; disconnected **without PUBACK**; DB restored → reconnect → broker redelivered → stored |

## Keep-alive investigation (follow-up, same day)

Symptom: the worker's connection dropped every ~60–120 s and reconnected after 2 s.
Probe with 3 plain mqtt.js clients for 5 min: keep-alive 60 s (clean true/false) closed by the peer at
60.8 s and 123.5 s; keep-alive 30 s never dropped. No `Keepalive timeout` was raised client-side, so the
peer (broker or network) closed idle connections at ~60 s. Fix: default `MQTT_KEEPALIVE_S=30`. The real
worker then held a single connection for 3.5 min with no drops.

## Not verified in this session

- Graceful shutdown on SIGINT/SIGTERM (Windows background processes were stopped forcibly).
- Hosted PostgreSQL with TLS (`DB_SSL=true`) and a private authenticated Mosquitto broker.
- MQTTX GUI itself: the identical messages were published with `npm run mqtt:publish-sample`.
- Postman GUI itself: the identical requests were sent over HTTP; the collection is provided for manual runs.
