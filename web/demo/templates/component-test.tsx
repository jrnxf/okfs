import { describe, expect, test } from "bun:test";
import { render, screen } from "@harbor/testing";
import { fixtures } from "@harbor/fixtures";
import { GaugeDial } from "./gauge-dial";

describe("GaugeDial", () => {
  test("names the height the water stands at", () => {
    render(<GaugeDial readings={fixtures.northPier.june} high={3.4} />);
    expect(screen.getByRole("img").getAttribute("aria-label")).toMatch(/^Water at \d\.\d{2} m$/);
  });

  test("says which way the tide is going", () => {
    render(<GaugeDial readings={fixtures.northPier.flood} high={3.4} />);
    expect(screen.getByText("rising to high water")).toBeTruthy();
  });

  test("keeps the needle inside the dial on a king tide", () => {
    render(<GaugeDial readings={fixtures.northPier.kingTide} high={3.4} />);
    const needle = document.querySelector(".needle")!;
    expect(Number(needle.getAttribute("x2"))).toBeLessThan(160);
  });
});
