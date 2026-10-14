#!/usr/bin/env node
/**
 * Publishes Home Assistant discovery configs once (the worker also does this on
 * connect and every 5 minutes). Usage: npm run ha:discovery
 */
import mqtt from 'mqtt';
import { getConfig } from '../src/config/index.js';
import { closePool, getPool } from '../src/db/pool.js';
import { publishDiscovery } from '../src/integrations/ha-discovery.js';

const { mqtt: m } = getConfig();
const client = await mqtt.connectAsync({
  protocol: m.protocol,
  host: m.host,
  port: m.port,
  servername: m.host,
  rejectUnauthorized: true,
  ...(m.ca ? { ca: m.ca } : {}),
  username: m.username,
  password: m.password,
  clientId: `bemra-ha-discovery-${process.pid}`,
  protocolVersion: 4,
  reconnectPeriod: 0,
});
try {
  const r = await publishDiscovery(client, getPool(), {
    topicRoot: m.topicRoot,
    prefix: m.haDiscoveryPrefix,
    expireAfterS: getConfig().ingestion.staleAfterSeconds,
  });
  console.log(`Published ${r.configs} discovery configs for ${r.devices} device(s) under ${m.haDiscoveryPrefix}/`);
} catch (err) {
  console.error(`Discovery failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  await client.endAsync();
  await closePool();
}
