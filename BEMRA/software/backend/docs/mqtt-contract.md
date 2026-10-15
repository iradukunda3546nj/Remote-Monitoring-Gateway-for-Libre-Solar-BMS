# BEMRA MQTT Contract v1

Status: **v1.0, agreed 2026-10-09**. Machine-readable schemas: [`src/contracts/schemas/`](../src/contracts/schemas/).

The ESP32 gateway is the **authoritative producer**: it parses native ThingSet from
the Libre Solar BMS UART, trims fixed-size firmware arrays to the provisioned
pack layout, and adds identity, timestamps and sequence metadata. The backend
is a **validating consumer**: it validates, associates and stores, and never rescales,
renames or recomputes a measurement.

## 1. Topics

`{root}` is configurable (`MQTT_TOPIC_ROOT`). Production: `bemra`. On the public
test broker, use a unique namespace such as `bemra-dev-01092a`. A namespace
reduces accidental collisions only. **It is not security**: anyone can read and
publish on `test.mosquitto.org`.

| Topic                                              | Purpose                                  | Publisher              | Subscribers            | QoS | Retain  | Frequency                                           | Typical size                      |
| -------------------------------------------------- | ---------------------------------------- | ---------------------- | ---------------------- | --- | ------- | --------------------------------------------------- | --------------------------------- |
| `{root}/v1/{site_id}/{device_id}/live`             | ThingSet Meas snapshot                   | gateway                | backend, HA (optional) | 1   | no      | Wi‑Fi: 5 s · GPRS: 60–120 s (BEMRA firmware: 120 s) | ~590 B (4S), +~6 B per extra cell |
| `{root}/v1/{site_id}/{device_id}/replay`           | Snapshots buffered while offline         | gateway                | backend                | 1   | no      | after reconnect, throttled                          | ~540–590 B each                   |
| `{root}/v1/{site_id}/{device_id}/meta`             | Device group, Conf snapshot, pack layout | gateway                | backend, HA            | 1   | **yes** | boot + on change                                    | ~660 B (with 6 Conf values)       |
| `{root}/v1/{site_id}/{device_id}/event`            | Fault raise/clear, state transitions     | gateway                | backend, HA            | 1   | no      | on change                                           | ~430 B                            |
| `{root}/v1/{site_id}/gateways/{gateway_id}/status` | Gateway online/offline, link quality     | gateway (+ broker LWT) | backend, HA            | 1   | **yes** | connect, every 15 min, LWT                          | ~260 B (LWT ~110 B)               |

`gateways` is a reserved word: it can never be a `device_id`.

**Changes from the preliminary brief (accepted 2026-10-09):**

1. The gateway no longer publishes `summary`. The backend computes 15‑min, hourly
   and daily summaries from stored telemetry, which saves GPRS data.
2. `status` moved to a gateway-scoped topic, because connectivity belongs to
   the ESP32, not the BMS.

### Bandwidth (GPRS)

At 60 s on GPRS: 1,440 live messages/day × ~590 B ≈ 0.85 MB/day (sizes measured on the minified samples in `docs/samples/`) before TCP/TLS
overhead. MQTT keep-alive (60 s) and TLS record overhead add roughly 30–40 %, so
the total is about 1.1 MB/day, or **≈ 35 MB/month** per gateway. At 5 s the volume
would be 12× larger, so the gateway must switch to the slower rate on GPRS.
QoS 1 adds one 4-byte PUBACK per message.

## 2. Common envelope (live, replay, meta, event)

