import { useMemo } from "preact/hooks";
import { type Reading, corrected, levelAt } from "@harbor/tides";
import { formatHeight } from "@harbor/format";

export interface GaugeDialProps {
  /** Readings for one station, oldest first. */
  readings: Reading[];
  /** Metres above chart datum that count as high water here. */
  high: number;
  size?: number;
}

/** A dial that shows where the water stands now between the day's low and high. */
export function GaugeDial({ readings, high, size = 160 }: GaugeDialProps) {
  const now = useMemo(() => levelAt(readings, Date.now()), [readings]);
  const low = useMemo(() => Math.min(...readings.map(corrected)), [readings]);
  const share = Math.max(0, Math.min(1, (now - low) / (high - low)));
  const angle = -120 + share * 240;
  const r = size / 2 - 8;

  return (
    <figure class="gauge-dial" style={{ width: size, height: size }}>
      <svg viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`Water at ${formatHeight(now)}`}>
        <circle cx={size / 2} cy={size / 2} r={r} class="track" />
        <path d={arc(size / 2, size / 2, r, -120, angle)} class="fill" />
        <line
          x1={size / 2}
          y1={size / 2}
          x2={size / 2 + Math.cos(rad(angle - 90)) * (r - 10)}
          y2={size / 2 + Math.sin(rad(angle - 90)) * (r - 10)}
          class="needle"
        />
      </svg>
      <figcaption>
        <strong>{formatHeight(now)}</strong>
        <span>{share > 0.5 ? "rising to high water" : "falling to low water"}</span>
      </figcaption>
    </figure>
  );
}

const rad = (deg: number) => (deg * Math.PI) / 180;

function arc(cx: number, cy: number, r: number, from: number, to: number): string {
  const a = { x: cx + r * Math.cos(rad(from - 90)), y: cy + r * Math.sin(rad(from - 90)) };
  const b = { x: cx + r * Math.cos(rad(to - 90)), y: cy + r * Math.sin(rad(to - 90)) };
  return `M ${a.x} ${a.y} A ${r} ${r} 0 ${to - from > 180 ? 1 : 0} 1 ${b.x} ${b.y}`;
}
