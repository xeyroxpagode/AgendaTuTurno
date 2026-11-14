import { defineConfig, devices } from "@playwright/test"
try { process.loadEnvFile?.(".env"); } catch {}
const webPort=Number(process.env.E2E_WEB_PORT??3100);
const apiPort=Number(process.env.E2E_API_PORT??4100);

export default defineConfig({
  testDir: "./tests",
  testMatch: "**/e2e/**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  use: {
    baseURL: `http://localhost:${webPort}`,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "mobile-390",
      use: { ...devices["Pixel 7"], viewport: { width: 390, height: 844 } },
    },
    {
      name: "small-410",
      use: { ...devices["Pixel 7"], viewport: { width: 410, height: 892 } },
    },
    {
      name: "desktop-1440",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
  ],
  webServer: [
    { command: "pnpm dev:api", port: apiPort, reuseExistingServer: true },
    { command: `pnpm --filter @youngkingz/web exec next dev -p ${webPort}`, port: webPort, reuseExistingServer: true },
  ],
})
