/**
 * G02.1 — Reconocimiento real de UI con Playwright + Chromium headless.
 * NO modifica el producto. Login contra GoTrue real y navegación por enlaces reales.
 * Salida: JSON + capturas en el dossier final (sin secretos).
 */
import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

process.loadEnvFile?.(".env");

const OUT = process.env.G02_OUT ?? "C:/Users/thega/Desktop/YKZ-H07-H08-FINAL-CLOSURE";
const SHOT = path.join(OUT, "08_SCREENSHOTS");
const JSON_OUT = path.join(OUT, "01_BROWSER", "g02_ui_recon.json");
fs.mkdirSync(SHOT, { recursive: true });

const EMAIL = "owner-qa@youngkingz.local";
const PASSWORD = "QaTestPass2026!x";
const BASE = process.env.E2E_WEB_BASE ?? "http://localhost:3101";

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "es-AR" });
const page = await context.newPage();

const consoleErrors = [];
const networkErrors = [];
page.on("console", (m) => {
  if (m.type() === "error" || m.type() === "warning") consoleErrors.push(`${m.type()}: ${m.text()}`);
});
page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));
page.on("response", async (r) => {
  if (r.status() >= 400) {
    let body = "";
    try { body = (await r.text()).slice(0, 300); } catch {}
    networkErrors.push(`${r.status()} ${r.request().method()} ${r.url()} :: ${body}`);
  }
});
page.on("requestfailed", (r) => networkErrors.push(`FAILED ${r.url()} ${r.failure()?.errorText ?? ""}`));

const inventory = async (label) => {
  const data = await page.evaluate(() => {
    const txt = (els) => Array.from(els).map((e) => (e.innerText || e.value || "").trim()).filter(Boolean).slice(0, 60);
    return {
      url: location.href,
      title: document.title,
      headings: txt(document.querySelectorAll("h1,h2,h3")),
      buttons: txt(document.querySelectorAll("button")),
      links: Array.from(document.querySelectorAll("a")).map((a) => `${(a.innerText || "").trim()} -> ${a.getAttribute("href")}`).filter(Boolean).slice(0, 80),
      inputs: Array.from(document.querySelectorAll("input")).map((i) => `${i.type}|${i.name ?? ""}|${i.placeholder ?? ""}|${i.getAttribute("aria-label") ?? ""}`).slice(0, 60),
      selects: Array.from(document.querySelectorAll("select")).map((s) => `${s.name ?? ""}|${Array.from(s.options).map((o) => o.text).join(",")}`).slice(0, 40),
      textareas: Array.from(document.querySelectorAll("textarea")).map((t) => `${t.name ?? ""}|${t.placeholder ?? ""}`).slice(0, 20),
      dialogs: txt(document.querySelectorAll("[role=dialog]")),
      bodySample: (document.body.innerText || "").slice(0, 1200)
    };
  });
  return { label, ...data };
};

const result = { startedAt: new Date().toISOString(), base: BASE, pages: [], consoleErrors, networkErrors, steps: [] };

try {
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded", timeout: 30000 });
  result.pages.push(await inventory("login"));

  await page.getByLabel("Correo").pressSequentially(EMAIL, { delay: 12 });
  await page.getByLabel("Contraseña").pressSequentially(PASSWORD, { delay: 12 });
  const emailValue = await page.locator('input[type="email"]').inputValue();
  const passLen = (await page.locator('input[type="password"]').inputValue()).length;
  result.steps.push(`typed into controlled React inputs: email=${emailValue} passwordLength=${passLen}`);
  await page.getByRole("button", { name: "Ingresar" }).click();
  result.steps.push("clicked Ingresar button");
  await page.waitForURL(/\/team/, { timeout: 20000 });
  result.steps.push(`authenticated -> ${page.url()}`);
  await page.screenshot({ path: path.join(SHOT, "g02_recon_owner_team.png"), fullPage: true });

  for (const route of ["/team", "/cursos", "/team/economia", "/cursos/publicos", "/account/economia"]) {
    try {
      await page.goto(`${BASE}${route}`, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForTimeout(700);
      const inv = await inventory(route);
      result.pages.push(inv);
      const safe = route.replace(/\//g, "_").replace(/^_/, "") || "root";
      await page.screenshot({ path: path.join(SHOT, `g02_recon_${safe}.png`), fullPage: true });
      result.steps.push(`navigated ${route} -> ${inv.url}`);
    } catch (e) {
      result.steps.push(`nav-error ${route}: ${e.message}`);
    }
  }
} catch (e) {
  result.fatal = e.message;
} finally {
  result.finishedAt = new Date().toISOString();
  fs.writeFileSync(JSON_OUT, JSON.stringify(result, null, 2), "utf8");
  await browser.close();
  console.log(JSON.stringify({ fatal: result.fatal ?? null, pages: result.pages.map((p) => p.label), steps: result.steps.length, consoleErrors: result.consoleErrors.length, networkErrors: result.networkErrors.length, out: JSON_OUT }, null, 2));
}
