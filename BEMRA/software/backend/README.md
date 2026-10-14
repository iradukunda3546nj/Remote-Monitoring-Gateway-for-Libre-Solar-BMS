# BEMRA backend

MQTT ingestion worker, PostgreSQL persistence and read-only REST API for
**BEMRA (Battery Energy Monitoring & Remote Analytics)**: remote monitoring of
Libre Solar BMS C1 batteries via a LILYGO T-Call ESP32 gateway. Built for the
OSEAS 2026 hackathon.

> **Principle:** the gateway parses and normalises native ThingSet. The backend
> **validates, associates and stores**. It never rescales, renames or recomputes
> a BMS measurement. Every accepted measurement is traceable to its device,
> gateway, site, original ThingSet field, timestamps and database row.

## Quick start (Windows PowerShell)

```powershell
cd BEMRA\software\backend
npm install
copy .env.example .env      # skip if .env exists; then set DB_PASSWORD and a unique MQTT_TOPIC_ROOT
npm run db:check            # connectivity
npm run db:migrate          # create schema (idempotent)
npm run db:seed             # register site-001 / gw-001 / bms-001
npm test                    # unit + contract + integration tests
npm run start:worker        # terminal 1: MQTT → PostgreSQL
npm run start:api           # terminal 2: http://localhost:3000/api/v1
```

Then follow [docs/testing-e2e.md](docs/testing-e2e.md) (MQTTX → PostgreSQL → Postman).

## Requirements

Node.js ≥ 22.12 (developed on 24), PostgreSQL ≥ 15 (developed on 18), an MQTT
broker with TLS (development: `test.mosquitto.org:8886`).

## Scripts

| Command                                        | Purpose                                                     |
| ---------------------------------------------- | ----------------------------------------------------------- |
| `npm run start:worker` / `start:api`           | Run the ingestion worker / REST API (independent processes) |
| `npm run db:check`                             | Test the connection and list BEMRA tables with row counts   |
| `npm run db:migrate` / `db:status`             | Apply / inspect versioned migrations                        |
| `npm run db:seed`                              | Register the dev site, gateway and device                   |
| `npm run db:reset-test-data -- --yes`          | Delete data of dev fixtures only                            |
| `npm run db:retention [-- --dry-run]`          | Delete data older than `RETENTION_DAYS`                     |
| `npm run mqtt:check`                           | TLS broker round trip + contract validation (no DB needed)  |
| `npm run mqtt:publish-sample -- <kind> <file>` | Publish a sample message                                    |
| `npm test` · `test:unit` · `test:integration`  | Tests (`node:test`)                                         |
| `npm run lint` · `format`                      | ESLint / Prettier                                           |

## Configuration

See [`.env.example`](.env.example). Database precedence: `DATABASE_URL` overrides
`DB_*`. TLS verification is controlled only by `DB_SSL` (`false` | `true` | `no-verify`).
Moving to hosted PostgreSQL or a private Mosquitto broker is a configuration change; see
[docs/deployment-and-security.md](docs/deployment-and-security.md).

## API (v1, read-only)

| Endpoint                                              | Description                                                    |
| ----------------------------------------------------- | -------------------------------------------------------------- |
| `GET /health`, `GET /ready`                           | Liveness; readiness (DB + migrations)                          |
| `GET /api/v1/sites`                                   | Sites with location                                            |
| `GET /api/v1/devices[?site=]`                         | Devices with current site/gateway                              |
| `GET /api/v1/devices/:id`                             | Detail, assignment history, latest metadata                    |
| `GET /api/v1/devices/:id/status`                      | Gateway connectivity, freshness, BMS state, active faults      |
| `GET /api/v1/devices/:id/latest`                      | Latest measurements with units, timestamps, freshness          |
| `GET /api/v1/devices/:id/thingset`                    | Complete latest ThingSet object as stored                      |
| `GET /api/v1/devices/:id/cells`                       | Per-cell voltages + BMS min/max/avg                            |
| `GET /api/v1/devices/:id/telemetry`                   | History: raw (cursor-paginated) or `interval=1m…1d` aggregates |
| `GET /api/v1/devices/:id/events`                      | Fault/state events                                             |
| `GET /api/v1/integrations/home-assistant/devices/:id` | Flat state for HA RESTful sensors                              |
| `GET /api/v1/integrations/mpm/devices/:id/summary`    | 15m/hourly/daily summary (provisional)                         |
| `GET /api/v1/openapi.yaml` · `.json`                  | OpenAPI 3.1 spec ([docs/openapi.yaml](docs/openapi.yaml))      |

Responses: `{ "data": …, "meta": … }`. Errors: `{ "error": { "code", "message", "details?" } }`.

## Documentation

- [Architecture](docs/architecture.md)
- [MQTT contract v1](docs/mqtt-contract.md) + JSON Schemas in [`src/contracts/schemas`](src/contracts/schemas) + [samples](docs/samples)
- [ThingSet → MQTT → PostgreSQL mapping](docs/thingset-mapping.md) (verified against Libre Solar firmware)
- [Database schema](docs/database.md)
- [End-to-end test procedure](docs/testing-e2e.md) + [Postman collection](docs/postman/bemra.postman_collection.json)
- [Deployment, security, known limitations](docs/deployment-and-security.md)
- [Verification record (tests actually run)](docs/test-results.md)

## Project layout

```text
src/
  config/        env loading + validation, logger
  db/            pg pool, transactions, migration runner
  contracts/     ThingSet catalogue, MQTT topics, JSON Schemas (v1)
  validation/    payload + query validation
  ingestion/     ingest service, timestamp quality
  mqtt/          ingestion worker entry point
  repositories/  SQL (parameterised)
  services/      API read logic
  controllers/   HTTP adapters
  routes/        /api/v1 router
  middleware/    errors, auth, logging
  app.js         Express app factory
  server.js      API entry point
migrations/      versioned SQL
scripts/         db/mqtt tooling + fixtures
tests/           unit/ + integration/
docs/            documentation, OpenAPI, samples, Postman
```

## License

Apache-2.0 (same as the Libre Solar BMS firmware).
