import { describe, expect, test } from "bun:test";
import { Aim, heading } from "./aim";

const list = { left: 0, top: 0, right: 400, bottom: 600 };
const pane = { left: 400, top: 0, right: 900, bottom: 600 };

describe("heading", () => {
  test("a pointer going straight across toward the pane is held", () => {
    expect(heading({ x: 100, y: 300 }, { x: 200, y: 310 }, list, pane)).toBe(true);
  });
  test("a pointer going down the list is not", () => {
    expect(heading({ x: 100, y: 100 }, { x: 100, y: 200 }, list, pane)).toBe(false);
  });
  test("a pointer going away from the pane is not", () => {
    expect(heading({ x: 200, y: 300 }, { x: 100, y: 300 }, list, pane)).toBe(false);
  });
  test("a pointer that came in from outside the list is not", () => {
    expect(heading({ x: 500, y: 300 }, { x: 300, y: 300 }, list, pane)).toBe(false);
  });
});

describe("Aim", () => {
  test("a repeated place is not a move", () => {
    const aim = new Aim();
    expect(aim.track({ x: 1, y: 1 })).toBe(true);
    expect(aim.track({ x: 1, y: 1 })).toBe(false);
  });
  test("a pointer that stops is no longer held", () => {
    const aim = new Aim();
    aim.track({ x: 100, y: 300 });
    aim.track({ x: 200, y: 310 });
    expect(aim.aiming(list, pane)).toBe(true);
    expect(aim.aiming(list, pane)).toBe(false);
  });
});
