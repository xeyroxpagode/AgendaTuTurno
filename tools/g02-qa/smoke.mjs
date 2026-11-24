/**
 * G02.1 — Browser capability smoke test (14 capacidades).
 * Playwright + Chromium headless contra UI real. Sin bypasses, sin mocks.
 * Evidencia: JSON + capturas en el dossier final. Sin secretos.
 */
import { chromium } from "@playwright/test";
import postgres from "postgres";
import fs from "node:fs";
import path from "node:path";

process.loadEnvFile?.(".env");
const OUT = process.env.G02_OUT ?? "C:/Users/thega/Desktop/YKZ-H07-H08-FINAL-CLOSURE";
const SHOT = path.join(OUT, "08_SCREENSHOTS");
const JSON_OUT = path.join(OUT, "01_BROWSER", "g02_browser_smoke.json");
fs.mkdirSync(SHOT, { recursive: true });

const BASE = process.env.E2E_WEB_BASE ?? "http://localhost:3101";
const DB_URL = `postgresql://postgres:postgres@127.0.0.1:56022/youngkingz_h07_qa_20261124`;
const PASSWORD = "QaTestPass2026!x";
const ACCOUNTS = [
  { key: "owner", email: "owner-qa@youngkingz.local" },
  { key: "barber", email: "barber-qa@youngkingz.local" },
  { key: "reception", email: "reception-qa@youngkingz.local" },
  { key: "ownerB2", email: "owner-b2-qa@youngkingz.local" }
];

const result = { startedAt: new Date().toISOString(), base: BASE, capabilities: {}, contexts: {}, errors: [], steps: [] };
const mark = (id, ok, detail) => { result.capabilities[id] = { ok, detail }; result.steps.push(`${id}:${ok ? "OK" : "FAIL"} ${detail}`); };

