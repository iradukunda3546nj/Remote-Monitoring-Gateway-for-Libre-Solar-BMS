#!/usr/bin/env node
/**
 * Broker round-trip check (no database needed):
 *   1. connect over TLS with certificate verification
 *   2. subscribe to the contract topics under MQTT_TOPIC_ROOT
 *   3. publish docs/samples/live.json (unique sequence) and an invalid payload
 *   4. receive both back, parse the topic and validate exactly as the worker does
 * Usage: npm run mqtt:check
 */
import fs from 'node:fs';
import path from 'node:path';
import mqtt from 'mqtt';
import { getConfig } from '../src/config/index.js';
import { deviceTopic, parseTopic, subscriptionFilters } from '../src/contracts/topics.js';
import { checkIdentity, validatePayload } from '../src/validation/contract-validator.js';

const { mqtt: m, rootDir } = getConfig();
const live = JSON.parse(fs.readFileSync(path.join(rootDir, 'docs/samples/live.json'), 'utf8'));
live.sequence = Math.floor(Date.now() / 1000) % 4294967295;
live.boot_id = `check${process.pid}`;
const topic = deviceTopic(m.topicRoot, live.site_id, live.device_id, 'live');
const invalid = { ...live, thingset: { ...live.thingset, rBmsState: 'discharging' } };

const client = mqtt.connect({
  protocol: m.protocol,
  host: m.host,
  port: m.port,
  servername: m.host,
  rejectUnauthorized: true,
  ...(m.ca ? { ca: m.ca } : {}),
  username: m.username,
  password: m.password,
  clientId: `bemra-mqtt-check-${process.pid}`,
  protocolVersion: 4,
  clean: true,
  connectTimeout: 20_000,
  reconnectPeriod: 0,
});

const results = [];
const timer = setTimeout(() => finish('timeout waiting for messages'), 20_000);

function finish(error) {
  clearTimeout(timer);
  client.end();
  console.table(results);
  if (error || results.length < 2) {
    console.error(`MQTT check FAILED: ${error ?? 'not all messages received'}`);
    process.exitCode = 1;
  } else {
    console.log('MQTT check passed.');
  }
}

client.on('connect', () => {
  const tls = client.stream?.getPeerCertificate?.();
  console.log(`Connected to ${m.protocol}://${m.host}:${m.port} (TLS authorized: ${client.stream?.authorized ?? 'n/a'})`);
  if (tls?.subject)
    console.log(`Broker certificate: CN=${tls.subject.CN}, issuer=${tls.issuer?.O ?? tls.issuer?.CN}, valid to ${tls.valid_to}`);
  client.subscribe(Object.fromEntries(subscriptionFilters(m.topicRoot).map((t) => [t, { qos: 1 }])), (err, granted) => {
    if (err) return finish(`subscribe failed: ${err.message}`);
    console.log('Subscribed:', granted.map((g) => `${g.topic} (qos ${g.qos})`).join(', '));
    client.publish(topic, JSON.stringify(live), { qos: 1 });
    client.publish(topic, JSON.stringify(invalid), { qos: 1 });
  });
});

client.on('message', (t, payload) => {
  const route = parseTopic(m.topicRoot, t);
  let msg;
  try {
    msg = JSON.parse(payload.toString());
  } catch {
    return;
  }
  if (msg.boot_id !== live.boot_id) return; // ignore other traffic in the namespace
  const v = validatePayload(route?.kind, msg);
  results.push({
    topic: t,
    bytes: payload.length,
    kind: route?.kind,
    valid: v.ok,
    identity_ok: route ? checkIdentity(route, msg).length === 0 : false,
    first_error: v.ok ? '' : `${v.errors[0].path} ${v.errors[0].message}`,
  });
  if (results.length === 2) finish();
});
client.on('error', (err) => finish(err.message));
