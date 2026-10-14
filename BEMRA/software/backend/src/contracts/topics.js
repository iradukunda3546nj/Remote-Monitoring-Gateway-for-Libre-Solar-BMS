/**
 * MQTT topic contract v1.
 *
 *   {root}/v1/{site_id}/{device_id}/live                  telemetry (QoS 1)
 *   {root}/v1/{site_id}/{device_id}/replay                buffered telemetry (QoS 1)
 *   {root}/v1/{site_id}/{device_id}/meta                  device metadata (QoS 1, retained)
 *   {root}/v1/{site_id}/{device_id}/event                 events (QoS 1)
 *   {root}/v1/{site_id}/gateways/{gateway_id}/status      gateway status / LWT (QoS 1, retained)
 *
 * `gateways` is a reserved word and can never be a device_id.
 */
export const CONTRACT_VERSION = 'v1';
export const DEVICE_KINDS = Object.freeze(['live', 'replay', 'meta', 'event']);
const ID_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;

/** Subscription filters for the ingestion worker. */
export function subscriptionFilters(root) {
  return [...DEVICE_KINDS.map((k) => `${root}/${CONTRACT_VERSION}/+/+/${k}`), `${root}/${CONTRACT_VERSION}/+/gateways/+/status`];
}

/**
 * Parses a topic into {kind, siteId, deviceId?, gatewayId?} or returns null if
 * the topic is not part of the contract.
 */
export function parseTopic(root, topic) {
  const parts = topic.split('/');
  if (parts[0] !== root || parts[1] !== CONTRACT_VERSION) return null;
  const siteId = parts[2];
  if (!ID_RE.test(siteId ?? '')) return null;

  if (parts.length === 6 && parts[3] === 'gateways' && parts[5] === 'status') {
    return ID_RE.test(parts[4]) ? { kind: 'status', siteId, gatewayId: parts[4] } : null;
  }
  if (parts.length === 5 && DEVICE_KINDS.includes(parts[4])) {
    const deviceId = parts[3];
    if (!ID_RE.test(deviceId) || deviceId === 'gateways') return null;
    return { kind: parts[4], siteId, deviceId };
  }
  return null;
}

export function deviceTopic(root, siteId, deviceId, kind) {
  return `${root}/${CONTRACT_VERSION}/${siteId}/${deviceId}/${kind}`;
}

export function statusTopic(root, siteId, gatewayId) {
  return `${root}/${CONTRACT_VERSION}/${siteId}/gateways/${gatewayId}/status`;
}
