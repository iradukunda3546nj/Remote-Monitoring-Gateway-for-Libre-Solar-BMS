# Edge gateway (LILYGO T-Call ESP32 + SIM800L)

Not implemented yet. The gateway must implement the producer side of the
[BEMRA MQTT contract v1](../software/backend/docs/mqtt-contract.md):

* parse the Libre Solar ThingSet live report from UART;
* trim fixed-size arrays to the provisioned cell/thermistor count (declared in `meta`);
* add `device_id`, `gateway_id`, `site_id`, a random `boot_id` per boot and a per-boot `sequence`;
* fill `gateway_received_at` / `published_at` only once the clock is synchronised (NTP or GSM network time), otherwise `null`;
* buffer to flash while offline and publish the backlog on `…/replay`;
* set a retained Last Will on `…/gateways/{gateway_id}/status`.

Validate payloads against `software/backend/src/contracts/schemas/` before publishing.
