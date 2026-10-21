import { expect, test } from "bun:test";
import { corrected, levelAt, turns } from "../src";

const day = Array.from({ length: 145 }, (_, i) => ({
  minute: i * 10,
  rawCm: 190 + 140 * Math.sin((i / 144) * 4 * Math.PI),
  offsetCm: 12,
}));

test("takes the gauge's offset off", () => {
  expect(corrected({ minute: 0, rawCm: 312, offsetCm: 12 })).toBe(3);
});

test("draws a height between two readings", () => {
  const at = new Date(2026, 5, 1, 0, 5).getTime();
  expect(levelAt(day, at)).toBeCloseTo((corrected(day[0]) + corrected(day[1])) / 2, 3);
});

test("finds two highs and two lows in a semidiurnal day", () => {
  const found = turns(day);
  expect(found.filter((t) => t.high)).toHaveLength(2);
  expect(found.filter((t) => !t.high)).toHaveLength(2);
});
