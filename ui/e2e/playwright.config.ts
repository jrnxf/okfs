import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "*.e2e.ts",
  // One browser against one okfs: timings are only worth anything when nothing else competes for the machine.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? [["list"], ["github"]] : "list",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    browserName: "chromium",
    viewport: { width: 1280, height: 800 },
    trace: "retain-on-failure",
  },
  outputDir: "../../target/e2e-results",
});
