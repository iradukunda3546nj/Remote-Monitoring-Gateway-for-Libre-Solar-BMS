# Backend architecture

```text
Libre Solar BMS C1 ──ThingSet/UART──▶ LILYGO T-Call ESP32 (gateway)
                                         │ parse + normalise + identity/time/sequence
                                         ▼ MQTT over TLS, QoS 1
                               Eclipse Mosquitto (broker)
                                         │ persistent session, QoS 1
                                         ▼
 ┌───────────────────────────── software/backend ─────────────────────────────┐
 │  src/mqtt/worker.js          ingestion worker  (npm run start:worker)       │
 │     └─ ingestion/ingest-service.js  validate → associate → persist → ack    │
 │  src/server.js + app.js      REST API          (npm run start:api)          │
 │     └─ routes → controllers → services → repositories                       │
 │  shared: config/, db/ (pool, migrator), contracts/ (ThingSet catalogue,     │
 │          JSON Schemas, topics), validation/, repositories/                  │
 └─────────────────────────────────────┬──────────────────────────────────────┘
                                       ▼
                                  PostgreSQL
                                       ▲
             BEMRA dashboard · Home Assistant (REST or MQTT) · MicroPowerManager adapter
```

## Responsibilities

| Layer           | Owns                                                                                                                                                                                     | Does not do                                     |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Gateway (ESP32) | ThingSet parsing, array trimming to provisioned layout, identity, `boot_id` / `sequence`, timestamps, offline buffering                                                                  | Persistence, history                            |
| Worker          | Topic routing, size limit, JSON parsing, schema validation, topic/payload identity check, device/site/gateway association at message time, transactional insert, dedup, ack after commit | Rescaling, renaming or recomputing measurements |
| API             | Read-only access, units, freshness, decoding of enums/bitmaps (raw value always included), aggregation, pagination                                                                       | Writing BMS configuration                       |
| PostgreSQL      | Integrity (FKs, checks, unique keys), complete JSONB record, typed columns                                                                                                               |                                                 |

## Processing of one message (worker)

1. `payload.length > 16 KiB` → reject `payload_too_large`.
2. Parse the topic (`contracts/topics.js`); anything outside the contract → `unknown_topic`.
3. `JSON.parse`, then JSON Schema validation (Ajv, strict, no coercion, no defaults).
4. Topic and payload identity must match.
5. In one transaction: resolve the device and the site/gateway assignment valid at the
   message time, then `INSERT … ON CONFLICT DO NOTHING` (dedup), then insert cell rows and update last-seen.
6. Commit, then PUBACK. Rejections are written to `ingest_rejections` and acknowledged.
7. Transient DB errors: retry with backoff (≤ `DB_RETRY_BUDGET_MS`). After that the
   worker disconnects **without acknowledging**, polls the DB, and reconnects. The broker redelivers.
8. Non-transient unexpected errors are recorded as `internal_error` and
   acknowledged, so one poison message cannot block the queue.

Messages are processed strictly one at a time, so memory is bounded. Ordering
across replays is not assumed; queries order by `observed_at`.

## Why these choices

- **Plain `pg` + SQL**, no ORM: the schema is small, and explicit SQL makes the
  integrity rules reviewable.
- **Own migration runner** (~100 lines): checksums, advisory lock, one
  transaction per migration, no extra dependency.
- **Ajv + JSON Schema files**: the same machine-readable contract can be used by
  the gateway team, CI, and any third-party consumer.
- **`node:test`** instead of a test framework; `supertest` runs the app in-process.
- **ES modules**, Node ≥ 22.12 (`process.loadEnvFile`).

Dependencies (runtime): `express`, `pg`, `mqtt`, `ajv`, `ajv-formats`, `pino`, `cors`, `yaml`.
