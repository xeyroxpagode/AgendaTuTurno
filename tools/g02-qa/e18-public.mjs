import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
process.loadEnvFile?.(".env");
const OUT = process.env.G02_OUT ?? "C:/Users/thega/Desktop/YKZ-H07-H08-FINAL-CLOSURE";
fs.mkdirSync(path.join(OUT, "02_CORRECTIVES"), { recursive: true });
fs.mkdirSync(path.join(OUT, "08_SCREENSHOTS"), { recursive: true });
const BASE = process.env.E2E_WEB_BASE ?? "http://localhost:3101";
const API = process.env.E2E_API_BASE ?? "http://127.0.0.1:4100";
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await context.newPage();
const result = { startedAt: new Date().toISOString(), checks: [] };
const draftTitle = process.argv[2] ?? null;
try {
  // Identidad pública legítima: la expone /v1/public/course-businesses.
  const discovery = await (await fetch(`${API}/v1/public/course-businesses`)).json();
  const [{ id: b1 }] = discovery.data;
  if (!b1) throw new Error("La exploración pública no devolvió barberías");
  const b2 = "22222222-2222-4222-8222-222222222222"; // fixture sintético de otro negocio

  await page.goto(`${BASE}/cursos/publicos?businessId=${encodeURIComponent(b1)}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1200);
  let text = await page.locator("body").innerText();
  result.checks.push({ check: "resolve_by_public_key", ok: text.includes("Cursos ·") && !text.includes("Identificador del negocio"), sample: text.slice(0, 400) });
  await page.screenshot({ path: path.join(OUT, "08_SCREENSHOTS", "g02_e18_public_key_390.png"), fullPage: true });

  await page.goto(`${BASE}/cursos/publicos?businessId=${encodeURIComponent(b2)}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1000);
  text = await page.locator("body").innerText();
  result.checks.push({ check: "second_business_isolated", ok: !text.includes("Identificador del negocio") && !text.includes("Young KingZ QA B1"), sample: text.slice(0, 300) });

  await page.goto(`${BASE}/cursos/publicos?businessId=clave-inexistente`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1000);
  text = await page.locator("body").innerText();
  result.checks.push({ check: "invalid_key_actionable_error", ok: text.includes("barbería activa") || text.includes("enlace público"), sample: text.slice(0, 400) });

  await page.goto(`${BASE}/cursos/publicos`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(800);
  text = await page.locator("body").innerText();
  result.checks.push({ check: "no_uuid_input_without_context", ok: !text.includes("Identificador del negocio"), sample: text.slice(0, 400) });

  if (draftTitle) {
    await page.goto(`${BASE}/cursos/publicos?businessId=${encodeURIComponent(b1)}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1000);
    text = await page.locator("body").innerText();
    result.checks.push({ check: "draft_not_exposed", ok: !text.includes(draftTitle), draftTitle });
  }
} catch (e) { result.fatal = e.message; } finally {
  result.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(OUT, "02_CORRECTIVES", "e18_results.json"), JSON.stringify(result, null, 2), "utf8");
  await browser.close();
  console.log(JSON.stringify(result, null, 2));
}
