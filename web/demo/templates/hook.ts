import { useEffect, useState } from "preact/hooks";
import { type Reading, levelAt } from "@harbor/tides";
import { subscribe } from "@harbor/sync";

/** The height at a station, kept current as new readings arrive from its gauge. */
export function useLevel(station: string, readings: Reading[]): number {
  const [level, setLevel] = useState(() => levelAt(readings, Date.now()));

  useEffect(() => {
    const tick = setInterval(() => setLevel(levelAt(readings, Date.now())), 60_000);
    const stop = subscribe(`gauge:${station}`, (reading: Reading) => {
      readings.push(reading);
      setLevel(levelAt(readings, Date.now()));
    });
    return () => {
      clearInterval(tick);
      stop();
    };
  }, [station, readings]);

  return level;
}
