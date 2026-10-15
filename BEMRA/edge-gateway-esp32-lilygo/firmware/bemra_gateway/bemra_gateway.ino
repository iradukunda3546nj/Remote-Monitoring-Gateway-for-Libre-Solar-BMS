/*
 * BEMRA gateway: LILYGO T-Call ESP32 + SIM800L
 *
 * Reads ThingSet live reports from the BMS (or the Python simulator) on the USB
 * serial port:   #mLive {"Meas":{...}}
 * and publishes each one as it arrives, at most once per PUBLISH_INTERVAL_MS
 * (30 s demo / 120 s deployment, see config.h) over GPRS (MQTT contract v1):
 *   <root>/v1/<site>/<device>/live            QoS 1
 *   <root>/v1/<site>/gateways/<gw>/status     QoS 1, retained, Last Will = offline
 *
 * Deterministic: no delay(). loop() runs a millis()-based connection state
 * machine; every step checks a timer and returns. Library calls (GPRS attach,
 * MQTT connect, PUBACK wait) block only up to their own bounded timeouts.
 *
 * Libraries: TinyGSM, MQTT (by Joel Gaehwiler), ArduinoJson 7.  Board: ESP32 Dev Module.
 */
#include "config.h"

#define TINY_GSM_MODEM_SIM800
#include <ArduinoJson.h>
#include <MQTT.h>
#include <TinyGsmClient.h>
#include <Wire.h>
#include <esp_random.h>

// LILYGO T-Call pins
#define MODEM_RST 5
#define MODEM_PWKEY 4
#define MODEM_POWER_ON 23
#define MODEM_TX 27
#define MODEM_RX 26

HardwareSerial SerialAT(1);
TinyGsm modem(SerialAT);
TinyGsmClient net(modem);
MQTTClient mqtt(2048);

const String TOPIC_LIVE = String(TOPIC_ROOT) + "/v1/" + SITE_ID + "/" + DEVICE_ID + "/live";
const String TOPIC_STATUS = String(TOPIC_ROOT) + "/v1/" + SITE_ID + "/gateways/" + GATEWAY_ID + "/status";

// Connection state machine
enum State { POWER_ON, MODEM_INIT, WAIT_NETWORK, CONNECT_GPRS, CONNECT_MQTT, ONLINE };
const char *STATE_NAME[] = {"POWER_ON", "MODEM_INIT", "WAIT_NETWORK", "CONNECT_GPRS", "CONNECT_MQTT", "ONLINE"};
State state = POWER_ON;
uint32_t stateSince = 0;   // when the current state was entered
uint32_t nextAttempt = 0;  // earliest time for the next action in this state

char bootId[9];         // random per boot: (boot_id, sequence) makes every message unique
uint32_t sequence = 0;  // incremented per message; the backend ignores re-sent duplicates
String latestThingset;  // newest validated measurement object from the BMS
String unsent;          // built but not yet acknowledged by the broker (retried, never lost)
bool firstPublishDone = false;
uint32_t lastPublish = 0;

// Gateway logs start with "[gw]" so the simulator never treats them as ThingSet data.
#define LOG(fmt, ...) Serial.printf("[gw] " fmt "\n", ##__VA_ARGS__)

bool due(uint32_t t) { return (int32_t)(millis() - t) >= 0; }  // overflow-safe timer check

void enter(State s, uint32_t waitMs = 0) {
  if (s != state) LOG("state %s -> %s", STATE_NAME[state], STATE_NAME[s]);
  state = s;
  stateSince = millis();
  nextAttempt = millis() + waitMs;
}

