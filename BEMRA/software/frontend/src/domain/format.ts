/** Formatting helpers. Missing values render as an em dash, never as 0. */

export const DASH = '—';

export function fmt(value: number | null | undefined, decimals: number): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return DASH;
  return value.toFixed(decimals);
}

export function fmtSigned(value: number | null | undefined, decimals: number): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return DASH;
  const s = value.toFixed(decimals);
  return value > 0 ? `+${s}` : s.replace('-', '−');
}

const utcFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'UTC',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});
const localTimeFmt = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

/** 2026-10-09 14:30:02 UTC */
export function fmtUtc(iso: string | null | undefined): string {
  if (!iso) return DASH;
  const p = Object.fromEntries(utcFmt.formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

export function fmtLocalTime(iso: string | Date | null | undefined): string {
  if (!iso) return DASH;
  return localTimeFmt.format(typeof iso === 'string' ? new Date(iso) : iso);
}

export function localZoneName(): string {
  const part = new Intl.DateTimeFormat('en-GB', { timeZoneName: 'short' })
    .formatToParts(new Date())
    .find((p) => p.type === 'timeZoneName');
  return part?.value ?? 'local';
}

/** Human age: 12 s, 4 min, 3 h 12 min, 2 d 4 h */
export function fmtAge(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return DASH;
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
  return `${Math.floor(s / 86400)} d ${Math.floor((s % 86400) / 3600)} h`;
}

export function ageSeconds(iso: string | null | undefined, now = Date.now()): number | null {
  return iso ? (now - Date.parse(iso)) / 1000 : null;
}

export function fmtHex(value: number | null | undefined, width = 8): string {
  if (value === null || value === undefined) return DASH;
  return `0x${value.toString(16).toUpperCase().padStart(width, '0')}`;
}
