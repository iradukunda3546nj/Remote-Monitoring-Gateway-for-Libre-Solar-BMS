import crypto from 'node:crypto';
import { HttpError } from './errors.js';

/**
 * API-key authentication via the `X-API-Key` header.
 * - production: API_KEYS is mandatory (enforced by config validation).
 * - development/test: enforced only when API_KEYS is set.
 * Keys are compared in constant time. All keys currently grant read-only
 * access; the API exposes no write path to BMS configuration.
 */
export function apiKeyAuth(keys) {
  const hashed = keys.map((k) => crypto.createHash('sha256').update(k).digest());
  return (req, _res, next) => {
    if (hashed.length === 0) return next();
    const presented = req.get('x-api-key');
    if (!presented) return next(new HttpError(401, 'unauthorized', 'Missing X-API-Key header'));
    const digest = crypto.createHash('sha256').update(presented).digest();
    if (!hashed.some((h) => crypto.timingSafeEqual(h, digest))) {
      return next(new HttpError(401, 'unauthorized', 'Invalid API key'));
    }
    return next();
  };
}
