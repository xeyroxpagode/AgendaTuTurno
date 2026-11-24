import { chromium } from "@playwright/test";
import fs from "node:fs";
process.loadEnvFile?.(".env");
const OUT = "C:/Users/thega/Desktop/YKZ-H07-H08-FINAL-CLOSURE/02_CORRECTIVES/e18_results.json";
const BASE = "http://localhost:3101";
const SHOT = "C:/Users/thega/Desktop/YKZ-H07-H08-FINAL-CLOSURE/08_SCREENSHOTS";
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await context.newPage();
const result = { startedAt: new Date().toISOString(), checks: [] };
const draftTitle = process.argv[2] ?? null;
try {
  await page.goto(`${BASE}/cursos/publicos?business=qa-b1-key`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1200);
  let text = await page.locator("body").innerText();
  result.checks.push({ check: "resolve_by_public_key", ok: text.includes("Cursos") && !text.includes("Identificador del negocio"), sample: text.slice(0, 500) });
  await page.screenshot({ path: `${SHOT}/g02_e18_public_key_390.png`, fullPage: true });

  await page.goto(`${BASE}/cursos/publicos?business=qa-b2-key`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1000);
  text = await page.locator("body").innerText();
  result.checks.push({ check: "second_business_by_key", ok: !text.includes("Identificador del negocio"), sample: text.slice(0, 300) });

  await page.goto(`${BASE}/cursos/publicos?business=clave-inexistente`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1000);
  text = await page.locator("body").innerText();
  result.checks.push({ check: "invalid_key_actionable_error", ok: text.includes("barbería activa") || text.includes("enlace público"), sample: text.slice(0, 400) });

  await page.goto(`${BASE}/cursos/publicos`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(800);
  text = await page.locator("body").innerText();
  result.checks.push({ check: "no_uuid_input_without_context", ok: !text.includes("Identificador del negocio"), sample: text.slice(0, 400) });

  if (draftTitle) {
    await page.goto(`${BASE}/cursos/publicos?business=qa-b1-key`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1000);
    text = await page.locator("body").innerText();
    result.checks.push({ check: "draft_not_exposed", ok: !text.includes(draftTitle), draftTitle });
  }
} catch (e) { result.fatal = e.message; } finally {
  result.finishedAt = new Date().toISOString();
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2), "utf8");
  await browser.close();
  console.log(JSON.stringify(result, null, 2));
}
