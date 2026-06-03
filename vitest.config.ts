import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Match the TypeScript `customConditions` so workspace packages resolve to
    // their source the same way the app does.
    conditions: ["workspace"],
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // The job-process test spawns a real child process and the scheduler test
    // talks to the database; keep generous timeouts and avoid noisy parallelism.
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
