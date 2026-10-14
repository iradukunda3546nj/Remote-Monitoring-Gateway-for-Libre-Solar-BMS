# BEMRA: Battery Energy Monitoring & Remote Analytics

Open remote monitoring for **Libre Solar BMS C1** batteries (OSEAS 2026 hackathon).

```text
Libre Solar BMS C1 ──ThingSet/UART──▶ LILYGO T-Call ESP32 + SIM800L ──MQTT/TLS──▶ Mosquitto
     ──▶ Node.js ingestion worker ──▶ PostgreSQL ──▶ REST API ──▶ Dashboard · Home Assistant · MicroPowerManager
```

| Folder | Status |
|---|---|
| [`software/backend`](software/backend) | MQTT ingestion, PostgreSQL schema, REST API, tests, docs |
| [`edge-gateway-esp32-lilygo`](edge-gateway-esp32-lilygo) | Planned: ESP32 gateway firmware implementing the [MQTT contract](software/backend/docs/mqtt-contract.md) |

Start with [software/backend/README.md](software/backend/README.md).
