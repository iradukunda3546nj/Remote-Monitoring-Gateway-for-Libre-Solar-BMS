import { logger } from '../config/logger.js';

/** Error with an HTTP status and a stable machine-readable code. */
export class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message, details) => new HttpError(400, 'bad_request', message, details);
export const notFound = (message) => new HttpError(404, 'not_found', message);

export function notFoundHandler(req, _res, next) {
  next(new HttpError(404, 'route_not_found', `No route for ${req.method} ${req.path}`));
}

/** Centralised error handler: consistent JSON, no stack traces or SQL leaked to clients. */
export function errorHandler(err, req, res, _next) {
  if (err.type === 'entity.parse.failed') err = new HttpError(400, 'invalid_json', 'Request body is not valid JSON');
  if (err.type === 'entity.too.large') err = new HttpError(413, 'payload_too_large', 'Request body too large');

  if (err instanceof HttpError) {
    if (err.status >= 500) (req.log ?? logger).error({ err: err.message }, 'request failed');
    return res
      .status(err.status)
      .json({ error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } });
  }
  const unavailable = /ECONNREFUSED|timeout|Connection terminated/i.test(err.message ?? '') || /^(08|57P)/.test(err.code ?? '');
  (req.log ?? logger).error({ err: err.message, code: err.code }, 'unhandled error');
  if (unavailable) {
    return res.status(503).json({ error: { code: 'service_unavailable', message: 'Database temporarily unavailable' } });
  }
  return res.status(500).json({ error: { code: 'internal_error', message: 'Internal server error' } });
}
