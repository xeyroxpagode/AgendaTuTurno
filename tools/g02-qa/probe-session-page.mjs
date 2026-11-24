import { chromium } from "@playwright/test";
process.loadEnvFile?.(".env");
const BASE = "http://localhost:3101";
const PASSWORD = "QaTestPass2026!x";
const courseId = process.argv[2];
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("response", async (r) => {
  if (!r.url().includes("/v1/")) return;
  let body = "";
  try { body = (await r.text()).slice(0, 200); } catch { body = "<unavailable>"; }
  console.log("API", r.status(), new URL(r.url()).pathname + new URL(r.url()).search, body);
});
page.on("requestfailed", (r) => console.log("REQFAIL", r.url(), r.failure()?.errorText));
page.on("console", (m) => { if (m.type() === "error") console.log("CONSOLE", m.text().slice(0, 300)); });
await page.goto(`${BASE}/login`);
await page.getByLabel("Correo").pressSequentially("owner-qa@youngkingz.local", { delay: 5 });
await page.getByLabel("Contraseña").pressSequentially(PASSWORD, { delay: 5 });
await page.getByRole("button", { name: "Ingresar" }).click();
await page.waitForURL(/\/team|\/account/);
await page.goto(`${BASE}/cursos/${courseId}/sesiones`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(2000);
const info = await page.evaluate(() => ({
  selects: Array.from(document.querySelectorAll("select")).map((s) => ({ outer: s.outerHTML.slice(0, 400), options: s.options.length })),
  buttons: Array.from(document.querySelectorAll("button")).map((b) => `${b.innerText}|disabled=${b.disabled}`),
  body: document.body.innerText.slice(0, 1200)
}));
console.log(JSON.stringify(info, null, 2));
await browser.close();
