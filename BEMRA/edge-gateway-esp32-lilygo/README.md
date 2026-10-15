# Edge gateway (LILYGO T-Call ESP32 + SIM800L)

The gateway reads Libre Solar ThingSet live reports from its serial port and publishes them over
GPRS as `live` messages of the [BEMRA MQTT contract v1](../software/backend/docs/mqtt-contract.md).
The full description (state machine, design choices and test status) is in the
[project README](../../README.md#esp32-cellular-gateway-firmware).

| Folder | Contents |
|---|---|
| [`firmware/bemra_gateway/`](firmware/bemra_gateway) | Arduino sketch. Edit [`config.h`](firmware/bemra_gateway/config.h) (IDs, APN, broker, cell count) before flashing. |
| [`simulator/`](simulator) | [`thingset_bms_sim.py`](simulator/thingset_bms_sim.py): a stand-in for the BMS serial port (LiFePO4 model, ThingSet text mode) |

## Quick start

1. Arduino IDE → board *ESP32 Dev Module* (ESP32 core 3.x). Libraries: TinyGSM, MQTT (Joel Gaehwiler), ArduinoJson 7.
2. Open `firmware/bemra_gateway/bemra_gateway.ino`, check `config.h`, and flash it.
3. Close the Serial Monitor, then run the simulator on the same port:
   ```powershell
   cd simulator
   pip install -r requirements.txt
   py thingset_bms_sim.py --port COM3
   ```
   Gateway log lines (`[gw] …`) appear in the same window.

## Implemented vs. contract

| Contract feature | Firmware |
|---|---|
| `live` telemetry, QoS 1, retried until PUBACK | Yes, every 120 s |
| `status` online (retained) + Last Will offline | Yes, on connect |
| Array trimming to the connected cells/thermistors | Yes |
| Random `boot_id` per boot + per-boot `sequence` | Yes |
| Timestamps from a synced clock (NTP / GSM time) | No, sent as `null` |
| Flash buffer + `replay` after an outage | No |
| `meta` at boot, `event` on fault changes, 15-min status heartbeat | No |
| TLS to the broker | No (SIM800L limitation; plain port 1883) |