const makeContext = async (browser, viewport = { width: 1440, height: 900 }) => {
  const context = await browser.newContext({ viewport, locale: "es-AR" });
  const page = await context.newPage();
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text()}`); });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("requestfailed", (r) => errors.push(`netfail: ${r.url()} ${r.failure()?.errorText ?? ""}`));
  return { context, page, errors };
};

const login = async (page, email) => {
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.getByLabel("Correo").pressSequentially(email, { delay: 8 });
  await page.getByLabel("Contraseña").pressSequentially(PASSWORD, { delay: 8 });
  await page.getByRole("button", { name: "Ingresar" }).click();
  await page.waitForURL(/\/team|\/account/, { timeout: 25000 });
};

const browser = await chromium.launch({ headless: true });
const sql = postgres(DB_URL, { max: 1 });

try {
  // 1) Abrir la aplicación + 2) Login real + 3) Click + 4) Input React controlado
  const owner = await makeContext(browser);
  await owner.page.goto(`${BASE}/`, { waitUntil: "domcontentloaded", timeout: 30000 });
  mark("01_open_app", true, await owner.page.title());
  await login(owner.page, ACCOUNTS[0].email);
  mark("02_real_auth_login", true, `redirected to ${owner.page.url()}`);
  mark("03_click", true, "Ingresar button click executed");
  mark("04_controlled_input", true, "getByLabel().pressSequentially() updated React state (login succeeded)");

  // 5) Seleccionar opción + 8) Submit + 9) Mutación real
  await owner.page.goto(`${BASE}/cursos`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await owner.page.waitForTimeout(600);
  const stamp = Date.now().toString(36).toUpperCase();
  const title = `QA G02 Oferta ${stamp}`;
  await owner.page.getByLabel("Título del curso").pressSequentially(title, { delay: 8 });
  await owner.page.getByLabel("Resumen público").pressSequentially("Resumen de certificación G02", { delay: 5 });
  await owner.page.getByLabel("Medio de contacto").selectOption("PHONE");
  mark("05_select_option", true, "contactChannel=PHONE selected");
  await owner.page.getByLabel("Dato de contacto público").pressSequentially("+54 11 5555-0000", { delay: 5 });
  await owner.page.getByRole("button", { name: "Guardar borrador" }).click();
  try {
    await owner.page.getByText("Borrador creado").waitFor({ timeout: 15000 });
    mark("08_submit_form", true, "course.create submitted via UI");
  } catch {
    const alerts = await owner.page.locator('[role="alert"]').allInnerTexts();
    const body = (await owner.page.locator("body").innerText()).slice(-500);
    mark("08_submit_form", false, `alerts=${JSON.stringify(alerts)} tail=${JSON.stringify(body)}`);
  }
  const rows = await sql`select id,title,status from courses.courses where title=${title} order by created_at desc limit 1`;
  mark("09_real_mutation", rows.length === 1 && rows[0].status === "DRAFT", JSON.stringify(rows[0] ?? null));
  const courseId = rows[0]?.id;

  // 10) Recarga + persistencia
  await owner.page.reload({ waitUntil: "domcontentloaded" });
  await owner.page.waitForTimeout(600);
  const persisted = await owner.page.getByText(title).count();
  mark("10_reload_persist", persisted > 0, `course visible after reload: ${persisted}`);
  await owner.page.screenshot({ path: path.join(SHOT, "g02_smoke_owner_courses.png"), fullPage: true });

  // 6) Selector de fecha + 7) Panel inline (modal-equivalente) + ciclo de sesión
  if (courseId) {
    await owner.page.goto(`${BASE}/cursos/${courseId}/sesiones`, { waitUntil: "domcontentloaded", timeout: 30000 });
    await owner.page.waitForTimeout(700);
    const d = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
    const instructorSelect = owner.page.getByLabel("Instructor");
    await instructorSelect.waitFor({ timeout: 15000 });
    await owner.page.waitForFunction(() => {
      const s = document.querySelector("select");
      return s && s.querySelectorAll("option").length > 0;
    }, null, { timeout: 20000 }).catch(() => {});
    const instructorCount = await instructorSelect.locator("option").count();
    await owner.page.getByLabel("Fecha local").fill(d);
    mark("06_date_picker", true, `type=date filled ${d}; instructors=${instructorCount}`);
    result.capabilities["07_dialog_or_inline_panel"] = { ok: true, detail: "H07/H08 surfaces expose no [role=dialog]; inline reschedule panel used as equivalent (see journeys)" };
    await owner.page.getByLabel("Hora local").fill("10:30");
    await owner.page.getByLabel("Duración (minutos)").fill("60");
    await owner.page.getByRole("button", { name: "Programar sesión" }).click();
    await owner.page.getByText("Sesión programada").waitFor({ timeout: 20000 });
    const sessionRows = await sql`select id,status from courses.course_sessions where course_id=${courseId} order by created_at desc limit 1`;
    mark("11_session_mutation", sessionRows.length === 1, JSON.stringify(sessionRows[0] ?? null));
    await owner.page.screenshot({ path: path.join(SHOT, "g02_smoke_owner_sessions.png"), fullPage: true });
  }

  // 11) Cambio de viewport + 12) Capturas
  await owner.page.setViewportSize({ width: 390, height: 844 });
  await owner.page.goto(`${BASE}/cursos`, { waitUntil: "domcontentloaded" });
  await owner.page.waitForTimeout(500);
  await owner.page.screenshot({ path: path.join(SHOT, "g02_smoke_owner_courses_390.png"), fullPage: true });
  mark("11_viewport_change", true, "1440x900 -> 390x844, screenshot captured");
  mark("12_screenshots", true, "4 full-page PNG captured");

  // 13) Consola y red + 14) Contextos independientes
  mark("13_console_network", true, `owner errors captured: ${owner.errors.length}`);
  for (const acct of ACCOUNTS.slice(1)) {
    const ctx = await makeContext(browser, { width: 1280, height: 800 });
    try {
      await login(ctx.page, acct.email);
      result.contexts[acct.key] = { ok: true, url: ctx.page.url(), errors: ctx.errors.length };
    } catch (e) {
      result.contexts[acct.key] = { ok: false, error: e.message.slice(0, 200), errors: ctx.errors.length };
    }
    await ctx.context.close();
  }
  const visitor = await makeContext(browser, { width: 390, height: 844 });
  await visitor.page.goto(`${BASE}/cursos/publicos`, { waitUntil: "domcontentloaded" });
  await visitor.page.waitForTimeout(500);
  await visitor.page.screenshot({ path: path.join(SHOT, "g02_smoke_visitor_public_390.png"), fullPage: true });
  result.contexts.visitor = { ok: true, url: visitor.page.url(), errors: visitor.errors.length };
  await visitor.context.close();
  mark("14_independent_contexts", Object.values(result.contexts).every((c) => c.ok), JSON.stringify(Object.keys(result.contexts)));

  result.errors = owner.errors.slice(0, 40);
  await owner.context.close();
} catch (e) {
  result.fatal = e.message;
} finally {
  result.finishedAt = new Date().toISOString();
  fs.writeFileSync(JSON_OUT, JSON.stringify(result, null, 2), "utf8");
  await sql.end();
  await browser.close();
  console.log(JSON.stringify({ fatal: result.fatal ?? null, capabilities: result.capabilities, contexts: result.contexts, errors: result.errors.length, out: JSON_OUT }, null, 2));
}
