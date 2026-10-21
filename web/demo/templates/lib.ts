// Readings in, heights out. Every height is in metres above chart datum.

export interface Reading {
  /** Minutes since midnight, local time at the station. */
  minute: number;
  /** As the staff gauge reads it, in centimetres. */
  rawCm: number;
  offsetCm: number;
}

export const corrected = (reading: Reading): number => (reading.rawCm - reading.offsetCm) / 100;

/** The height at `at`, drawn from the two readings around it. */
export function levelAt(readings: Reading[], at: number): number {
  const minute = new Date(at).getHours() * 60 + new Date(at).getMinutes();
  const after = readings.findIndex((reading) => reading.minute >= minute);
  if (after <= 0) return corrected(readings[Math.max(after, 0)] ?? readings[readings.length - 1]);
  const a = readings[after - 1];
  const b = readings[after];
  const share = (minute - a.minute) / (b.minute - a.minute);
  return corrected(a) + (corrected(b) - corrected(a)) * share;
}

/** High and low water of one day: the turning points, not just the largest and smallest values. */
export function turns(readings: Reading[]): { at: number; height: number; high: boolean }[] {
  const heights = smooth(readings.map(corrected), 3);
  const out = [];
  for (let i = 1; i < heights.length - 1; i++) {
    const rising = heights[i] > heights[i - 1];
    const falling = heights[i + 1] < heights[i];
    if (rising === falling) out.push({ at: readings[i].minute, height: heights[i], high: rising });
  }
  return out;
}

function smooth(values: number[], width: number): number[] {
  return values.map((_, i) => {
    const from = Math.max(0, i - width);
    const window = values.slice(from, i + width + 1);
    return window.reduce((sum, v) => sum + v, 0) / window.length;
  });
}