// ---------------------------------------------------------------- BMS serial
// Keeps only measurement objects and trims the firmware's fixed-size arrays.
void onLiveReport(const char *json) {
  JsonDocument in;
  if (deserializeJson(in, json)) {
    LOG("invalid JSON from BMS");
    return;
  }
  JsonObject meas = in["Meas"];
  if (!meas["rPackVoltage_V"].is<float>() || !meas["rSOC_pct"].is<float>() || !meas["rCellVoltages_V"].is<JsonArray>()) {
    LOG("report missing required values");
    return;
  }
  JsonDocument out;
  for (JsonPair kv : meas) {
    const char *k = kv.key().c_str();
    int keep = !strcmp(k, "rCellVoltages_V") ? CELL_COUNT : !strcmp(k, "rCellTemps_degC") ? THERMISTOR_COUNT : -1;
    if (keep < 0) {
      out[k] = kv.value();
      continue;
    }
    JsonArray a = out[k].to<JsonArray>();
    for (int i = 0; i < keep && i < (int)kv.value().size(); i++) a.add(kv.value()[i]);
  }
  latestThingset = "";
  serializeJson(out, latestThingset);
}

void readSerial() {  // non-blocking: consumes only what has already arrived
  static String line;
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n') {
      line.trim();
      if (line.startsWith("#mLive ")) onLiveReport(line.c_str() + 7);
      line = "";
    } else if (line.length() < 2000) {
      line += c;
    }
  }
}

// ---------------------------------------------------------------- messages
String statusJson(bool online) {
  JsonDocument s;
  s["schema_version"] = "1.0";
  s["gateway_id"] = GATEWAY_ID;
  s["site_id"] = SITE_ID;
  s["state"] = online ? "online" : "offline";
  s["boot_id"] = bootId;
  String out;
  serializeJson(s, out);
  return out;
}

String telemetryJson() {
  JsonDocument m;
  m["schema_version"] = "1.0";
  m["device_id"] = DEVICE_ID;
  m["gateway_id"] = GATEWAY_ID;
  m["site_id"] = SITE_ID;
  m["boot_id"] = bootId;
  m["sequence"] = ++sequence;
  JsonObject ts = m["timestamps"].to<JsonObject>();
  ts["measured_at"] = nullptr;          // no clock on this demo gateway:
  ts["gateway_received_at"] = nullptr;  // the backend stamps the time of reception
  ts["published_at"] = nullptr;
  JsonDocument t;
  deserializeJson(t, latestThingset);
  m["thingset"] = t;
  String out;
  serializeJson(m, out);
  return out;
}

