/**
 * Validates MQTT payloads against the machine-readable JSON Schemas in
 * src/contracts/schemas. Validation never mutates or coerces the payload:
 * the backend is a validating consumer, not a second normaliser.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const SCHEMA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'contracts', 'schemas');
const loadSchema = (file) => JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, file), 'utf8'));

const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  allowUnionTypes: true, // intentional: nullable measurements are ["number", "null"]
  coerceTypes: false,
  useDefaults: false,
  removeAdditional: false,
});
addFormats(ajv, ['date-time']);
ajv.addSchema(loadSchema('common.schema.json'));

const validators = {
  live: ajv.compile(loadSchema('telemetry.schema.json')),
  meta: ajv.compile(loadSchema('meta.schema.json')),
  event: ajv.compile(loadSchema('event.schema.json')),
  status: ajv.compile(loadSchema('status.schema.json')),
};
validators.replay = validators.live;

/** @returns {{ok: true} | {ok: false, errors: Array<{path: string, message: string}>}} */
export function validatePayload(kind, payload) {
  const validate = validators[kind];
  if (!validate) return { ok: false, errors: [{ path: '', message: `unknown message kind "${kind}"` }] };
  if (validate(payload)) return { ok: true };
  return {
    ok: false,
    errors: validate.errors.slice(0, 20).map((e) => ({
      path: e.instancePath || '/',
      message: `${e.message}${e.params?.additionalProperty ? ` (${e.params.additionalProperty})` : ''}`,
    })),
  };
}

/**
 * Topic/payload identity must agree; a message cannot claim to be from a
 * device or site other than the topic it was published on.
 */
export function checkIdentity(route, payload) {
  const mismatches = [];
  if (payload.site_id !== route.siteId) mismatches.push({ field: 'site_id', topic: route.siteId, payload: payload.site_id });
  if (route.deviceId && payload.device_id !== route.deviceId) {
    mismatches.push({ field: 'device_id', topic: route.deviceId, payload: payload.device_id });
  }
  if (route.gatewayId && payload.gateway_id !== route.gatewayId) {
    mismatches.push({ field: 'gateway_id', topic: route.gatewayId, payload: payload.gateway_id });
  }
  return mismatches;
}
