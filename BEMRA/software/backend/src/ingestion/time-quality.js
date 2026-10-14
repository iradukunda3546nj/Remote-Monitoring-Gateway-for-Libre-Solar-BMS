/**
 * Timestamp handling. The backend never invents a measurement time; it only
 * annotates what it received so consumers can judge trustworthiness.
 */
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000; // gateway clock ahead of backend
const LATE_LIVE_MS = 10 * 60 * 1000; // live message delivered unusually late

/** Best available message time, used to pick the device assignment in force. */
export function messageTime(timestamps, now) {
  const t = timestamps.measured_at ?? timestamps.gateway_received_at ?? timestamps.published_at;
  if (!t) return now;
  const d = new Date(t);
  // A gateway clock running ahead must not select a future assignment.
  return d.getTime() - now.getTime() > FUTURE_TOLERANCE_MS ? now : d;
}

/**
 * Flags stored in telemetry.time_flags:
 *   no_gateway_clock  - gateway supplied neither receive nor publish time
 *   future_timestamp  - a timestamp is more than 5 min ahead of the backend clock
 *   late_delivery     - a *live* message arrived more than 10 min after publication
 */
export function computeTimeFlags(timestamps, now, delivery) {
  const flags = [];
  const { measured_at, gateway_received_at, published_at } = timestamps;
  if (!gateway_received_at && !published_at) flags.push('no_gateway_clock');
  const nowMs = now.getTime();
  if ([measured_at, gateway_received_at, published_at].some((t) => t && Date.parse(t) - nowMs > FUTURE_TOLERANCE_MS)) {
    flags.push('future_timestamp');
  }
  if (delivery === 'live' && published_at && nowMs - Date.parse(published_at) > LATE_LIVE_MS) {
    flags.push('late_delivery');
  }
  return flags;
}
