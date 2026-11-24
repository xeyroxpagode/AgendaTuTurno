import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium, expect } from "@playwright/test";

const base = process.env.E2E_WEB_BASE ?? "http://localhost:3101";
const out = process.env.G02_OUT;
const viewports = [[320, 640], [390, 844], [410, 844], [430, 932], [768, 1024], [1024, 768], [1440, 900]];
const browser = await chromium.launch();
const outcomes = [];
for (const [width, height] of viewports) {
  const page = await browser.newPage({ viewport: { width, height }, reducedMotion: "reduce", locale: "es-AR" });
  const steps = [];
  try {
    await page.goto(base + "/login");
    await page.getByLabel("Correo").pressSequentially("owner-qa@youngkingz.local");
    await page.getByLabel("Contraseña").pressSequentially(process.env.G02_QA_PASSWORD);
    await page.getByRole("button", { name: "Ingresar" }).click();
    await page.waitForURL(/\/team|\/account/);
    steps.push("login");
    await page.goto(base + "/cursos");
    await page.getByRole("link", { name: "Agenda", exact: true }).waitFor({ timeout: 15000 });
    const title = page.getByLabel("Título del curso");
    await title.focus();
    await page.keyboard.type("QA teclado");
    await expect(title).toHaveValue("QA teclado");
    await page.keyboard.press("Tab");
    await expect(page.getByLabel("Resumen público")).toBeFocused();
    await page.getByLabel("Medio de contacto").selectOption("EMAIL");
    await expect(page.getByLabel("Dato de contacto público")).toBeVisible();
    const dimensions = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      document: document.documentElement.scrollWidth,
      reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
    }));
    assert.equal(dimensions.reducedMotion, true);
    steps.push("course form, keyboard focus, reduced motion");
    await page.screenshot({ path: path.join(out, "08_SCREENSHOTS", `courses-${width}.png`), fullPage: false });
    await page.getByRole("link", { name: "Agenda", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Agenda" })).toBeVisible();
    await page.getByRole("button", { name: "Día siguiente" }).click();
    await page.getByRole("button", { name: "Crear turno", exact: true }).first().click();
    await expect(page.getByRole("button", { name: "Cerrar", exact: true }).first()).toBeVisible();
    await page.screenshot({ path: path.join(out, "08_SCREENSHOTS", `agenda-${width}.png`), fullPage: false });
    const agendaWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    const overflow = dimensions.document > dimensions.viewport || agendaWidth > width;
    if (overflow) throw new Error(`Desborde horizontal: cursos ${dimensions.document}px, Agenda ${agendaWidth}px`);
    steps.push("Agenda date and staff booking form");
    await page.getByRole("link", { name: "Equipo", exact: true }).click();
    await page.getByRole("button", { name: "Incorporar integrante" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    steps.push("Equipo dialog opened and dismissed by keyboard");
    await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
    const zoomWidth = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth }));
    if (zoomWidth.scroll > zoomWidth.viewport) throw new Error(`Desborde con texto 200%: ${zoomWidth.scroll}px`);
    outcomes.push({ width, height, status: "PASS", steps: [...steps, "200% text zoom"] });
  } catch (error) {
    outcomes.push({ width, height, status: "FAIL", steps, error: error.message });
    await page.screenshot({ path: path.join(out, "08_SCREENSHOTS", `responsive-failure-${width}.png`), fullPage: false });
  } finally {
    await page.close();
  }
}
await browser.close();
fs.writeFileSync(path.join(out, "01_BROWSER", "responsive-recovery.json"), JSON.stringify(outcomes, null, 2));
if (outcomes.some((item) => item.status === "FAIL")) process.exitCode = 1;
