/**
 * J07 — Owner: ciclo operativo completo de curso vía UI real (autocontenido).
 */
import { chromium } from "@playwright/test";
import postgres from "postgres";
import fs from "node:fs";
process.loadEnvFile?.(".env");
const OUT = "C:/Users/thega/Desktop/YKZ-H07-H08-FINAL-CLOSURE/04_EXPLORATORY/journey_owner.json";
const SHOT = "C:/Users/thega/Desktop/YKZ-H07-H08-FINAL-CLOSURE/08_SCREENSHOTS";
const BASE = "http://localhost:3101";
const PASSWORD = "QaTestPass2026!x";
const sql = postgres("postgresql://postgres:postgres@127.0.0.1:56022/youngkingz_h07_qa_20261124", { max: 1 });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: "es-AR" });
const result = { startedAt: new Date().toISOString(), steps: [] };
const mark = (name, ok, detail) => result.steps.push({ name, ok, detail });
const clickExact = async (name) => { await page.getByRole("button", { name, exact: true }).first().click(); await page.waitForTimeout(400); };
const datePlus = (days) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
try {
  await page.goto(`${BASE}/login`);
  await page.getByLabel("Correo").pressSequentially("owner-qa@youngkingz.local", { delay: 6 });
  await page.getByLabel("Contraseña").pressSequentially(PASSWORD, { delay: 6 });
  await page.getByRole("button", { name: "Ingresar" }).click();
  await page.waitForURL(/\/team|\/account/);
  mark("login_owner", true, page.url());

  const title = `QA J07 Ciclo ${Date.now().toString(36).toUpperCase()}`;
  await page.goto(`${BASE}/cursos`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(600);
  await page.getByLabel("Título del curso").pressSequentially(title, { delay: 5 });
  await page.getByRole("button", { name: "Guardar borrador" }).click();
  await page.getByText("Borrador creado").waitFor({ timeout: 15000 });
  const [course] = await sql`select id from courses.courses where title=${title}`;
  mark("create_draft", !!course, title);

  await page.goto(`${BASE}/cursos/${course.id}/sesiones`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => { const s = document.querySelector("select"); return s && s.options.length > 0; }, null, { timeout: 20000 });
  await page.getByLabel("Fecha local").fill(datePlus(7));
  await page.getByLabel("Hora local").fill("10:00");
  await page.getByRole("button", { name: "Programar sesión" }).click();
  await page.getByText("Sesión programada").waitFor({ timeout: 15000 });
  mark("schedule_session", true, datePlus(7));

  await page.goto(`${BASE}/cursos`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(600);
  await page.locator("li.record-row").filter({ hasText: title }).first().getByRole("button", { name: "Publicar", exact: true }).click();
  await page.getByText("Curso publicado").waitFor({ timeout: 15000 });
  mark("publish_course", true, "PUBLISHED");

  await page.goto(`${BASE}/cursos/${course.id}/sesiones`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(800);
  await clickExact("Confirmar");
  await page.getByText("Sesión confirmada").waitFor({ timeout: 15000 });
  mark("confirm_session", true, "SCHEDULED → CONFIRMED");

  await page.getByRole("button", { name: "Reprogramar" }).first().click();
  const newDate = datePlus(9);
  await page.getByLabel("Nueva fecha local").fill(newDate);
  await page.getByRole("button", { name: "Guardar nueva fecha" }).click();
  await page.getByText("Sesión reprogramada").waitFor({ timeout: 15000 });
  mark("reschedule_session", true, newDate);

  // Segunda sesión → confirmar → cancelar.
  await page.getByLabel("Fecha local").fill(datePlus(11));
  await page.getByLabel("Hora local").fill("11:00");
  await page.getByRole("button", { name: "Programar sesión" }).click();
  await page.getByText("Sesión programada").waitFor({ timeout: 15000 });
  await clickExact("Confirmar");
  await page.getByRole("button", { name: "Cancelar", exact: true }).first().click();
  await page.getByText("Sesión cancelada").waitFor({ timeout: 15000 });
  mark("cancel_session", true, "ocupación liberada");

  const history = await page.locator("body").innerText();
  mark("history_visible", history.includes("session.") || history.includes("CREATED") || history.includes("CONFIRMED"), "eventos en Historial");
  await page.screenshot({ path: `${SHOT}/g02_journey_owner_sessions.png`, fullPage: true });

  await page.goto(`${BASE}/cursos/publicos?business=qa-b1-key`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1000);
  const pub = await page.locator("body").innerText();
  mark("public_discovery", pub.includes(title), `curso publicado visible=${pub.includes(title)}`);

  const [db] = await sql`select status from courses.courses where id=${course.id}`;
  const sessions = await sql`select status::text from courses.course_sessions where course_id=${course.id}`;
  mark("db_oracle", db.status === "PUBLISHED" && sessions.length === 2, JSON.stringify({ course: db.status, sessions: sessions.map((s) => s.status) }));
} catch (e) { result.fatal = e.message; } finally {
  result.finishedAt = new Date().toISOString();
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2), "utf8");
  await sql.end(); await browser.close();
  console.log(JSON.stringify({ fatal: result.fatal ?? null, steps: result.steps, out: OUT }, null, 2));
}