| Field                            | Type                        | Required | Meaning                                                                                                                  |
| -------------------------------- | --------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------ |
| `schema_version`                 | string `1.N`                | yes      | Contract version. v1 consumers accept any `1.x`.                                                                         |
| `device_id`                      | id                          | yes      | BMS identifier. Must equal the topic segment.                                                                            |
| `gateway_id`                     | id                          | yes      | ESP32 identifier.                                                                                                        |
| `site_id`                        | id                          | yes      | Installation site. Must equal the topic segment.                                                                         |
| `boot_id`                        | string 4–64 `[A-Za-z0-9_-]` | yes      | Random value generated at every gateway boot.                                                                            |
| `sequence`                       | uint32                      | yes      | Per-boot counter shared by all message kinds, incremented for every message, including buffered ones.                    |
| `timestamps.measured_at`         | RFC 3339 or `null`          | yes      | Time the BMS measured the value. **The Libre Solar ThingSet live report carries no timestamp, so this is `null` today.** |
| `timestamps.gateway_received_at` | RFC 3339 or `null`          | yes      | Gateway clock when the UART report arrived; `null` until NTP or network time is synchronised.                            |
| `timestamps.published_at`        | RFC 3339 or `null`          | yes      | Gateway clock at (re)publication.                                                                                        |

`id` = `^[a-z0-9][a-z0-9-]{1,62}$`. Timestamps must carry an explicit offset;
use UTC `Z`. Unknown envelope fields are rejected.

### Identity and deduplication

`(device_id, boot_id, sequence)` identifies a message uniquely. The backend
stores each key once and ignores identical redeliveries. A **different**
payload under an already-used key is rejected as `sequence_conflict`, because
it indicates a gateway bug. Timestamps are never used for deduplication.

## 3. `thingset` object (live, replay)

Keys and units are exactly those of the Libre Solar firmware
(`LibreSolar/bms-firmware` main@779d201, `app/src/data_objects.c`). See
[thingset-mapping.md](thingset-mapping.md).

- **Required:** `rPackVoltage_V`, `rSOC_pct`, `rErrorFlags`, `rBmsState`, `rCellVoltages_V`.
  These are compiled unconditionally in the firmware.
- **Optional:** every other Meas object, some of which exist only in certain
  firmware builds (`CONFIG_BMS_IC_SWITCHES`, `CONFIG_BMS_IC_SHUNT_TEMP`).
- **Absent key** = not reported or not supported by this firmware build.
  **`null`** = reported, but the gateway judged the reading invalid.
  Integer bitmaps and enums (`rErrorFlags`, `rBmsState`, `rBalancingStatus`)
  are never `null`; if they are invalid, the gateway omits them (and `rErrorFlags`/`rBmsState` are required).
- **Types:** `rErrorFlags` and `rBalancingStatus` are uint32 integers. `rBmsState` is a uint8 integer
  (0 OFF, 1 CHG, 2 DIS, 3 NORMAL, 4 SHUTDOWN), **not** a string.
- **Sign convention:** `rPackCurrent_A` is positive while **charging** (firmware definition).
- **Arrays:** the firmware buffers are fixed size (16 cells on bq769x2, 3 thermistors).
  The gateway trims `rCellVoltages_V` to `layout.cell_count` and `rCellTemps_degC` to
  `layout.thermistor_count`, as declared in `meta`. Element _i_ (0-based) is cell _i+1_.
  `rCellTemps_degC` is per **thermistor**, not per cell. Limits: 1–32 cells, 0–16 thermistors.
- **Extra keys:** any further read-only object matching `^r[A-Z][A-Za-z0-9]*(_unit)?$`
  is accepted and preserved unchanged, for forward compatibility. Writable
  objects (`s…`, `w…`, `x…`) are rejected in telemetry.
- **Bounds:** the schema rejects physically impossible values (e.g. cell > 10 V,
  SOC outside 0–100). These are corruption guards, not alarm limits.

## 4. `meta` (retained)

`device` (ThingSet Device group: `cManufacturer`, `cDeviceType`, `cHardwareVersion`,
`cFirmwareVersion`), optional `conf` (read-only snapshot of `s…` Conf objects),
required `layout {cell_count, thermistor_count, chemistry?}`, optional `gateway
{model, firmware_version}`. See `docs/samples/meta.json`.

## 5. `event`

`event {code, severity: critical|warning|info, state: raised|cleared|instant, message?}`
and an optional `thingset` snapshot. Recommended codes: the firmware's `BMS_ERR_*`
names for each `rErrorFlags` bit change, `BMS_STATE_CHANGE`, and `GATEWAY_*` for
gateway conditions (e.g. `GATEWAY_BUFFER_OVERFLOW`).

