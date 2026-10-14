import { useEffect, useState } from 'react';

export const SPLASH_MS = 10_000;

/** Start-up screen: BEMRA logo centred, then fades into the dashboard. */
export function Splash({ onDone, durationMs = SPLASH_MS }: { onDone: () => void; durationMs?: number }) {
  const [leaving, setLeaving] = useState(false);
  useEffect(() => {
    const fade = setTimeout(() => setLeaving(true), durationMs - 500);
    const done = setTimeout(onDone, durationMs);
    return () => {
      clearTimeout(fade);
      clearTimeout(done);
    };
  }, [durationMs, onDone]);

  return (
    <div className={`splash ${leaving ? 'splash--leaving' : ''}`} role="status" aria-label="Loading BEMRA">
      <div className="splash__logo">
        BEMR<span>A</span>
      </div>
      <div className="splash__sub">Battery Energy Monitoring &amp; Remote Analytics</div>
      <div className="splash__bar" aria-hidden>
        <span style={{ animationDuration: `${durationMs}ms` }} />
      </div>
    </div>
  );
}
