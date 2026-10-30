// The test every spec imports: Playwright's, plus an okfs on the fixture folder for each worker.
import { test as base } from "@playwright/test";
import { type Served, serve } from "./serve";

export { expect } from "@playwright/test";

export const test = base.extend<object, { okfs: Served }>({
  okfs: [
    async ({}, use) => {
      const served = await serve();
      await use(served);
      served.stop();
    },
    { scope: "worker" },
  ],
});
