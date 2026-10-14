import express from 'express';
import cors from 'cors';
import { apiKeyAuth } from './middleware/auth.js';
import { errorHandler, notFoundHandler } from './middleware/errors.js';
import { requestLogger, securityHeaders } from './middleware/request-logger.js';
import { createDeviceService } from './services/device-service.js';
import { createDeviceController } from './controllers/device-controller.js';
import { createSystemController } from './controllers/system-controller.js';
import { createV1Router } from './routes/v1.js';

/**
 * Builds the Express application. Dependencies are injected so tests can run
 * the app in-process (supertest) without opening a network port.
 */
export function createApp({ db, config }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  app.set('query parser', 'simple'); // no nested objects from query strings

  app.use(requestLogger);
  app.use(securityHeaders);
  app.use(
    cors({
      origin: (origin, cb) => cb(null, !origin || config.http.corsOrigins.includes(origin)),
      methods: ['GET'],
      allowedHeaders: ['X-API-Key', 'Content-Type', 'X-Request-Id'],
      maxAge: 600,
    }),
  );
  app.use(express.json({ limit: '16kb' }));

  const system = createSystemController({ db, rootDir: config.rootDir });
  const devices = createDeviceController(createDeviceService({ db, staleAfterSeconds: config.ingestion.staleAfterSeconds }));

  app.get('/health', system.health);
  app.get('/ready', system.ready);
  app.use('/api/v1', apiKeyAuth(config.http.apiKeys), createV1Router({ devices, system }));

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
