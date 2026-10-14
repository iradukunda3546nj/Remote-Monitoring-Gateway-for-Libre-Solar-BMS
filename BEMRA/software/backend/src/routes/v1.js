import { Router } from 'express';

/** Versioned API routes: /api/v1/... (all read-only). */
export function createV1Router({ devices, system }) {
  const r = Router();

  r.get('/openapi.yaml', system.openapiYaml);
  r.get('/openapi.json', system.openapiJson);

  r.get('/sites', system.sites);
  r.get('/devices', devices.list);
  r.get('/devices/:deviceId', devices.get);
  r.get('/devices/:deviceId/status', devices.status);
  r.get('/devices/:deviceId/latest', devices.latest);
  r.get('/devices/:deviceId/thingset', devices.thingset);
  r.get('/devices/:deviceId/cells', devices.cells);
  r.get('/devices/:deviceId/telemetry', devices.telemetry);
  r.get('/devices/:deviceId/events', devices.events);

  r.get('/integrations/home-assistant/devices/:deviceId', devices.homeAssistant);
  r.get('/integrations/mpm/devices/:deviceId/summary', devices.mpmSummary);
  return r;
}