## 6. `status` (retained, Last Will)

On connect, the gateway sets its Last Will to
`{"schema_version":"1.0","gateway_id":…,"site_id":…,"state":"offline","boot_id":…}`
(retained, QoS 1). It then publishes a retained `online` status with `sequence`,
`published_at`, `link {type, rssi_dbm}`, `uptime_s`, `buffered_messages` and
`firmware_version`, and refreshes it every 15 minutes.

## 7. Delivery guarantees and their limits

- Gateway → broker: QoS 1 is at-least-once **only while the gateway is
  connected**. While offline, the gateway must buffer in flash and publish on
  `replay` after reconnecting. That buffer's size limit is the real durability
  limit; overflow must be reported with a `GATEWAY_BUFFER_OVERFLOW` event.
- Broker → backend: the worker uses a persistent session (`clean=false`, fixed
  client id; `MQTT_CLEAN_SESSION=true` switches to a clean session) and QoS 1 subscriptions, and sends PUBACK **only after the
  PostgreSQL transaction commits**. While the backend is down, the broker queues
  messages for the session. Queue limits are broker-specific.
  **Verified 2026-10-09:** `test.mosquitto.org` resumes the session
  (`sessionPresent=true`) but does **not** deliver QoS 1 messages published
  while the subscriber was offline. Use a private Mosquitto broker
  (`max_queued_messages`, `persistent_client_expiration`) for any test that
  depends on offline queueing. See [test-results.md](test-results.md).
  **Verified 2026-10-10:** on `test.mosquitto.org` a persistent session stopped receiving
  messages altogether while a clean session with the same filters received them, so the
  development `.env` uses `MQTT_CLEAN_SESSION=true` there.
- Redelivery creates duplicates, and the unique key absorbs them. Overall the
  system is **at-least-once with idempotent storage**. It is not exactly-once,
  and a message lost before it reaches the broker cannot be recovered by the backend.
- Ordering is not guaranteed across reconnects or replay. Consumers order by
  `observed_at`, never by arrival.

## 7a. Keep-alive and idle timeouts

Each hop that tracks connections (NAT, firewall, mobile carrier gateway, broker
front-end) may close a TCP connection that has been idle for longer than its own
timeout, regardless of the MQTT keep-alive. The keep-alive must therefore be
**well below** the shortest idle timeout on the path, not equal to it.

Measured 2026-10-09 against `test.mosquitto.org:8886`: idle connections were
closed by the peer after ~60 s. With `keepalive = 60` the client's PINGREQ lost
the race and the connection dropped every 60–120 s. With `keepalive = 30` the
connection stayed up indefinitely. Defaults: **backend 30 s** (`MQTT_KEEPALIVE_S`).
**Gateway on GPRS:** start at 30–45 s and measure on the real SIM/carrier.
Each PINGREQ/PINGRESP pair costs roughly 100–150 B over TLS/TCP (≈ 0.3–0.4 MB/day
at 30 s). The worker logs `connection closed by broker or network` with the
connection age whenever the remote side closes a connection.

## 8. Validation failures

Rejected messages are acknowledged (so they cannot block the queue) and recorded
in `ingest_rejections` (bounded, payload excerpt ≤ 2 KiB). Reasons:
`payload_too_large` (> 16 KiB), `unknown_topic`, `invalid_json`, `schema_violation`,
`identity_mismatch`, `unknown_device`, `device_not_active`, `site_mismatch`,
`gateway_mismatch`, `unknown_gateway`, `unknown_site`, `sequence_conflict`, `internal_error`.

Site and gateway checks use the assignment that was valid **at the message's
time**. Buffered data recorded before a relocation is therefore still accepted
under the old site.

## 9. Schema evolution

- **Minor (1.x):** may add optional envelope fields or new `r…` ThingSet objects.
  New `r…` objects are accepted by existing backends automatically. A new
  envelope field requires deploying the backend before the gateway, because
  envelopes are strict.
- **Major (2.0):** any breaking change uses a new topic version segment (`/v2/`),
  so v1 and v2 can run side by side during migration.
