import { parseId } from '../validation/query.js';

/**
 * Thin HTTP adapters: parse path params, call the service, shape the
 * envelope. Express 5 forwards rejected promises to the error handler.
 */
export function createDeviceController(service) {
  const id = (req) => parseId(req.params.deviceId, 'deviceId');
  const one = (fn) => async (req, res) => res.json({ data: await fn(req) });
  const paged = (fn) => async (req, res) => res.json(await fn(req));

  return {
    list: one((req) => service.listDevices(req.query)),
    get: one((req) => service.getDevice(id(req))),
    status: one((req) => service.getStatus(id(req))),
    latest: one((req) => service.getLatest(id(req))),
    thingset: one((req) => service.getThingset(id(req))),
    cells: one((req) => service.getCells(id(req))),
    telemetry: paged((req) => service.getTelemetry(id(req), req.query)),
    events: paged((req) => service.getEvents(id(req), req.query)),
    homeAssistant: async (req, res) => res.json(await service.getHomeAssistantState(id(req))),
    mpmSummary: paged((req) => service.getMpmSummary(id(req), req.query)),
  };
}
