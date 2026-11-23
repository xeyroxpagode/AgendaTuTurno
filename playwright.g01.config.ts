import { defineConfig, devices } from "@playwright/test";
try { process.loadEnvFile?.(".env"); } catch {}
const webPort = Number(process.env.E2E_WEB_PORT ?? 3101);
const apiPort = Number(process.env.E2E_API_PORT ?? 4100);

/** G01 · matriz responsive completa (obligatorios 390/410/1440 + extremos). */
const viewports = [
  { name: "g01-320", width: 320, height: 780 },
  { name: "mobile-390", width: 390, height: 844 },
  { name: "small-410", width: 410, height: 892 },
  { name: "g01-430", width: 430, height: 932 },
  { name: "g01-768", width: 768, height: 1024 },
  { name: "g01-1024", width: 1024, height: 768 },
  { name: "desktop-1440", width: 1440, height: 900 }
];

export default defineConfig({
  testDir: "./tests",
  testMatch: "**/e2e/**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["line"], ["junit", { outputFile: "test-results/g01/junit.xml" }]],
  use: { baseURL: `http://localhost:${webPort}`, trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: viewports.map((viewport) => ({
    name: viewport.name,
    use: { ...devices["Desktop Chrome"], viewport: { width: viewport.width, height: viewport.height } }
  })),
  webServer: [
    { command: "pnpm dev:api", port: apiPort, reuseExistingServer: true, timeout: 120_000 },
    { command: `pnpm --filter @youngkingz/web exec next dev -p ${webPort}`, port: webPort, reuseExistingServer: true, timeout: 120_000 }
  ]
});
