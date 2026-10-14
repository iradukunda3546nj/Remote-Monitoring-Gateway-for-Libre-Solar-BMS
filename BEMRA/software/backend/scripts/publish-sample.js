#!/usr/bin/env node
/**
 * Publishes a sample payload to the configured broker, on the topic derived
 * from the payload's identity (the same message MQTTX would send).
 *
 * Usage:
 *   npm run mqtt:publish-sample -- <kind> <file> [--sequence N] [--now] [--retain]
 *   kind: live | replay | meta | event | status
 * Examples:
 *   npm run mqtt:publish-sample -- live docs/samples/live.json --now
 *   npm run mqtt:publish-sample -- live docs/samples/live.json --sequence 2001 --now
 *   npm run mqtt:publish-sample -- status docs/samples/status-online.json --retain
 */
import fs from 'node:fs';
import mqtt from 'mqtt';
import { getConfig } from '../src/config/index.js';
import { deviceTopic, statusTopic } from '../src/contracts/topics.js';

const [kind, file, ...rest] = process.argv.slice(2);
if (!kind || !file) {
  console.error('Usage: publish-sample <live|replay|meta|event|status> <file.json> [--sequence N] [--now] [--retain]');
  process.exit(1);
}
const flag = (name) => rest.includes(name);
const option = (name) => {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : undefined;
};

const raw = fs.readFileSync(file, 'utf8');
let payload = raw;
let msg = null;
try {
  msg = JSON.parse(raw);
} catch {
  console.warn('File is not valid JSON; publishing it verbatim (useful for rejection tests).');
}
if (msg) {
  if (option('--sequence') !== undefined) msg.sequence = Number(option('--sequence'));
  if (flag('--now')) {
    const now = new Date().toISOString();
    if (msg.timestamps) msg.timestamps = { ...msg.timestamps, gateway_received_at: now, published_at: now };
    if ('published_at' in msg) msg.published_at = now;
  }
  payload = JSON.stringify(msg);
}

const { mqtt: m } = getConfig();
const site = msg?.site_id ?? 'site-001';
const topic =
  kind === 'status'
    ? statusTopic(m.topicRoot, site, msg?.gateway_id ?? 'gw-001')
    : deviceTopic(m.topicRoot, site, msg?.device_id ?? 'bms-001', kind);
const retain = flag('--retain');

const client = mqtt.connect({
  protocol: m.protocol,
  host: m.host,
  port: m.port,
  servername: m.host,
  rejectUnauthorized: true,
  ...(m.ca ? { ca: m.ca } : {}),
  username: m.username,
  password: m.password,
  clientId: `bemra-sample-publisher-${process.pid}`,
  protocolVersion: 4,
  connectTimeout: 20_000,
  reconnectPeriod: 0,
});
client.on('connect', () => {
  client.publish(topic, payload, { qos: 1, retain }, (err) => {
    if (err) console.error('Publish failed:', err.message);
    else console.log(`Published ${Buffer.byteLength(payload)} B to ${topic} (qos 1${retain ? ', retained' : ''})`);
    client.end();
    process.exitCode = err ? 1 : 0;
  });
});
client.on('error', (err) => {
  console.error('MQTT error:', err.message);
  client.end();
  process.exitCode = 1;
});
