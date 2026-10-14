// BEMRA gateway configuration: edit before flashing.
#pragma once

// Identity: must match the backend registry (device bms-001 -> gateway gw-001 -> site-001)
#define GATEWAY_ID "gw-001"
#define DEVICE_ID "bms-001"
#define SITE_ID "site-001"
#define TOPIC_ROOT "bemra-dev-01092a"  // same as MQTT_TOPIC_ROOT in the backend .env

// Pack layout: the gateway keeps only the connected cells/thermistors
#define CELL_COUNT 4
#define THERMISTOR_COUNT 2

// Airtel SIM (Rwanda). Verify the APN with Airtel; "internet" is the usual value.
#define GPRS_APN "internet"
#define GPRS_USER ""
#define GPRS_PASS ""

// Broker. SIM800L has no reliable modern TLS -> plain port 1883 for this demo.
#define MQTT_HOST "test.mosquitto.org"
#define MQTT_PORT 1883

// Demo rate: one telemetry message every 2 minutes (the simulator also reports every 2 min).
//   720 msgs/day x ~0.4 kB + keep-alive pings = roughly 15 MB per month on the SIM.
#define PUBLISH_INTERVAL_MS 120000UL

// MQTT keep-alive: the network path drops idle TCP connections after ~60 s
// (measured: publishes after a 120 s idle gap got no PUBACK). 45 s keeps the
// connection alive between the 2-min publishes for ~6 MB/month of pings.
#define MQTT_KEEPALIVE_S 45
#define MQTT_TIMEOUT_MS 15000  // max wait for CONNACK/PUBACK over GPRS
