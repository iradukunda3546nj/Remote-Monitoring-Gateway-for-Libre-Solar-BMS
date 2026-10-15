# BEMRA: Battery Energy Monitoring & Remote Analytics

Open remote monitoring for **Libre Solar BMS C1** batteries (OSEAS 2026 hackathon).
**Start with the [project README](../README.md)**: architecture, MQTT contract, test results and setup.

```text
Libre Solar BMS C1 (or simulator) ──ThingSet/UART──> LILYGO T-Call ESP32 + SIM800L ──MQTT over GPRS──> Mosquitto
     ──> Node.js ingestion worker ──> PostgreSQL ──> REST API ──> Web dashboard
     Mosquitto ──> Home Assistant (MQTT discovery)
```

| Folder | Contents |
|---|---|
| [`edge-gateway-esp32-lilygo`](edge-gateway-esp32-lilygo) | ESP32 gateway firmware and the ThingSet BMS simulator |
| [`software/backend`](software/backend) | MQTT ingestion, PostgreSQL schema, REST API, HA discovery, tests, docs |
| [`software/frontend`](software/frontend) | React dashboard |

Run all three services with `npm start` from this folder.
