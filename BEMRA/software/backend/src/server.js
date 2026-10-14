#!/usr/bin/env node
/** BEMRA REST API entry point (independently startable: `npm run start:api`). */
import { createApp } from './app.js';
import { describeConfig, getConfig } from './config/index.js';
import { logger } from './config/logger.js';
import { closePool, getPool } from './db/pool.js';

const config = getConfig();
const app = createApp({ db: getPool(), config });

const server = app.listen(config.http.port, () => {
  logger.info({ port: config.http.port, config: describeConfig() }, 'BEMRA API listening');
});
server.keepAliveTimeout = 65_000;

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, 'shutting down API');
  const force = setTimeout(() => process.exit(1), 10_000);
  force.unref();
  server.close(async () => {
    await closePool();
    logger.info('API stopped');
    process.exit(0);
  });
  server.closeIdleConnections();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
