# Deployment, security and known limitations

## Moving to hosted PostgreSQL (configuration only)

Set either `DATABASE_URL`, which takes precedence, or the `DB_*` variables:

```env
DATABASE_URL=postgres://bemra_app:<password>@db.example.com:5432/bemra_db
DB_SSL=true                     # verify server certificate (rejectUnauthorized: true)
DB_SSL_CA_FILE=certs/provider-ca.pem   # if the provider uses a private CA
```

`sslmode` in the URL is deliberately ignored, so certificate verification can
only be controlled through `DB_SSL`. `DB_SSL=no-verify` exists for diagnosis
only and must never be used in production. Run `npm run db:migrate` against the
hosted database; the same migration files apply unchanged.

## Least-privilege roles (required before deployment)

Local development uses `postgres`. In production, create separate roles:

```sql
-- owner: runs migrations only
CREATE ROLE bemra_owner LOGIN PASSWORD '<strong>';
ALTER DATABASE bemra_db OWNER TO bemra_owner;
-- (run migrations as bemra_owner)

-- runtime role used by the worker and the API
CREATE ROLE bemra_app LOGIN PASSWORD '<strong>';
GRANT CONNECT ON DATABASE bemra_db TO bemra_app;
GRANT USAGE ON SCHEMA public TO bemra_app;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO bemra_app;
GRANT INSERT ON telemetry, cell_measurements, bms_events, gateway_status, device_metadata, ingest_rejections TO bemra_app;
GRANT UPDATE ON devices, gateways TO bemra_app;          -- last_seen / metadata copy
GRANT DELETE ON ingest_rejections TO bemra_app;          -- bounded pruning
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO bemra_app;
```

Optionally, split the API into a read-only role with `SELECT` only. Retention
(`db:retention`) needs `DELETE` and should run under the owner role or a dedicated maintenance role.

## Private Mosquitto broker

- Listener on 8883 with TLS (`MQTT_PROTOCOL=mqtts`; `MQTT_CA_FILE` if a private CA).
- `allow_anonymous false`, password file or certificate auth, plus an ACL file, e.g.:
  ```text
  user gw-001
  topic write bemra/v1/+/bms-001/#
  topic write bemra/v1/+/gateways/gw-001/status
  user bemra-backend
  topic read bemra/v1/#
  ```
- Set `persistent_client_expiration` and `max_queued_messages` so the backend
  session survives restarts. These settings bound how long the backend may be offline without losing messages.

## HTTP API

- `API_KEYS` (comma-separated) is mandatory in production. Clients send `X-API-Key`.
  Keys are compared in constant time. All keys are read-only.
- Put the API behind a TLS-terminating reverse proxy (Caddy, nginx) and add rate limiting there.
- `CORS_ORIGINS` lists the dashboard origins. Requests without an `Origin` header (server-to-server) are allowed.
- There are no write endpoints: the API cannot change BMS configuration or inputs.

## Home Assistant

**Option A: REST sensors via the backend**

```yaml
rest:
  - resource: http://bemra-host:3000/api/v1/integrations/home-assistant/devices/bms-001
    headers: { X-API-Key: !secret bemra_api_key }
    scan_interval: 30
    sensor:
      - name: BMS SOC
        value_template: '{{ value_json.rSOC_pct }}'
        unit_of_measurement: '%'
        device_class: battery
      - name: BMS pack voltage
        value_template: '{{ value_json.rPackVoltage_V }}'
        unit_of_measurement: V
        device_class: voltage
      - name: BMS state
        value_template: '{{ value_json.bms_state_code }}'
```

**Option B: MQTT directly.** Home Assistant subscribes to
`bemra/v1/<site>/<device>/live` with `value_template: "{{ value_json.thingset.rSOC_pct }}"`.
MQTT auto-discovery (`homeassistant/…/config`) would be published by the gateway
or a small bridge; it is not part of this backend. Home Assistant never connects to PostgreSQL.

## MicroPowerManager

`/api/v1/integrations/mpm/devices/{id}/summary` provides 15‑min, hourly and
daily aggregates (SOC last/min/max, voltage and current ranges, cell spread,
max temperature, OR-ed error flags, event counts). This is an **adapter-facing,
provisional** shape. MPM's real integration requirements (plugin vs core API,
asset-metadata format) have not been verified yet.

## Known limitations

1. **No exactly-once guarantee.** It is at-least-once with idempotent storage. Data lost before it reaches the broker
   (gateway buffer overflow, power loss before flash write) cannot be recovered by the backend.
2. **Public test broker:** unauthenticated and shared; verified **not** to deliver messages queued for an
   offline persistent session, so messages published while the worker is down are lost there. A
   namespace is not security; anyone can inject well-formed messages for registered device IDs.
3. `measured_at` is always `null` with current Libre Solar firmware (no timestamp in ThingSet live reports).
4. `rBalancingStatus` is stored but not mapped to cells; the bit-to-cell mapping depends on the IC.
5. Envelope fields are strict: a gateway sending a new 1.x envelope field needs the backend updated first.
6. Pack/stack voltage naming follows the firmware as-is (see thingset-mapping.md).
7. One worker instance per MQTT client id. Horizontal scaling would need MQTT shared subscriptions (`$share/…`, MQTT 5).
8. Rate limiting and TLS termination for the HTTP API are expected from a reverse proxy.
