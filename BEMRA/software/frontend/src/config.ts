/** Runtime settings from Vite env (see .env.example). */
function num(v: string | undefined, fallback: number, min: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

export const config = {
  livePollMs: num(import.meta.env.VITE_LIVE_POLL_MS, 5000, 2000),
  /** BEMRA display threshold for cell spread (not a BMS protection limit). */
  cellSpreadWarnMv: num(import.meta.env.VITE_CELL_SPREAD_WARN_MV, 50, 1),
  /** Fleet/status refresh interval. */
  fleetPollMs: 10_000,
  /** Fallback charge/discharge dead-band when the BMS Conf snapshot lacks sBalIdleCurrent_A. */
  defaultIdleCurrentA: 0.1,
  /** Data newer than this is "fresh": gateway publishes every 120 s, so 150 s gives margin. */
  freshWithinS: num(import.meta.env.VITE_FRESH_WITHIN_S, 150, 10),
} as const;
