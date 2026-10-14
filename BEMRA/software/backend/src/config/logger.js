import pino from 'pino';
import { getLogLevel } from './index.js';

/**
 * Structured JSON logger. Credentials are redacted defensively in case an
 * object containing them is ever logged.
 */
export const logger = pino({
  level: getLogLevel(),
  base: { service: 'bemra-backend' },
  redact: {
    paths: ['password', '*.password', 'db.password', 'mqtt.password', 'headers["x-api-key"]', 'req.headers["x-api-key"]'],
    censor: '[redacted]',
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});
