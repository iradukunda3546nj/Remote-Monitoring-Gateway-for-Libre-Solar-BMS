import crypto from 'node:crypto';
import { logger } from '../config/logger.js';

/** Attaches req.log with a request id and logs one line per completed request. */
export function requestLogger(req, res, next) {
  const id = req.get('x-request-id')?.slice(0, 64) || crypto.randomUUID();
  const start = process.hrtime.bigint();
  req.log = logger.child({ reqId: id });
  res.setHeader('X-Request-Id', id);
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    req.log.info({ method: req.method, path: req.originalUrl.split('?')[0], status: res.statusCode, ms: Math.round(ms) }, 'request');
  });
  next();
}

/** Basic hardening headers (the API serves JSON only). */
export function securityHeaders(_req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  next();
}
