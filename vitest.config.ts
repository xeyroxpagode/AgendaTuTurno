import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/{h01,h02,h03,h04,h05,h06,h07,h08}/{unit,integration}/**/*.spec.ts", "tests/h09/{unit,integration,api}/**/*.spec.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    sequence: { concurrent: false }
  }
});
