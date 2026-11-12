import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The first test in a file loads the Bryntum engine, which takes a few seconds.
  test: { testTimeout: 30_000, hookTimeout: 30_000 },
});
