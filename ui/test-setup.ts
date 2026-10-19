// The page's modules read `document` as they load, and `bun test` loads files in whatever order the disk lists them.
// Without this, a test that imports one of them before another test has stubbed the page crashes on CI.
Object.assign(globalThis, {
  document: { getElementById: () => null, addEventListener: () => undefined, querySelector: () => null },
});
