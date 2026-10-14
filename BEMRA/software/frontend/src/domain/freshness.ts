import { config } from '../config';

/**
 * Liveness of a measurement stream.
 *   fresh      newest point within freshWithinS (covers 5 s Wi-Fi and 60 s GPRS reporting)
 *   delayed    older than that but within the backend's stale threshold
 *   stale      older than the backend's stale_after_s
 *   no_data    nothing stored
 *   historical user is viewing a fixed past range or paused the live view
 */
export type Liveness = 'fresh' | 'delayed' | 'stale' | 'no_data' | 'historical';

export function classifyLiveness(
  ageS: number | null,
  staleAfterS: number,
  opts: { historical?: boolean } = {},
): Liveness {
  if (opts.historical) return 'historical';
  if (ageS === null) return 'no_data';
  if (ageS > staleAfterS) return 'stale';
  if (ageS > config.freshWithinS) return 'delayed';
  return 'fresh';
}

export const LIVENESS_LABEL: Record<Liveness, string> = {
  fresh: 'LIVE',
  delayed: 'DELAYED',
  stale: 'STALE',
  no_data: 'NO DATA',
  historical: 'HISTORICAL',
};

/** Is the latest value a current reading that may be presented as live? */
export function isLive(l: Liveness): boolean {
  return l === 'fresh' || l === 'delayed';
}