// ---------------------------------------------------------------- connection
void runConnection() {
  if (!due(nextAttempt)) return;

  switch (state) {
    case POWER_ON:  // T-Call: keep IP5306 boost on, power the SIM800L, give it 3 s
      Wire.begin(21, 22);
      Wire.beginTransmission(0x75);
      Wire.write(0x00);
      Wire.write(0x37);
      Wire.endTransmission();
      pinMode(MODEM_PWKEY, OUTPUT);
      pinMode(MODEM_RST, OUTPUT);
      pinMode(MODEM_POWER_ON, OUTPUT);
      digitalWrite(MODEM_PWKEY, LOW);
      digitalWrite(MODEM_RST, HIGH);
      digitalWrite(MODEM_POWER_ON, HIGH);
      SerialAT.begin(115200, SERIAL_8N1, MODEM_RX, MODEM_TX);
      enter(MODEM_INIT, 3000);
      break;

    case MODEM_INIT:
      if (modem.init()) {
        LOG("modem: %s", modem.getModemInfo().c_str());
        enter(WAIT_NETWORK);
      } else {
        LOG("modem not responding, retry in 5 s");
        nextAttempt = millis() + 5000;
      }
      break;

    case WAIT_NETWORK:  // poll registration every 2 s, give up after 2 min
      if (modem.isNetworkConnected()) {
        LOG("network registered, signal CSQ %d", modem.getSignalQuality());
        enter(CONNECT_GPRS);
      } else if (millis() - stateSince > 120000) {
        LOG("no network after 2 min, re-initialising modem");
        enter(MODEM_INIT);
      } else {
        nextAttempt = millis() + 2000;
      }
      break;

    case CONNECT_GPRS:
      if (modem.gprsConnect(GPRS_APN, GPRS_USER, GPRS_PASS)) {
        LOG("GPRS connected, IP %s", modem.getLocalIP().c_str());
        enter(CONNECT_MQTT);
      } else {
        LOG("GPRS failed (APN %s), retry in 10 s", GPRS_APN);
        enter(WAIT_NETWORK, 10000);
      }
      break;

    case CONNECT_MQTT: {
      if (!modem.isGprsConnected()) {
        enter(CONNECT_GPRS);
        break;
      }
      static String will;
      will = statusJson(false);
      mqtt.setWill(TOPIC_STATUS.c_str(), will.c_str(), true, 1);  // broker publishes this if we vanish
      if (mqtt.connect(GATEWAY_ID)) {
        mqtt.publish(TOPIC_STATUS, statusJson(true), true, 1);
        LOG("MQTT connected, telemetry to %s every %lu s", TOPIC_LIVE.c_str(), PUBLISH_INTERVAL_MS / 1000);
        enter(ONLINE);
      } else {
        static uint8_t failures = 0;
        LOG("MQTT connect failed (err %d), retry in 10 s", mqtt.lastError());
        nextAttempt = millis() + 10000;
        // err -3 (TCP connect failed) repeating = SIM800 socket stuck: reset the GPRS session
        if (++failures >= 3) {
          failures = 0;
          LOG("resetting GPRS session");
          net.stop();
          modem.gprsDisconnect();
          enter(CONNECT_GPRS, 2000);
        }
      }
      break;
    }

    case ONLINE:
      if (!mqtt.connected()) {
        LOG("MQTT connection lost");
        enter(CONNECT_MQTT);
      }
      break;
  }
}

// ---------------------------------------------------------------- telemetry
void runTelemetry() {
  // Publish each new BMS reading as soon as it arrives (first one as soon as data and
  // link exist), at most once per PUBLISH_INTERVAL_MS minus the jitter tolerance, so the
  // gateway stays in step with the BMS report clock. Old readings are never repeated.
  if (unsent.isEmpty() && latestThingset.length() &&
      (!firstPublishDone || millis() - lastPublish >= PUBLISH_INTERVAL_MS - PUBLISH_JITTER_MS) && state == ONLINE) {
    unsent = telemetryJson();
    latestThingset = "";
    lastPublish = millis();
    firstPublishDone = true;
  }
  // QoS 1: publish() returns true only after the broker's PUBACK.
  // Otherwise the message stays in "unsent" and is re-sent after reconnecting.
  if (unsent.length() && state == ONLINE) {
    if (mqtt.publish(TOPIC_LIVE, unsent, false, 1)) {
      LOG("published seq %lu (%u bytes), next in %lu s", (unsigned long)sequence, unsent.length(),
          PUBLISH_INTERVAL_MS / 1000);
      unsent = "";
    } else {
      LOG("no PUBACK, reconnecting and re-sending");
      mqtt.disconnect();
      enter(CONNECT_MQTT);
    }
  }
}

// ---------------------------------------------------------------- setup / loop
void setup() {
  Serial.setRxBufferSize(4096);  // holds several BMS reports during bounded library calls
  Serial.begin(115200);
  snprintf(bootId, sizeof(bootId), "%08lx", (unsigned long)esp_random());
  LOG("BEMRA gateway, boot %s, device %s", bootId, DEVICE_ID);
  mqtt.begin(MQTT_HOST, MQTT_PORT, net);
  mqtt.setOptions(MQTT_KEEPALIVE_S, true, MQTT_TIMEOUT_MS);  // clean session: publisher only
  enter(POWER_ON);
}

void loop() {
  readSerial();      // 1. take in BMS data
  runConnection();   // 2. advance the connection state machine
  if (state == ONLINE) mqtt.loop();  // 3. keep-alive handling
  runTelemetry();    // 4. publish on schedule
}
