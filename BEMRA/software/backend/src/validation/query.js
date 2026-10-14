/**
 * Validation of HTTP query parameters. Every value that reaches SQL is either
 * a bound parameter or selected from an allow-list defined here.
 */
import { MEAS_OBJECTS } from '../contracts/thingset.js';
import { badRequest } from '../middleware/errors.js';

const ID_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/;

export function parseId(value, name) {
  if (!ID_RE.test(value ?? '')) throw badRequest(`Invalid ${name}`, { [name]: value });
  return value;
}

function parseTime(value, name) {
  if (!ISO_RE.test(value)) throw badRequest(`${name} must be an ISO 8601 timestamp with offset, e.g. 2026-10-09T14:00:00Z`);
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw badRequest(`${name} is not a valid date`);
  return d;
}

/** from/to window (half-open [from, to)). Defaults to the last `defaultHours`. */
export function parseRange(query, { defaultHours = 24, maxDays = 366 } = {}) {
  const to = query.to ? parseTime(query.to, 'to') : new Date();
  const from = query.from ? parseTime(query.from, 'from') : new Date(to.getTime() - defaultHours * 3600_000);
  if (from >= to) throw badRequest('from must be earlier than to');
  if (to - from > maxDays * 86_400_000) throw badRequest(`Time range may not exceed ${maxDays} days`);
  return { from, to };
}

export function parseOrder(value, fallback = 'desc') {
  const v = value ?? fallback;
  if (v !== 'asc' && v !== 'desc') throw badRequest('order must be asc or desc');
  return v;
}

export function parseLimit(value, { fallback = 500, max = 5000 } = {}) {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > max) throw badRequest(`limit must be an integer between 1 and ${max}`);
  return n;
}

export function encodeCursor(row) {
  return Buffer.from(JSON.stringify({ t: new Date(row.observed_at).toISOString(), id: row.id })).toString('base64url');
}

export function parseCursor(value) {
  if (value === undefined) return null;
  try {
    const { t, id } = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!ISO_RE.test(t) || !Number.isSafeInteger(id)) throw new Error('shape');
    return { observedAt: new Date(t), id };
  } catch {
    throw badRequest('Invalid cursor');
  }
}

/** Aggregation intervals in seconds. `raw` = no aggregation. */
export const INTERVALS = Object.freeze({ raw: 0, '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '6h': 21600, '1d': 86400 });

export function parseInterval(value, fallback = 'raw', allowed = Object.keys(INTERVALS)) {
  const v = value ?? fallback;
  if (!allowed.includes(v)) throw badRequest(`interval must be one of ${allowed.join(', ')}`);
  return { name: v, seconds: INTERVALS[v] };
}

/** ThingSet names that have a typed scalar column (selectable as `fields`). */
export const FIELD_COLUMNS = Object.freeze(
  Object.fromEntries(MEAS_OBJECTS.filter((o) => o.column && !o.type.endsWith('[]')).map((o) => [o.name, o.column])),
);
/** Fields for which min/avg/max aggregation is physically meaningful (not bitmaps/enums). */
export const AGGREGATABLE = Object.freeze(
  Object.keys(FIELD_COLUMNS).filter((n) => !['rErrorFlags', 'rBmsState', 'rBalancingStatus'].includes(n)),
);

export function parseFields(value, { aggregated }) {
  const allowed = aggregated ? AGGREGATABLE : Object.keys(FIELD_COLUMNS);
  if (value === undefined) return allowed;
  const names = String(value)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const unknown = names.filter((n) => !allowed.includes(n));
  if (unknown.length || names.length === 0) {
    throw badRequest(`Unknown or non-${aggregated ? 'aggregatable' : 'selectable'} fields`, { unknown, allowed });
  }
  return [...new Set(names)];
}
