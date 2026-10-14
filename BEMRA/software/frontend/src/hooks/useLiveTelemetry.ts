/**
 * Live telemetry buffer with incremental polling.
 *
 * 1. Initial load: raw rows in [now − window, now + 5 min) incl. the complete
 *    ThingSet object (cells, thermistors). The +5 min tolerates gateway clocks
 *    slightly ahead of the browser.
 * 2. Every poll: only rows with observed_at ≥ newest known row are requested;
 *    the boundary row comes back once and is removed by id-based de-duplication.
 * 3. If nothing new arrived, state is not updated (no re-render, no animation).
 *
 * Limitation (documented): a replayed row whose observed_at is older than the
 * newest row is not picked up incrementally; a manual refresh reloads the window.
 *
 * Isolation: the buffer is tagged with its deviceId; a hook instance for another
 * device never exposes it.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/endpoints';
import { ApiError } from '../api/client';
import type { RawTelemetryRow } from '../api/types';
import { mergeRows, trimRows } from '../domain/series';
import { config } from '../config';

const CLOCK_TOLERANCE_MS = 5 * 60_000;
const MAX_POINTS = 6000;
const NO_ROWS: RawTelemetryRow[] = [];

interface Buffer {
  deviceId: string;
  windowS: number;
  rows: RawTelemetryRow[];
}

export interface LiveTelemetry {
  rows: RawTelemetryRow[];
  loading: boolean;
  error: ApiError | null;
  lastPollAt: number | null;
  lastNewDataAt: number | null;
  refresh: () => void;
}

export function useLiveTelemetry(
  deviceId: string | undefined,
  windowS: number,
  paused: boolean,
  enabled = true,
): LiveTelemetry {
  const [buffer, setBuffer] = useState<Buffer | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [lastPollAt, setLastPollAt] = useState<number | null>(null);
  const [lastNewDataAt, setLastNewDataAt] = useState<number | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const rowsRef = useRef<RawTelemetryRow[]>([]);

  // Full (re)load whenever device, window or reload token changes.
  useEffect(() => {
    if (!deviceId || !enabled) return;
    const ac = new AbortController();
    rowsRef.current = [];
    setBuffer(null);
    setLoading(true);
    setError(null);
    const now = Date.now();
    api
      .telemetryRaw(
        deviceId,
        {
          from: new Date(now - windowS * 1000).toISOString(),
          to: new Date(now + CLOCK_TOLERANCE_MS).toISOString(),
          limit: 5000,
        },
        ac.signal,
      )
      .then((page) => {
        const rows = trimRows(mergeRows([], page.data), now - windowS * 1000, MAX_POINTS);
        rowsRef.current = rows;
        setBuffer({ deviceId, windowS, rows });
        setLastPollAt(Date.now());
        setLastNewDataAt(rows.length ? Date.now() : null);
      })
      .catch((err: ApiError) => {
        if (err.kind !== 'aborted') setError(err);
      })
      .finally(() => {
        if (!ac.signal.aborted) setLoading(false);
      });
    return () => ac.abort();
  }, [deviceId, windowS, enabled, reloadToken]);

  // Incremental polling while not paused.
  useEffect(() => {
    if (!deviceId || !enabled || paused) return;
    let timer: ReturnType<typeof setTimeout>;
    let ac: AbortController | null = null;
    let stopped = false;

    const tick = async () => {
      ac = new AbortController();
      const now = Date.now();
      const newest = rowsRef.current.at(-1);
      const from = newest ? newest.timestamps.observed_at : new Date(now - windowS * 1000).toISOString();
      try {
        const page = await api.telemetryRaw(
          deviceId,
          { from, to: new Date(now + CLOCK_TOLERANCE_MS).toISOString(), limit: 1000 },
          ac.signal,
        );
        const merged = mergeRows(rowsRef.current, page.data);
        const trimmed = trimRows(merged, now - windowS * 1000, MAX_POINTS);
        if (trimmed !== rowsRef.current) {
          const gotNew = merged !== rowsRef.current;
          rowsRef.current = trimmed;
          setBuffer({ deviceId, windowS, rows: trimmed });
          if (gotNew) setLastNewDataAt(Date.now());
        }
        setError(null);
        setLastPollAt(Date.now());
      } catch (err) {
        if ((err as ApiError).kind !== 'aborted') setError(err as ApiError);
      }
      if (!stopped) timer = setTimeout(tick, config.livePollMs);
    };
    timer = setTimeout(tick, config.livePollMs);
    return () => {
      stopped = true;
      clearTimeout(timer);
      ac?.abort();
    };
  }, [deviceId, windowS, paused, enabled]);

  const refresh = useCallback(() => setReloadToken((t) => t + 1), []);
  const valid = buffer && buffer.deviceId === deviceId && buffer.windowS === windowS;
  return { rows: valid ? buffer.rows : NO_ROWS, loading, error, lastPollAt, lastNewDataAt, refresh };
}
